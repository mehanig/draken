const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getDb, closeDb } = require('../dist/db/schema');
const { scanSessions } = require('../dist/sync/collector');
const store = require('../dist/sync/store');
const { generateReply, cancelReply, retrieveEvidence, validateVerdict } = require('../dist/sync/manager');
const { SummaryTree, validateSummary, validateGroups } = require('../dist/sync/tree');
const { prepareModelInput } = require('../dist/sync/references');

let temp, root, controlPath, logPath;
beforeEach(() => {
  closeDb();
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-tree-'));
  root = path.join(temp, 'sessions');
  fs.mkdirSync(root);
  const fake = path.join(temp, 'pi');
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-pi.cjs'), fake);
  fs.chmodSync(fake, 0o700);
  controlPath = path.join(temp, 'control.json');
  logPath = path.join(temp, 'calls.jsonl');
  fs.writeFileSync(controlPath, '{}');
  Object.assign(process.env, {
    DRAKEN_DATA_DIR: path.join(temp, 'state'), DRAKEN_PI_SESSIONS_DIR: root,
    DRAKEN_PI_BIN: fake, DRAKEN_PI_SUMMARY_MODEL: 'test/cheap', DRAKEN_PI_FINAL_MODEL: 'test/strong',
    DRAKEN_FAKE_CONTROL: controlPath, DRAKEN_TEST_CALL_LOG: logPath,
  });
  delete process.env.DRAKEN_PI_TIMEOUT_MS;
  delete process.env.DRAKEN_PI_MAX_INVOCATIONS;
});
afterEach(() => { closeDb(); fs.rmSync(temp, { recursive: true, force: true }); });
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const control = value => fs.writeFileSync(controlPath, JSON.stringify(value));

function session(count, cwd = '/demo/project', textSize = 50) {
  const id = randomUUID();
  const file = path.join(root, `${id}.jsonl`);
  const header = { type: 'session', version: 3, id, cwd, timestamp: '2026-01-01T00:00:00Z' };
  const entries = Array.from({ length: count }, (_, index) => ({
    type: 'message', id: `${id}-${index}`, parentId: index ? `${id}-${index - 1}` : null,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    message: { role: index ? 'assistant' : 'user', content: [{ type: 'text', text: index === count - 1
      ? 'LATEST OUTCOME: implementation delivered and validation recorded, not an unfinished plan.'
      : `Earlier plan ${index}: implementation still pending. ${'x'.repeat(textSize)}` }] },
  }));
  fs.writeFileSync(file, [header, ...entries].map(JSON.stringify).join('\n') + '\n');
  return { id, file, entries };
}

async function begin(count = 3) { session(count); await scanSessions(); return store.startSync(); }

test('a full large-history tree reaches the tail, uses cheap merges and sends only summaries/excerpts to the strong verdict', async () => {
  session(1305, '/demo/project', 900);
  await scanSessions();
  const sync = store.startSync();
  assert.equal(sync.items.length, 1305);
  assert.equal(sync.remaining_count, 0);
  const finished = await generateReply(sync.id);
  assert.equal(finished.tree.run.processed_entries, 1305);
  assert.equal(finished.tree.run.status, 'completed');
  assert.equal(finished.tree.complete, true);
  assert.match(finished.briefing, /LATEST OUTCOME/);
  assert.doesNotMatch(finished.briefing, /Earlier plan/);
  const recorded = calls();
  const leaves = recorded.filter(call => call.stage === 'chunk');
  assert.equal(leaves.reduce((sum, call) => sum + call.input.evidence.length, 0), 1305);
  assert.ok(recorded.some(call => call.stage === 'session'), 'multi-level session reconciliation is required');
  assert.ok(recorded.filter(call => call.task !== 'final_verdict').every(call => call.model === 'test/cheap'));
  assert.equal(recorded.filter(call => call.model === 'test/strong').length, 1);
  const final = recorded.at(-1);
  assert.equal(final.snapshot.processed_entries, 1305);
  assert.equal(final.verification_evidence.length < 100, true);
  assert.equal(store.pendingCount(), 1305, 'processing still does not mark reviewed');
  store.completeSync(sync.id, 'Keep current outcome', '', true);
  assert.equal(store.pendingCount(), 0);
});

test('snapshot selection has no hidden 2000-row query cutoff', async () => {
  session(2105);
  await scanSessions();
  const sync = store.startSync();
  assert.equal(sync.items.length, 2105);
  assert.equal(sync.items.at(-1).text.startsWith('LATEST OUTCOME'), true);
});

