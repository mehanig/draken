require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getDb, closeDb } = require('../dist/db/schema');
const { scanSessions } = require('../dist/sync/collector');
const store = require('../dist/sync/store');
const { SummaryTree, summaryPreparationKey } = require('../dist/sync/tree');
const { sourceKey } = require('../dist/sync/normalize');
const { generateReply } = require('../dist/sync/manager');
const { LUNA_BATCH } = require('../dist/sync/summary-budget');
const { records, output, caches } = require('./fixtures/summary-cache.cjs');
const LUNA = 'openai/gpt-6-luna', FINAL = 'test/final';
const protectedTables = ['syncs', 'sync_items', 'sync_runs', 'sync_tree_nodes', 'sync_coverage', 'sync_messages'];
let temp, root, controlPath, logPath;

beforeEach(() => {
  closeDb();
  temp = fs.mkdtempSync(path.join(__dirname, '..', '.background-tree-'));
  root = path.join(temp, 'sessions'); fs.mkdirSync(root);
  const fake = path.join(temp, 'pi');
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-pi.cjs'), fake); fs.chmodSync(fake, 0o700);
  controlPath = path.join(temp, 'control.json'); logPath = path.join(temp, 'calls.jsonl');
  fs.writeFileSync(controlPath, '{}');
  Object.assign(process.env, { DRAKEN_DATA_DIR: path.join(temp, 'state'), DRAKEN_PI_SESSIONS_DIR: root,
    DRAKEN_PI_BIN: fake, DRAKEN_PI_SUMMARY_MODEL: LUNA, DRAKEN_PI_FINAL_MODEL: FINAL,
    DRAKEN_FAKE_CONTROL: controlPath, DRAKEN_TEST_CALL_LOG: logPath });
  delete process.env.DRAKEN_PI_TIMEOUT_MS; delete process.env.DRAKEN_PI_MAX_INVOCATIONS;
});
afterEach(() => { closeDb(); fs.rmSync(temp, { recursive: true, force: true }); });
const control = value => fs.writeFileSync(controlPath, JSON.stringify(value));
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function session(count, { workspace = '/synthetic/background', width = 900 } = {}) {
  const id = randomUUID(), file = path.join(root, id + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, cwd: workspace, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
  const data = { id, file, count: 0, width }; append(data, count); return data;
}
function append(data, count) {
  for (let n = data.count; n < data.count + count; n++) fs.appendFileSync(data.file, JSON.stringify({
    type: 'message', id: `${data.id}-${n}`, parentId: n ? `${data.id}-${n - 1}` : null,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    message: { role: n ? 'assistant' : 'user', content: [{ type: 'text', text: `Outcome ${n}; deployment NOT checked. raw-source-sentinel ${'x'.repeat(data.width)}` }] },
  }) + '\n');
  data.count += count;
}
async function input() { await scanSessions(); return store.previewSummaryInput(); }
function preparation(value, controller = new AbortController()) {
  const id = Number(getDb().prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,input_key,source_keys_json)
    VALUES (?,?,?,?,?,?,?)`).run(value.models.summary, value.models.final, value.models.max_invocations, value.items.length,
    new Date().toISOString(), summaryPreparationKey(value), JSON.stringify(value.items.map(sourceKey))).lastInsertRowid);
  return { id, controller, tree: SummaryTree.forBackground(value, id, controller.signal),
    row: () => getDb().prepare('SELECT * FROM background_runs WHERE id=?').get(id) };
}
function untouched(count) {
  for (const table of protectedTables) assert.equal(getDb().prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
  assert.equal(store.pendingCount(), count);
}
function prohibitSyncWrites(enabled) {
  for (const table of protectedTables) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const name = `test_background_${table}_${operation}`;
    getDb().exec(enabled ? `CREATE TEMP TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'background touched ${table}'); END`
      : `DROP TRIGGER ${name}`);
  }
}
async function waitFor(predicate) {
  for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Timed out waiting for synthetic provider');
}

for (const model of [LUNA, 'test/cheap']) test(`${model}: background builds reusable roots without any sync, then explicit sync only calls final`, async () => {
  session(150, { workspace: '/synthetic/a' }); session(150, { workspace: '/synthetic/b' });
  const value = await input(); value.models.summary = model;
  assert.equal(Object.hasOwn(value, 'id'), false);
  untouched(300); prohibitSyncWrites(true);
  const job = preparation(value), roots = await job.tree.build(), row = job.row();
  assert.ok(roots.length); assert.equal(row.processed_entries, 300); assert.equal(row.stage, 'Summaries prepared');
  // Completion receipts belong to the scheduler, not to SummaryTree.
  assert.equal(row.status, 'running'); assert.equal(row.completed_at, null);
  assert.equal(row.invocations, calls().length); assert.ok(calls().every(call => call.model === model && call.task !== 'final_verdict'));
  const metrics = JSON.parse(row.metrics_json);
  assert.ok(metrics.length && metrics.every(metric => metric.status === 'completed' && metric.accounting?.complete));
  assert.doesNotMatch(row.metrics_json, /raw-source-sentinel|\/synthetic\/|deployment NOT checked/);
  await assert.rejects(job.tree.call({ task: 'final_verdict' }, 'Forbidden', true), /Background.*final provider/);
  assert.equal(job.row().invocations, row.invocations); untouched(300);
  prohibitSyncWrites(false);
  const sync = store.startSync(); store.configureModels(sync.id, { ...value.models, max_invocations: 1 });
  const before = calls().length, result = await generateReply(sync.id);
  assert.equal(calls().length - before, 1); assert.equal(calls().at(-1).task, 'final_verdict');
  assert.ok(result.tree.complete); assert.ok(result.tree.run.cache_hits > 0); assert.equal(result.tree.run.processed_entries, 300);
  assert.equal(store.pendingCount(), 300); assert.equal(getDb().prepare('SELECT count(*) n FROM sync_coverage').get().n, 0);
});

test('ordinary large batches reuse closed leaves when an unreserved history tail grows', async () => {
  const data = session(1305), first = await input(), job = preparation(first);
  await job.tree.build(); const before = calls().length, leaves = calls().filter(call => call.stage === 'chunk');
  assert.ok(leaves.length > 1); untouched(1305);
  append(data, 3); const next = await input(); assert.notEqual(summaryPreparationKey(next), summaryPreparationKey(first));
  const second = preparation(next); await second.tree.build();
  const newLeaves = calls().slice(before).filter(call => call.stage === 'chunk');
  assert.equal(newLeaves.length, 1); assert.ok(second.row().cache_hits >= leaves.length - 1);
  assert.equal(second.row().processed_entries, 1308); untouched(1308);
});

test('oversized recursively split batches retain every closed prefix, in background and foreground', async () => {
  // Exercise the complete-wire fallback repeatedly without megabytes of fixture data.
  // Only the planner threshold is reduced; real tokenization, validation, SQLite,
  // provider transport and cache keys remain in use.
  const original = LUNA_BATCH.plannedRequestTokens;
  LUNA_BATCH.plannedRequestTokens = 14000;
  try {
    const data = session(170, { width: 1200 }), first = await input(), job = preparation(first);
    const firstSpecs = job.tree.batchSpecs(); assert.ok(firstSpecs.length >= 3, 'force repeated wire-budget splitting');
    await job.tree.build(); const before = calls().length;
    append(data, 17); const next = await input(), second = preparation(next), nextSpecs = second.tree.batchSpecs();
    assert.deepEqual(nextSpecs.slice(0, firstSpecs.length - 1).map(spec => spec.key), firstSpecs.slice(0, -1).map(spec => spec.key));
    await second.tree.build();
    const newLeaves = calls().slice(before).filter(call => call.stage === 'chunk');
    const oldClosedSources = firstSpecs.slice(0, -1).reduce((n, spec) => n + spec.sources.length, 0);
    assert.equal(newLeaves.reduce((n, call) => n + call.input.evidence.length, 0), next.items.length - oldClosedSources);
    untouched(187);
    const sync = store.startSync(), foreground = new SummaryTree(sync, 0, new AbortController().signal);
    assert.deepEqual(foreground.batchSpecs().map(spec => spec.key), nextSpecs.map(spec => spec.key));
    store.configureModels(sync.id, { ...sync.models, max_invocations: 1 });
    const finalBefore = calls().length; await generateReply(sync.id);
    assert.equal(calls().length - finalBefore, 1); assert.equal(calls().at(-1).task, 'final_verdict');
  } finally { LUNA_BATCH.plannedRequestTokens = original; }
});

test('receipt keys cover content, provenance, context, every model setting and recipe budgets, but not E/C transport labels', async () => {
  session(3); const value = await input(); value.context = [{ ...value.items[0], ref: 'C1', text: 'Earlier qualified context' }];
  const key = summaryPreparationKey(value); assert.match(key, /^[a-f0-9]{64}$/);
  const renamed = structuredClone(value); renamed.items.forEach((item, n) => item.ref = `E${900 + n}`); renamed.context[0].ref = 'C999';
  renamed.models = { max_invocations: value.models.max_invocations, final: value.models.final, summary: value.models.summary };
  assert.equal(summaryPreparationKey(renamed), key);
  for (const mutate of [
    v => v.items[0].text += ' correction', v => v.items[0].role = 'toolResult', v => v.items[0].sequence++,
    v => v.items[0].session_id += '-different', v => v.context[0].text += ' correction', v => v.context = [],
    v => v.models.summary = 'test/other', v => v.models.final = 'test/other', v => v.models.max_invocations++,
  ]) { const changed = structuredClone(value); mutate(changed); assert.notEqual(summaryPreparationKey(changed), key); }
  const budget = LUNA_BATCH.rootTokens;
  try { LUNA_BATCH.rootTokens--; assert.notEqual(summaryPreparationKey(value), key); }
  finally { LUNA_BATCH.rootTokens = budget; }
  untouched(3); assert.equal(getDb().prepare('SELECT count(*) n FROM background_runs').get().n, 0);
});

test('content/context/summary-model edits recompute leaves; changing only final model invalidates receipt but reuses summaries', async () => {
  session(3); const value = await input(); value.context = [{ ...value.items[0], ref: 'C1', text: 'Earlier context' }];
  await preparation(value).tree.build();
  for (const mutate of [v => v.items[0].text += ' changed', v => v.context[0].text += ' changed', v => v.models.summary = 'test/other']) {
    const changed = structuredClone(value); mutate(changed); const before = calls().length;
    const job = preparation(changed); await job.tree.build();
    assert.ok(calls().slice(before).some(call => call.stage === 'chunk')); assert.equal(job.row().processed_entries, 3);
  }
  const changed = structuredClone(value); changed.models.final = 'test/other';
  const before = calls().length; const job = preparation(changed); await job.tree.build();
  assert.equal(calls().length, before); assert.ok(job.row().cache_hits); untouched(3);
});

for (const cache of caches) test(`background honors frozen ${cache.version} compatible leaf caches`, async () => {
  fs.writeFileSync(path.join(root, 'source.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  const value = await input(); value.models.summary = cache.model;
  getDb().prepare('INSERT INTO summary_cache(key,kind,model,prompt_version,output_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(cache.key, 'chunk', cache.model, cache.version, JSON.stringify(output), '2026-01-02T00:00:00.000Z');
  const job = preparation(value); await job.tree.build();
  assert.equal(calls().filter(call => call.stage === 'chunk').length, 0); assert.ok(job.row().cache_hits >= 1); untouched(2);
});

test('corrupt leaves are rejected/recomputed, never counted as successfully prepared after invalid output', async () => {
  session(3); const value = await input(), first = preparation(value); await first.tree.build();
  getDb().prepare("UPDATE summary_cache SET output_json=? WHERE kind='chunk'").run(JSON.stringify({ observations: [{ topic: 'Bad', state: 'validated', summary: 'Bad cache', evidence: ['K-unknown'] }], limitations: [] }));
  control({ invalidSources: true }); const second = preparation(value), before = calls().length;
  await assert.rejects(second.tree.build(), /unknown source/);
  assert.equal(calls().length - before, 2); assert.equal(second.row().processed_entries, 0); assert.equal(second.row().cache_hits, 0);
  assert.notEqual(second.row().stage, 'Summaries prepared'); assert.equal(second.row().completed_at, null);
  assert.equal(getDb().prepare("SELECT count(*) n FROM summary_cache WHERE kind='chunk'").get().n, 0);
  control({}); const retry = preparation(value); await retry.tree.build(); assert.equal(retry.row().processed_entries, 3); untouched(3);
});

test('failed reconciliation and failed compaction preserve leaves but cannot report prepared roots', async () => {
  session(3, { workspace: '/synthetic/a' }); session(3, { workspace: '/synthetic/b' });
  const value = await input(); control({ failStage: 'overview' }); const job = preparation(value);
  await assert.rejects(job.tree.build(), /provider unavailable/);
  assert.equal(job.row().processed_entries, 6); assert.notEqual(job.row().stage, 'Summaries prepared');
  const before = calls().length; control({}); await preparation(value).tree.build();
  assert.equal(calls().slice(before).filter(call => call.stage === 'chunk').length, 0); untouched(6);
  getDb().exec('DELETE FROM summary_cache');
  // A dense leaf requires an extra compact_for_final pass even with one root.
  session(120, { workspace: '/synthetic/dense' }); const dense = await input();
  dense.items = dense.items.filter(item => item.cwd === '/synthetic/dense');
  control({ denseOutput: true }); const compact = preparation(dense);
  await assert.rejects(compact.tree.build(), /compact final budget/i);
  assert.equal(compact.row().processed_entries, 120); assert.notEqual(compact.row().stage, 'Summaries prepared');
  const compactBefore = calls().length; control({ compactOutput: true }); const retry = preparation(dense); await retry.tree.build();
  assert.equal(calls().slice(compactBefore).filter(call => call.stage === 'chunk').length, 0);
  assert.ok(calls().slice(compactBefore).some(call => call.stage === 'overview'));
  assert.equal(retry.row().stage, 'Summaries prepared'); assert.ok(calls().every(call => call.task !== 'final_verdict')); untouched(126);
});

test('background spends its full atomic quota without reserving a final call, and concurrent claims cannot exceed it', async () => {
  session(3); const value = await input(); value.models.max_invocations = 1;
  const job = preparation(value); await job.tree.build(); assert.equal(job.row().invocations, 1);
  const race = preparation(value), request = { task: 'summarize', stage: 'chunk', input: { evidence: [{ id: 'S1', workspace: 'Demo', text: 'Synthetic test' }] }, allowed_source_ids: ['S1'] };
  const outcomes = await Promise.allSettled([race.tree.call(request, 'Synthetic'), race.tree.call(request, 'Synthetic')]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(result => result.status === 'rejected').reason.message, /Invocation budget/);
  assert.equal(race.row().invocations, 1); assert.equal(JSON.parse(race.row().metrics_json).length, 1); untouched(3);
});

test('cancellation during a provider call keeps completed leaves but never admits the cancelled output', async () => {
  session(3, { workspace: '/synthetic/a' }); session(3, { workspace: '/synthetic/b' });
  const value = await input(); control({ delay: 200 }); const job = preparation(value), pending = job.tree.build();
  const failure = assert.rejects(pending, /cancelled/);
  await waitFor(() => job.row().processed_entries === 3 && calls().length === 2);
  job.controller.abort(); await failure;
  assert.equal(job.row().processed_entries, 3); assert.notEqual(job.row().stage, 'Summaries prepared'); assert.equal(job.row().completed_at, null);
  assert.ok(JSON.parse(job.row().metrics_json).some(metric => metric.status === 'cancelled'));
  assert.equal(getDb().prepare("SELECT count(*) n FROM summary_cache WHERE kind='chunk'").get().n, 1);
  control({}); const retry = preparation(value); await retry.tree.build(); assert.ok(retry.row().cache_hits >= 1);
  const before = calls().length, aborted = new AbortController(); aborted.abort(); const cached = preparation(value, aborted);
  await assert.rejects(cached.tree.build(), /cancelled/); assert.equal(cached.row().processed_entries, 0); assert.equal(cached.row().cache_hits, 0);
  assert.equal(calls().length, before); untouched(6);
});

test('missing foreground IDs and unavailable originals fail closed before model invocation', async () => {
  session(3); const value = await input();
  assert.throws(() => new SummaryTree(value, 1, new AbortController().signal), /requires a sync ID/);
  const unavailable = structuredClone(value); unavailable.context = [{ ...value.items[0], unavailable: 'missing original' }];
  assert.throws(() => SummaryTree.forBackground(unavailable, 1, new AbortController().signal), /Original session evidence/);
  const duplicate = structuredClone(value); duplicate.items.push(duplicate.items[0]);
  assert.throws(() => SummaryTree.forBackground(duplicate, 1, new AbortController().signal), /Duplicate canonical/);
  assert.equal(calls().length, 0); untouched(3);
});
