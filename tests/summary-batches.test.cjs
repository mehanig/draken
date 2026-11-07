require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getDb, closeDb } = require('../dist/db/schema');
const { scanSessions } = require('../dist/sync/collector');
const store = require('../dist/sync/store');
const { SummaryTree } = require('../dist/sync/tree');
const { generateReply, cancelReply } = require('../dist/sync/manager');
const { invokePi } = require('../dist/sync/pi');
const { LUNA_BATCH, summaryTokens, promptTokens } = require('../dist/sync/summary-budget');
const LUNA = 'openai/gpt-6-luna', ASTRA = 'openai/gpt-6-astra';
let temp, root, controlPath, logPath;
beforeEach(() => {
  closeDb(); temp = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-batches-')); root = path.join(temp, 'sessions'); fs.mkdirSync(root);
  const fake = path.join(temp, 'pi'); fs.copyFileSync(path.join(__dirname, 'fixtures/fake-pi.cjs'), fake); fs.chmodSync(fake, 0o700);
  controlPath = path.join(temp, 'control.json'); logPath = path.join(temp, 'calls.jsonl'); fs.writeFileSync(controlPath, '{}');
  Object.assign(process.env, { DRAKEN_DATA_DIR: path.join(temp, 'state'), DRAKEN_PI_SESSIONS_DIR: root, DRAKEN_PI_BIN: fake,
    DRAKEN_PI_SUMMARY_MODEL: LUNA, DRAKEN_PI_FINAL_MODEL: ASTRA, DRAKEN_FAKE_CONTROL: controlPath, DRAKEN_TEST_CALL_LOG: logPath });
  delete process.env.DRAKEN_PI_TIMEOUT_MS; delete process.env.DRAKEN_PI_MAX_INVOCATIONS;
});
afterEach(() => { closeDb(); fs.rmSync(temp, { recursive: true, force: true }); });
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const control = value => fs.writeFileSync(controlPath, JSON.stringify(value));
function session(count, { workspace = '/synthetic/work', width = 900, text, skew = false } = {}) {
  const id = randomUUID(), file = path.join(root, id + '.jsonl');
  const rows = Array.from({ length: count }, (_, n) => ({ type: 'message', id: `${id}-${n}`, parentId: n ? `${id}-${n - 1}` : null,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, skew && n === count - 1 ? -1 : n)).toISOString(),
    message: { role: n ? 'assistant' : 'user', content: [{ type: 'text', text: text ? text(n) : n === count - 1
      ? 'LATEST OUTCOME: tests passed; deployment was NOT checked.' : `Earlier plan ${n}; do-not-log-this-source-sentinel. ${'x'.repeat(width)}` }] } }));
  const header = { type: 'session', version: 3, id, cwd: workspace, timestamp: '2026-01-01T00:00:00.000Z' };
  fs.writeFileSync(file, [header, ...rows].map(JSON.stringify).join('\n') + '\n'); return { id, file, rows };
}
async function start() { await scanSessions(); return store.startSync(); }
function unchanged(sync, count) {
  assert.equal(store.pendingCount(), count);
  assert.equal(getDb().prepare('SELECT count(*) n FROM sync_coverage').get().n, 0);
  const current = store.getSync(sync.id); assert.equal(current.status, 'open'); assert.equal(current.decisions, sync.decisions); assert.equal(current.carry_forward, sync.carry_forward);
}
function seedOld(spec) {
  const last = spec.payload.evidence.at(-1);
  const summary = { observations: [{ topic: last.workspace, state: 'reported_done', summary: last.text.slice(0, 800), evidence: [last.id] }], limitations: [] };
  getDb().prepare('INSERT INTO summary_cache(key,kind,model,prompt_version,output_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(spec.key, 'chunk', LUNA, 'sync-tree-v2-short-labels', JSON.stringify(summary), new Date().toISOString());
}

test('Luna uses larger complete batches and one global reconciliation, not session/routing/topic passes', async t => {
  session(1305); const sync = await start();
  const conservativeLeaves = [...new SummaryTree(sync, 0, new AbortController().signal).chunkSpecs(false).values()].flat().length;
  const result = await generateReply(sync.id), recorded = calls(), leaves = recorded.filter(call => call.stage === 'chunk');
  assert.equal(result.tree.run.processed_entries, 1305); assert.match(result.briefing, /LATEST OUTCOME/); assert.doesNotMatch(result.briefing, /Earlier plan/);
  assert.equal(leaves.reduce((sum, call) => sum + call.input.evidence.length, 0), 1305);
  assert.ok(leaves.some(call => call.input.evidence.length > 100)); assert.ok(leaves.some(call => call.input_characters > 300000));
  assert.ok(leaves.length < conservativeLeaves / 3);
  assert.equal(new Set(leaves.flatMap(call => call.input.evidence.map(item => `${call.input.session}:${item.sequence}`))).size, 1305);
  assert.equal(recorded.filter(call => call.stage === 'overview').length, 1);
  assert.ok(!recorded.some(call => ['session', 'topics', 'topic'].includes(call.stage)));
  assert.ok(recorded.filter(call => call.task !== 'final_verdict').every(call => call.model === LUNA)); assert.equal(recorded.filter(call => call.model === ASTRA).length, 1);
  for (const call of leaves) {
    assert.ok(call.input_bytes <= LUNA_BATCH.inputBytes);
    const payload = { task: 'summarize', stage: 'chunk', allowed_source_ids: call.allowed_source_ids, input: call.input };
    assert.ok(promptTokens(JSON.stringify(payload), call.system) <= LUNA_BATCH.plannedRequestTokens);
    assert.match(call.system, /96 observations/); assert.match(call.system, /60000 UTF-8 bytes/);
  }
  const final = recorded.at(-1); assert.equal(final.snapshot.processed_entries, 1305);
  assert.ok(final.verification_evidence.length > 0); assert.ok(final.input_characters < 100000);
  const merge = recorded.find(call => call.stage === 'overview');
  assert.ok(merge.input.children.every(child => child.summary.observations.every(obs => obs.source_positions.length === obs.evidence.length)));
  const metrics = result.tree.run.metrics; assert.equal(metrics.length, recorded.length);
  assert.equal(metrics.filter(call => call.stage === 'chunk').length, leaves.length);
  assert.equal(metrics.filter(call => call.stage === 'overview').length, 1);
  assert.ok(metrics.every(call => call.elapsed_ms >= 0 && call.input_tokens_estimate > 0 && call.output_tokens_estimate > 0));
  assert.doesNotMatch(JSON.stringify(metrics), /do-not-log-this-source-sentinel|Earlier plan|\/synthetic\/work/);
  unchanged(sync, 1305);
  t.diagnostic(JSON.stringify({ syntheticEntries: 1305, oldLeafPlan: conservativeLeaves, newLeaves: leaves.length, cheapCalls: recorded.length - 1, finalCalls: 1, providerBenchmark: false }));
});

test('large-batch outputs retain more than 24 distinct qualified facts and original-evidence closure', async () => {
  control({ knownFacts: true });
  session(400, { text: n => n % 10 ? `Routine synthetic work ${n}` : 'SYNTHETIC_FACT: ' + JSON.stringify({ topic: `Project ${n / 10}`, state: 'blocked',
    summary: `Checkpoint ${n / 10}: test plan exists, but tests were NOT run and deployment remains unverified.` }) });
  const sync = await start(), result = await generateReply(sync.id);
  for (let n = 0; n < 40; n++) assert.match(result.briefing, new RegExp(`Checkpoint ${n}:`));
  assert.equal(calls().filter(call => call.stage === 'chunk').length, 1);
  const final = calls().at(-1), refs = new Set(final.verification_evidence.map(item => item.ref));
  assert.equal(final.summary_tree[0].observations.length, 40);
  for (const observation of final.summary_tree[0].observations) {
    assert.equal(observation.state, 'blocked'); assert.match(observation.summary, /NOT run.*unverified/);
    for (const ref of observation.evidence) assert.ok(refs.has(ref));
  }
  unchanged(sync, 400);
});

test('persisted order, roles and negative qualifications survive a skewed-clock batch', async () => {
  session(450, { skew: true }); const sync = await start(), result = await generateReply(sync.id);
  assert.match(result.briefing, /deployment was NOT checked/);
  const leaf = calls().filter(call => call.stage === 'chunk').at(-1); assert.match(leaf.input.evidence.at(-1).text, /LATEST OUTCOME/);
  const position = calls().at(-1).verification_evidence[0];
  assert.equal(position.sequence, sync.items.find(item => item.text.startsWith('LATEST OUTCOME')).sequence); assert.equal(position.role, 'assistant'); assert.equal(position.background, false);
});

test('validated v2 leaf cache islands are reused; only the uncached gap is repacked', async () => {
  session(240); const sync = await start(), old = [...new SummaryTree(sync, 0, new AbortController().signal).chunkSpecs(false).values()].flat();
  assert.ok(old.length >= 4); seedOld(old[0]); seedOld(old.at(-1));
  const original = getDb().prepare('SELECT key,output_json FROM summary_cache ORDER BY key').all();
  const result = await generateReply(sync.id), leaves = calls().filter(call => call.stage === 'chunk');
  assert.equal(leaves.length, 1); assert.equal(result.tree.run.cache_hits, 2);
  assert.equal(leaves[0].input.evidence.length, 240 - old[0].sources.length - old.at(-1).sources.length);
  assert.equal(result.tree.nodes.filter(node => node.kind === 'chunk').reduce((sum, node) => sum + node.source_count, 0), 240);
  for (const row of original) assert.equal(getDb().prepare('SELECT output_json FROM summary_cache WHERE key=?').get(row.key).output_json, row.output_json);
  unchanged(sync, 240);
});

test('new caches survive reference renumbering and allow a final-only one-call budget', async () => {
  session(600); const first = await start(); await generateReply(first.id); const count = calls().length;
  store.discardSync(first.id); const second = store.startSync();
  for (const item of second.items) { item.ref = `E${10000 + Number(item.ref.slice(1))}`; getDb().prepare('UPDATE sync_items SET evidence_json=? WHERE sync_id=? AND event_key=?').run(JSON.stringify(item), second.id, item.event_key); }
  store.configureModels(second.id, { ...second.models, max_invocations: 1 });
  const result = await generateReply(second.id);
  assert.equal(calls().length - count, 1); assert.equal(calls().at(-1).model, ASTRA); assert.ok(result.tree.run.cache_hits);
  assert.match(result.briefing, /\[E10\d+\]/); unchanged(second, 600);
});

test('appending source history reuses closed large batches and changes only the tail', async () => {
  const data = session(1305); const first = await start(); await generateReply(first.id);
  const firstLeaves = calls().filter(call => call.stage === 'chunk').length; assert.ok(firstLeaves > 1);
  store.discardSync(first.id); const count = calls().length;
  const n = data.rows.length;
  fs.appendFileSync(data.file, JSON.stringify({ type: 'message', id: `${data.id}-${n}`, parentId: `${data.id}-${n - 1}`, timestamp: '2026-01-02T00:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'NEW TAIL: deployment still NOT checked.' }] } }) + '\n');
  const second = await start(), result = await generateReply(second.id);
  assert.equal(calls().slice(count).filter(call => call.stage === 'chunk').length, 1); assert.ok(result.tree.run.cache_hits >= firstLeaves - 1);
  assert.match(result.briefing, /NEW TAIL/); unchanged(second, 1306);
});

test('failed global reconciliation keeps all completed leaves and never calls Astra early', async () => {
  session(3, { workspace: '/synthetic/a' }); session(3, { workspace: '/synthetic/b' }); const sync = await start(); control({ failStage: 'overview' });
  await assert.rejects(generateReply(sync.id), /provider unavailable/); assert.equal(store.getProgress(sync.id).run.processed_entries, 6);
  assert.equal(calls().filter(call => call.model === ASTRA).length, 0); assert.throws(() => store.completeSync(sync.id, '', '', true), /incomplete/);
  const count = calls().length; control({}); const result = await generateReply(sync.id);
  assert.equal(calls().slice(count).filter(call => call.stage === 'chunk').length, 0); assert.equal(result.tree.run.cache_hits, 2); unchanged(sync, 6);
});

test('large-batch citation repair still changes only overfull reference lists and counts against the budget', async () => {
  session(120); const sync = await start(); control({ tooManySources: true }); const result = await generateReply(sync.id);
  const recorded = calls(), repair = recorded.find(call => call.task === 'repair_summary_citations');
  assert.ok(repair); assert.equal(repair.model, LUNA); assert.equal(Object.hasOwn(repair.repair, 'previous_output'), false);
  assert.match(result.briefing, /LATEST OUTCOME.*deployment was NOT checked/);
  assert.equal(result.tree.run.metrics.filter(call => call.task === 'repair_summary_citations' && call.repair).length, 1); unchanged(sync, 120);
});

test('invalid references stop after one repair without cached or reviewed success', async () => {
  session(120); const sync = await start(); control({ invalidSources: true });
  await assert.rejects(generateReply(sync.id), /unknown source/); assert.equal(calls().length, 2);
  assert.equal(getDb().prepare('SELECT count(*) n FROM summary_cache').get().n, 0); assert.equal(store.getProgress(sync.id).run.processed_entries, 0); unchanged(sync, 120);
});

test('invocation ceiling reserves the verdict and resumes with already cached batches', async () => {
  session(3, { workspace: '/synthetic/a' }); session(3, { workspace: '/synthetic/b' }); const sync = await start();
  store.configureModels(sync.id, { ...sync.models, max_invocations: 3 }); await assert.rejects(generateReply(sync.id), /Invocation budget reached/);
  assert.equal(calls().length, 2); assert.equal(store.getProgress(sync.id).run.processed_entries, 6);
  store.configureModels(sync.id, { ...sync.models, max_invocations: 4 }); assert.equal((await generateReply(sync.id)).tree.run.cache_hits, 2); unchanged(sync, 6);
});

test('Stop cancels an active large-batch request, preserves earlier cache and records no source content in metrics', async () => {
  session(3, { workspace: '/synthetic/a' }); session(3, { workspace: '/synthetic/b' }); const sync = await start(); control({ delay: 250 });
  const pending = generateReply(sync.id); const failure = assert.rejects(pending, /cancelled/);
  for (let n = 0; n < 200 && store.getProgress(sync.id).run.processed_entries < 3; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.getProgress(sync.id).run.processed_entries, 3); cancelReply(sync.id); await failure;
  const stopped = store.getProgress(sync.id).run; assert.equal(stopped.status, 'cancelled'); assert.ok(stopped.metrics.some(call => call.status === 'cancelled'));
  assert.equal(calls().filter(call => call.model === ASTRA).length, 0); control({}); const result = await generateReply(sync.id); assert.ok(result.tree.run.cache_hits >= 1); unchanged(sync, 6);
});

test('an irreducibly dense result stops after one extra compaction instead of looping or enlarging Astra input', async () => {
  session(120); const sync = await start(); control({ denseOutput: true });
  await assert.rejects(generateReply(sync.id), /compact final budget/i);
  assert.equal(calls().length, 3, 'one compaction node plus one bounded repair'); assert.equal(calls().filter(call => call.model === ASTRA).length, 0);
  assert.equal(store.getProgress(sync.id).run.processed_entries, 120); assert.equal(getDb().prepare('SELECT count(*) n FROM summary_cache').get().n, 1);
  const count = calls().length; control({ compactOutput: true }); const result = await generateReply(sync.id);
  assert.equal(calls().slice(count).filter(call => call.stage === 'chunk').length, 0, 'raw batches were retained, not thrown away');
  assert.ok(result.tree.complete); unchanged(sync, 120);
});

test('canonical citation expansion has separate cache headroom from wire output', async () => {
  session(120); const sync = await start(); control({ expandedReferences: true });
  await assert.rejects(generateReply(sync.id), /compact final budget/i);
  const leaf = getDb().prepare("SELECT output_json FROM summary_cache WHERE kind='chunk'").get();
  assert.ok(leaf.output_json.length > 64000 && leaf.output_json.length <= 96000);
  assert.ok(store.getProgress(sync.id).run.metrics[0].output_characters < 64000);
  assert.equal(store.getProgress(sync.id).run.processed_entries, 120); unchanged(sync, 120);
});

test('token-bounded planning still admits a complete snapshot beyond 2000 entries', async () => {
  session(2305, { width: 0 }); const sync = await start(), result = await generateReply(sync.id);
  assert.equal(result.tree.run.processed_entries, 2305);
  assert.equal(calls().filter(call => call.stage === 'chunk').reduce((sum, call) => sum + call.input.evidence.length, 0), 2305);
  assert.match(result.briefing, /LATEST OUTCOME/); unchanged(sync, 2305);
});

test('the metrics migration preserves old run metadata and defaults history to an empty array', async () => {
  session(3); const sync = await start();
  const db = getDb(); db.prepare(`INSERT INTO sync_runs(sync_id,status,summary_model,final_model,max_invocations,total_entries,started_at)
    VALUES (?,'completed',?,?,120,3,'2026-01-01T00:00:00.000Z')`).run(sync.id, LUNA, ASTRA);
  // Synthetic legacy schema only, never the production database.
  db.exec('ALTER TABLE sync_runs DROP COLUMN metrics_json'); closeDb();
  const run = store.getProgress(sync.id).run; assert.equal(run.status, 'completed'); assert.equal(run.total_entries, 3); assert.deepEqual(run.metrics, []);
  unchanged(sync, 3);
});

test('an oversized final input is rejected before spending its reserved invocation', async () => {
  session(3); const sync = await start();
  const runId = Number(getDb().prepare(`INSERT INTO sync_runs(sync_id,summary_model,final_model,max_invocations,total_entries,started_at)
    VALUES (?,?,?,120,3,?)`).run(sync.id, LUNA, ASTRA, new Date().toISOString()).lastInsertRowid);
  const tree = new SummaryTree(sync, runId, new AbortController().signal);
  await assert.rejects(tree.call({ task: 'final_verdict', discussion: ' !?'.repeat(40000) }, 'Read-only synthetic final', true), /compact token budget/);
  assert.equal(calls().length, 0); assert.equal(store.getProgress(sync.id).run.invocations, 0); unchanged(sync, 3);
});

test('token and UTF-8 byte guards include framing and reject before launching oversized requests', async () => {
  assert.ok(summaryTokens('界'.repeat(2000)) > summaryTokens('x'.repeat(2000)) * 2);
  assert.ok(summaryTokens('<|endoftext|> <|im_start|>') > 2, 'special-looking source text is not a control token');
  await assert.rejects(invokePi('x'.repeat(300001), { system: 's', model: ASTRA }), /safety limit/);
  await assert.rejects(invokePi('界'.repeat(510000), { system: 's', model: LUNA, largeSummary: true }), /safety limit/);
  await assert.rejects(invokePi(' !?'.repeat(130000), { system: 's', model: LUNA, largeSummary: true }), /token safety budget/);
  await assert.rejects(invokePi('small', { system: 's', model: ASTRA, largeSummary: true }), /configured Luna/);
  assert.equal(calls().length, 0);
  control({ hugeOutput: true });
  await assert.rejects(invokePi('{"task":"sync_recap"}', { system: 's', model: LUNA, largeSummary: true }), /too much output/);
});