test('persisted session order wins over skewed timestamps inside a chunk', async () => {
  const data = session(5);
  const lines = fs.readFileSync(data.file, 'utf8').trim().split('\n').map(JSON.parse);
  lines.at(-1).timestamp = '2025-12-31T23:00:00Z';
  fs.writeFileSync(data.file, lines.map(JSON.stringify).join('\n') + '\n');
  await scanSessions();
  const result = await generateReply(store.startSync().id);
  assert.match(result.briefing, /LATEST OUTCOME/);
  assert.equal(calls().find(call => call.stage === 'chunk').input.evidence.at(-1).text.startsWith('LATEST OUTCOME'), true);
});

test('a merge hitting the invocation ceiling stops, preserves cached leaves, and never makes an over-budget call', async () => {
  session(2, '/demo/a'); session(2, '/demo/b'); await scanSessions();
  const sync = store.startSync();
  store.configureModels(sync.id, { ...sync.models, max_invocations: 3 });
  await assert.rejects(() => generateReply(sync.id), /Invocation budget reached/);
  assert.equal(calls().length, 2, 'one slot remains reserved for the final verdict');
  assert.equal(store.pendingCount(), 4);
  assert.equal(store.getProgress(sync.id).run.processed_entries, 4);
  store.configureModels(sync.id, { ...sync.models, max_invocations: 120 });
  const result = await generateReply(sync.id);
  assert.ok(result.tree.run.cache_hits >= 2);
  assert.equal(result.tree.complete, true);
});

test('cache hits across retries/syncs are source-addressed, not tied to old E references', async () => {
  const first = await begin(120);
  await generateReply(first.id);
  const firstCount = calls().length;
  await generateReply(first.id, 'Explain');
  assert.equal(calls().length - firstCount, 1, 'discussion reuses the entire cheap tree');
  store.discardSync(first.id);
  const second = store.startSync();
  for (const item of second.items) {
    item.ref = `E${10000 + Number(item.ref.slice(1))}`;
    getDb().prepare('UPDATE sync_items SET evidence_json = ? WHERE sync_id = ? AND event_key = ?').run(JSON.stringify(item), second.id, item.event_key);
  }
  const before = calls().length;
  const result = await generateReply(second.id);
  assert.equal(calls().length - before, 1, 'only the stronger verdict is called');
  assert.ok(result.tree.run.cache_hits > 0);
  assert.match(result.briefing, /\[E10\d+\]/);
  assert.doesNotMatch(result.briefing, /\[E\d{1,3}\]/);
});

test('failure after leaf processing preserves the cache and blocks coverage until a successful retry', async () => {
  session(2, '/demo/a'); session(2, '/demo/b');
  await scanSessions();
  const sync = store.startSync();
  control({ failStage: 'topics' });
  await assert.rejects(() => generateReply(sync.id), /provider unavailable/);
  assert.equal(store.getProgress(sync.id).run.processed_entries, 4);
  assert.equal(store.getProgress(sync.id).run.status, 'failed');
  assert.throws(() => store.completeSync(sync.id, '', '', true), /incomplete/);
  assert.equal(store.pendingCount(), 4);
  const before = calls().length;
  control({});
  const retried = await generateReply(sync.id);
  assert.ok(retried.tree.run.cache_hits >= 2);
  assert.equal(calls().slice(before).filter(call => call.stage === 'chunk').length, 0);
  assert.equal(retried.tree.complete, true);
});

test('invented references and incomplete topic partitions are rejected, not cached as valid results', async () => {
  const sync = await begin();
  control({ invalidSources: true });
  await assert.rejects(() => generateReply(sync.id), /unknown source/);
  assert.equal(calls().length, 2, 'one bounded schema-repair attempt');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM summary_cache').get().n, 0);
  assert.equal(store.getProgress(sync.id).run.processed_entries, 0);
  assert.equal(store.pendingCount(), 3);
  assert.throws(() => validateGroups({ groups: [{ topic: 'Work', members: ['one'] }] }, new Set(['one', 'two'])), /omitted/);
  assert.throws(() => validateGroups({ groups: [{ topic: 'Work', members: ['one', 'one'] }] }, new Set(['one', 'two'])), /duplicated/);
  assert.throws(() => validateSummary({ observations: [], limitations: [] }, new Set()), /explain/);
});

test('budget preflight refuses an unaffordable run without making any calls or losing history', async () => {
  session(110, '/demo/a'); session(110, '/demo/b');
  await scanSessions();
  const sync = store.startSync();
  store.configureModels(sync.id, { ...sync.models, max_invocations: 2 });
  await assert.rejects(() => generateReply(sync.id), /At least/);
  assert.equal(calls().length, 0);
  assert.equal(store.pendingCount(), 220);
  store.configureModels(sync.id, { ...sync.models, max_invocations: 120 });
  assert.equal((await generateReply(sync.id)).tree.complete, true);
});

test('cancellation aborts the active cheap model and keeps the snapshot resumable', async () => {
  const sync = await begin();
  control({ delay: 1000 });
  const promise = generateReply(sync.id);
  cancelReply(sync.id);
  await assert.rejects(() => promise, /cancelled/);
  assert.equal(store.getProgress(sync.id).run.status, 'cancelled');
  assert.equal(store.getSync(sync.id).busy, false);
  assert.equal(store.pendingCount(), 3);
  control({});
  assert.equal((await generateReply(sync.id)).tree.complete, true);
});

test('changing the cheap model invalidates its cache but a final-model change does not', async () => {
  const sync = await begin();
  await generateReply(sync.id);
  let before = calls().length;
  store.configureModels(sync.id, { ...sync.models, final: 'test/better' });
  await generateReply(sync.id);
  assert.equal(calls().length - before, 1);
  assert.equal(calls().at(-1).model, 'test/better');
  before = calls().length;
  store.configureModels(sync.id, { ...sync.models, summary: 'test/other-cheap' });
  await generateReply(sync.id);
  assert.ok(calls().slice(before).some(call => call.stage === 'chunk' && call.model === 'test/other-cheap'));
});

test('legacy partial-sync expansion preserves notes, discussion and reference IDs without marking anything reviewed', async () => {
  const full = await begin(140);
  getDb().prepare('DELETE FROM sync_items WHERE sync_id = ? AND rowid NOT IN (SELECT rowid FROM sync_items WHERE sync_id = ? ORDER BY rowid LIMIT 2)').run(full.id, full.id);
  getDb().prepare("UPDATE syncs SET snapshot_version = 1, remaining_count = 138, briefing = 'Historical plan [E1]', decisions = 'Keep my decision', carry_forward = 'Keep my blocker' WHERE id = ?").run(full.id);
  getDb().prepare("INSERT INTO sync_messages(sync_id, role, content, created_at) VALUES (?, 'user', 'Original discussion', ?)").run(full.id, new Date().toISOString());
  await assert.rejects(() => generateReply(full.id), /Expand/);
  const expanded = store.expandSnapshot(full.id);
  assert.equal(expanded.items.length, 140);
  assert.equal(expanded.remaining_count, 0);
  assert.equal(expanded.snapshot_version, 2);
  assert.equal(expanded.items[0].ref, 'E1');
  assert.equal(expanded.items[1].ref, 'E2');
  assert.equal(expanded.decisions, 'Keep my decision');
  assert.equal(expanded.carry_forward, 'Keep my blocker');
  assert.equal(expanded.briefing, '');
  assert.equal(expanded.messages.length, 2);
  assert.match(expanded.messages[1].content, /superseded/);
  assert.equal(store.pendingCount(), 140);
  assert.throws(() => store.expandSnapshot(full.id), /already a full/);
});

test('restart marks an unfinished run interrupted and leaves original evidence/coverage intact', async () => {
  const sync = await begin();
  getDb().prepare(`INSERT INTO sync_runs(sync_id, summary_model, final_model, max_invocations, total_entries, started_at)
    VALUES (?, 'test/cheap', 'test/strong', 120, 3, ?)`).run(sync.id, new Date().toISOString());
  closeDb();
  store.recoverInterruptedRuns();
  assert.equal(store.getProgress(sync.id).run.status, 'interrupted');
  assert.equal(store.pendingCount(), 3);
  assert.equal(store.getSync(sync.id).busy, false);
  assert.equal((await generateReply(sync.id)).tree.complete, true);
});

test('question retrieval can reach raw evidence omitted by summaries and final citations are checked', async () => {
  const sync = await begin(220);
  assert.ok(retrieveEvidence(sync, 'Show me E220').some(item => item.ref === 'E220'));
  assert.throws(() => validateVerdict('A claim [E999]', new Set(['E1'])), /invented/);
  assert.throws(() => validateVerdict('A claim without evidence', new Set(['E1'])), /did not cite/);
  const result = await generateReply(sync.id, 'Show me E220');
  const last = calls().at(-1);
  assert.ok(last.retrieved_evidence.some(item => item.ref === 'E220'));
  assert.equal(result.messages.length, 2);
});

test('short wire labels round-trip exactly, without rewriting source prose or accepting guessed references', () => {
  const ids = new Set(['Kabcdef123456', 'K987654fedcba']);
  const text = 'Source prose mentions Kabcdef123456 and S2; leave it unchanged.';
  const wire = prepareModelInput('chunk', { evidence: [{ id: 'Kabcdef123456', text }], background: [{ id: 'K987654fedcba', text }] }, ids);
  assert.equal(wire.input.evidence[0].id, 'S1');
  assert.equal(wire.input.background[0].id, 'S2');
  assert.equal(wire.input.evidence[0].text, text);
  const result = { observations: [{ topic: 'Demo', state: 'reported_done', summary: text, evidence: ['S2'] }], limitations: [] };
  assert.deepEqual(wire.decode(validateSummary(result, wire.allowed)).observations[0].evidence, ['K987654fedcba']);
  assert.throws(() => wire.decode({ ...result, observations: [{ ...result.observations[0], evidence: ['S99'] }] }), /unknown local label/);
  const merged = prepareModelInput('session', { children: [{ id: 'long-child-hash', summary: wire.decode(result) }] }, ids);
  assert.equal(merged.input.children[0].id, 'child1');
  assert.deepEqual(merged.input.children[0].summary.observations[0].evidence, ['S2']);
  const groups = prepareModelInput('topics', { observations: [{ id: 'Nlonghash_0', summary: text }] }, new Set(['Nlonghash_0']));
  assert.equal(groups.input.observations[0].id, 'O1');
  assert.deepEqual(groups.decode({ groups: [{ topic: 'Demo', members: ['O1'] }] }).groups[0].members, ['Nlonghash_0']);
});

test('citation cardinality errors are distinguished from missing and invented references', () => {
  const allowed = new Set(Array.from({ length: 17 }, (_, i) => `S${i + 1}`));
  const summary = evidence => ({ observations: [{ topic: 'Demo', state: 'requested', summary: 'A request', evidence }], limitations: [] });
  assert.throws(() => validateSummary(summary([...allowed]), allowed), /17 distinct source IDs; the maximum is 16/);
  assert.throws(() => validateSummary(summary([]), allowed), /nonempty evidence array/);
  assert.throws(() => validateSummary(summary(['S999']), allowed), /unknown source ID/);
  assert.deepEqual(validateSummary(summary(Array(20).fill('S1')), allowed).observations[0].evidence, ['S1']);
});

test('repair receives the rejected response, precise error, and allowed short labels', async () => {
  const sync = await begin(20);
  control({ tooManySources: true });
  const result = await generateReply(sync.id);
  const chunks = calls().filter(call => call.stage === 'chunk');
  assert.equal(chunks.length, 2);
  assert.match(chunks[1].repair.validation_error, /17 distinct source IDs/);
  assert.equal(JSON.parse(chunks[1].repair.previous_output).observations[0].evidence.length, 17);
  assert.ok(chunks[1].allowed_source_ids.every(id => /^S\d+$/.test(id)));
  assert.equal(result.tree.complete, true);
  const cached = getDb().prepare("SELECT output_json FROM summary_cache WHERE kind = 'chunk'").get();
  assert.ok(JSON.parse(cached.output_json).observations[0].evidence.every(id => /^K/.test(id)), 'cache holds canonical IDs, never short wire labels');
});

test('an invented label is rejected, then repaired by the model rather than guessed locally', async () => {
  const sync = await begin();
  control({ repairableSources: true });
  const result = await generateReply(sync.id);
  const chunks = calls().filter(call => call.stage === 'chunk');
  assert.equal(chunks.length, 2);
  assert.match(chunks[1].repair.validation_error, /unknown source ID/);
  assert.match(chunks[1].repair.previous_output, /K-invented/);
  assert.equal(result.tree.complete, true);
});

test('validated v1 leaf caches survive the short-label upgrade without another model call', async () => {
  const sync = await begin(120);
  const runId = Number(getDb().prepare(`INSERT INTO sync_runs(sync_id, summary_model, final_model, max_invocations, total_entries, started_at)
    VALUES (?, 'test/cheap', 'test/strong', 120, 120, ?)`).run(sync.id, new Date().toISOString()).lastInsertRowid);
  const tree = new SummaryTree(sync, runId, new AbortController().signal);
  const specs = [...tree.chunkSpecs().values()].flat();
  for (const spec of specs) {
    const output = { observations: [{ topic: 'Demo', state: 'reported_done', summary: 'A previously validated cached summary', evidence: [spec.sources.at(-1)] }], limitations: [] };
    getDb().prepare('INSERT INTO summary_cache(key, kind, model, prompt_version, output_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(spec.legacyKey, 'chunk', 'test/cheap', 'sync-tree-v1', JSON.stringify(output), new Date().toISOString());
  }
  const result = await generateReply(sync.id);
  assert.equal(calls().filter(call => call.stage === 'chunk').length, 0);
  assert.ok(result.tree.run.cache_hits >= specs.length);
  assert.equal(result.tree.complete, true);
});

test('missing cheap-model selection does not silently use the expensive default', async () => {
  const sync = await begin();
  process.env.DRAKEN_PI_SUMMARY_MODEL = '';
  await assert.rejects(() => generateReply(sync.id), /Choose a summary model explicitly/);
  assert.equal(calls().length, 0);
});
