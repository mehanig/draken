require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { getDb, closeDb, initSchema } = require('../dist/db/schema');
const store = require('../dist/sync/store');
const { scanSessions } = require('../dist/sync/collector');
const background = require('../dist/sync/background');
const prep = require('../dist/sync/summary-preparation');
const tree = require('../dist/sync/tree');
const { generateReply } = require('../dist/sync/manager');
const { activity } = require('../dist/sync/activity');
const { preparationUsage } = require('../dist/sync/usage');
const LUNA = 'openai/gpt-6-luna', FINAL = 'openai/gpt-6-astra';
let root, file, log, controlFile, rows;
beforeEach(() => {
  closeDb(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-background-summary-'));
  fs.mkdirSync(root + '/sessions'); file = root + '/sessions/synthetic.jsonl'; log = root + '/calls.jsonl'; controlFile = root + '/control.json';
  const fake = root + '/pi'; fs.copyFileSync(path.join(__dirname, 'fixtures/fake-pi.cjs'), fake); fs.chmodSync(fake, 0o700);
  Object.assign(process.env, { DRAKEN_DATA_DIR: root + '/state', DRAKEN_PI_SESSIONS_DIR: root + '/sessions', DRAKEN_PI_BIN: fake,
    DRAKEN_PI_SUMMARY_MODEL: LUNA, DRAKEN_PI_FINAL_MODEL: FINAL, DRAKEN_FAKE_CONTROL: controlFile, DRAKEN_TEST_CALL_LOG: log });
  delete process.env.DRAKEN_PI_MAX_INVOCATIONS; delete process.env.DRAKEN_PI_TIMEOUT_MS;
  getDb().prepare("INSERT INTO sync_settings VALUES('activity_days','null')").run();
  rows = []; control({});
});
afterEach(async () => { await background.stopBackgroundIndexing(); closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
const control = value => fs.writeFileSync(controlFile, JSON.stringify(value));
const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const warm = () => prep.warmSummaryCache(new AbortController().signal);
const runs = () => getDb().prepare('SELECT * FROM background_runs ORDER BY id').all();
const stamp = n => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
function writeRows() {
  const header = { type: 'session', version: 3, id: 'synthetic-background', cwd: '/synthetic/private-workspace', timestamp: stamp(0) };
  fs.writeFileSync(file, [header, ...rows].map(JSON.stringify).join('\n') + '\n');
}
async function append(count) {
  const start = rows.length;
  for (let n = start; n < start + count; n++) rows.push({ type: 'message', id: String(n), parentId: n ? String(n - 1) : null, timestamp: stamp(n),
    message: { role: n ? 'assistant' : 'user', content: `PRIVATE_SOURCE_SENTINEL record ${n}: work was reported, deployment was NOT checked.` } });
  writeRows(); const scan = await scanSessions(); assert.deepEqual(scan.warnings, []);
}
function untouched() {
  for (const table of ['syncs', 'sync_items', 'sync_runs', 'sync_coverage', 'sync_messages', 'sync_presentations', 'sync_tree_nodes']) {
    assert.equal(getDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table + ' must remain untouched');
  }
  assert.ok(calls().every(call => call.model !== FINAL && call.task !== 'final_verdict' && call.task !== 'sync_recap'));
}
async function waitFor(predicate) {
  for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Timed out waiting for synthetic work');
}

test('saved opt-outs survive upgrades; explicit automatic preparation controls both stages', async () => {
  await append(64);
  assert.equal(background.autoIndexSettings().enabled, true); assert.equal(background.autoIndexSettings().summary_enabled, true);
  background.setAutoSummary(false); initSchema(getDb()); assert.equal(prep.summaryPreparationSettings().enabled, false);
  await warm(); assert.equal(calls().length, 0); assert.equal(runs().length, 0);
  for (const value of ['true', 1, null, {}, []]) assert.throws(() => background.setAutoSummary(value), /boolean/);
  background.setAutoIndex(false); assert.throws(() => background.setAutoSummary(true), /automatic indexing/);
  getDb().prepare("DELETE FROM sync_settings WHERE key='auto_summary'").run();
  initSchema(getDb()); assert.equal(prep.summaryPreparationSettings().enabled, true);
  const on = background.setAutoIndex(true); assert.equal(on.summary.enabled, true);
  background.setAutoIndex(false);
  assert.equal(prep.summaryPreparationSettings().enabled, false); assert.equal(prep.summaryPreparationSettings().status, 'off');
  await warm(); assert.equal(calls().length, 0);
  await background.stopBackgroundIndexing(); closeDb(); assert.equal(prep.summaryPreparationSettings().enabled, false);
  background.setAutoIndex(true); background.setAutoSummary(false); await warm(); assert.equal(calls().length, 0); untouched();
});

test('default-on single-entry tails survive restarts without snapshots; explicit sync reuses the complete tree', async () => {
  await append(1); await warm(); assert.equal(prep.summaryPreparationSettings().prepared_entries, 1); untouched();
  for (const total of [2, 3]) {
    await background.stopBackgroundIndexing(); closeDb(); store.recoverInterruptedRuns();
    await append(1); await warm(); assert.equal(prep.summaryPreparationSettings().prepared_entries, total); untouched();
    const after = calls().length; await warm(); await warm(); assert.equal(calls().length, after, 'same successful input is free on every tick');
  }
  assert.deepEqual(runs().map(run => run.total_entries), [1, 2, 3]);
  assert.equal(store.availableCount(), 3); assert.equal(store.pendingCount(), 3);
  const before = getDb().prepare('SELECT total_changes() n').get().n;
  const settings = prep.summaryPreparationSettings(); assert.equal(settings.status, 'waiting'); assert.ok(settings.last_completed_at);
  assert.equal(getDb().prepare('SELECT total_changes() n').get().n, before, 'settings are read-only');
  const receipts = runs();
  assert.doesNotMatch(JSON.stringify(receipts), /PRIVATE_SOURCE_SENTINEL|private-workspace|deployment/);
  assert.ok(receipts.every(run => run.status === 'completed' && run.processed_entries === run.total_entries));
  const count = calls().length, sync = store.startConversationSync('synthetic-explicit-start');
  assert.equal(sync.items.length, 3); await generateReply(sync.id);
  const explicit = calls().slice(count); assert.equal(explicit.length, 1, 'foreground only needs its final verdict'); assert.equal(explicit[0].task, 'final_verdict');
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});

test('equal-count source edits accumulate canonically, while model and recipe changes reprepare without new IDs', async () => {
  background.setAutoSummary(true); await append(128); await warm();
  rows[1].message.content += ' changed'; writeRows(); await scanSessions();
  assert.equal(prep.summaryPreparationSettings().prepared_entries, 128); let before = calls().length; await warm(); assert.ok(calls().length > before);
  let edited = 1;
  for (const count of [32, 63, 64]) {
    for (let n = edited + 1; n <= count; n++) rows[n].message.content += ' changed';
    edited = count; writeRows(); await scanSessions(); await warm();
    assert.ok(calls().length > before); before = calls().length;
  }
  assert.equal(prep.summaryPreparationSettings().prepared_entries, 128);
  process.env.DRAKEN_PI_SUMMARY_MODEL = 'synthetic/new-summary';
  before = calls().length; await warm(); assert.ok(calls().length > before); assert.equal(prep.summaryPreparationSettings().prepared_entries, 128);
  const original = tree.summaryPreparationKey;
  try {
    tree.summaryPreparationKey = input => 'new-recipe-' + original(input);
    await warm();
    assert.equal(prep.summaryPreparationSettings().prepared_entries, 128); assert.equal(runs().length, 7);
  } finally { tree.summaryPreparationKey = original; }
  untouched();
});

test('a single edited message is prepared and subsequent unchanged checks reuse it', async () => {
  background.setAutoSummary(true); await append(128); await warm();
  const before = calls().length, oldName = store.previewSummaryInput().items[0].session_name;
  rows[0].message.content = 'Different first user message and derived session title'; writeRows(); await scanSessions();
  assert.notEqual(store.previewSummaryInput().items[0].session_name, oldName);
  await warm(); assert.ok(calls().length > before); assert.equal(runs().length, 2);
  const after = calls().length; await warm(); assert.equal(calls().length, after); untouched();
});

test('removals refresh retained summaries at the next idle check', async () => {
  background.setAutoSummary(true); await append(128); await warm(); const before = calls().length;
  for (const removed of [32, 63, 64]) {
    rows.length = 128 - removed; writeRows(); await scanSessions(); await warm();
    assert.ok(calls().length > before);
  }
  assert.deepEqual(runs().map(run => run.total_entries), [128, 96, 65, 64]); untouched();
});

test('lost or corrupt outputs invalidate completed receipts and rebuild only bounded reusable cache work', async () => {
  background.setAutoSummary(true); await append(64); await warm();
  for (const mutate of [
    () => getDb().exec('DELETE FROM summary_cache'),
    () => getDb().prepare("UPDATE summary_cache SET output_json='invalid JSON' WHERE kind='chunk'").run(),
  ]) {
    const before = calls().length; mutate(); await warm();
    assert.ok(calls().length > before); assert.equal(runs().at(-1).status, 'completed');
    assert.ok(JSON.parse(runs().at(-1).cache_receipt_json).length);
    const after = calls().length, count = runs().length;
    await warm(); background.setAutoSummary(true); await warm();
    assert.equal(calls().length, after); assert.equal(runs().length, count, 'valid replacement receipts suppress repeated work');
  }
  untouched();
});

test('receipt validation covers parent compaction as well as leaf summaries', async () => {
  process.env.DRAKEN_PI_SUMMARY_MODEL = 'synthetic/conservative';
  background.setAutoSummary(true); await append(128); await warm();
  const before = calls().length, chunks = calls().filter(call => call.stage === 'chunk').length;
  const removed = getDb().prepare("DELETE FROM summary_cache WHERE kind!='chunk'").run(); assert.ok(removed.changes > 0);
  await warm(); assert.ok(calls().length > before); assert.equal(calls().filter(call => call.stage === 'chunk').length, chunks);
  assert.equal(runs().at(-1).status, 'completed'); untouched();
});

test('context-only changes invalidate and reprepare a full eligible batch', async () => {
  await append(70); getDb().prepare("INSERT INTO sync_settings(key,value) VALUES ('history_since',?)").run(stamp(6));
  const input = store.previewSummaryInput(); assert.equal(input.items.length, 64); assert.equal(input.context.length, 6);
  background.setAutoSummary(true); await warm(); const before = calls().length;
  rows[3].message.content += ' revised context'; writeRows(); await scanSessions();
  await warm(); assert.ok(calls().length > before);
  assert.equal(prep.summaryPreparationSettings().prepared_entries, 64); assert.equal(runs().length, 2); untouched();
});

test('unavailable or modified originals fail closed without paid requests, reservations or leaked errors', async () => {
  background.setAutoSummary(true); await append(64); await warm(); const before = calls().length;
  fs.unlinkSync(file); assert.equal(prep.summaryPreparationSettings().prepared_entries, 64, 'historical progress does not open missing originals'); await warm();
  assert.equal(calls().length, before); assert.equal(prep.summaryPreparationSettings().status, 'error');
  assert.doesNotMatch(prep.summaryPreparationSettings().error, /PRIVATE_SOURCE_SENTINEL|private-workspace|synthetic\.jsonl/);
  writeRows(); await scanSessions(); await warm(); assert.equal(calls().length, before, 'restoring files does not authorize a failed paid retry');
  background.setAutoSummary(true); await warm(); assert.equal(prep.summaryPreparationSettings().prepared_entries, 64); untouched();
});

test('provider failures and malformed-output repairs pause paid work durably until an explicit bounded retry', async () => {
  background.setAutoSummary(true); await append(64); control({ invalidSources: true }); await warm();
  assert.equal(calls().length, 2); assert.equal(runs()[0].status, 'failed'); assert.equal(runs()[0].invocations, 2);
  assert.equal(prep.summaryPreparationSettings().status, 'error');
  for (let n = 0; n < 5; n++) await warm(); assert.equal(calls().length, 2);
  await background.stopBackgroundIndexing(); closeDb(); store.recoverInterruptedRuns(); await warm(); assert.equal(calls().length, 2);
  assert.equal(background.autoIndexSettings().phase, 'error');
  assert.equal(background.autoIndexSettings().error, prep.summaryPreparationSettings().error);
  background.setAutoIndex(false); await warm(); assert.equal(calls().length, 2);
  background.setAutoIndex(true); await warm(); assert.equal(calls().length, 4); assert.equal(runs().length, 2); await warm(); assert.equal(calls().length, 4);
  control({}); background.setAutoSummary(true); await warm(); assert.equal(runs().at(-1).status, 'completed');
  const usage = preparationUsage(getDb(), {}, Date.now() + 1000); assert.equal(usage.totals.requests, calls().length); assert.equal(usage.totals.failed_attempts, 2);
  assert.equal(usage.totals.entries, 0); assert.equal(usage.totals.completed_batches, 0); assert.ok(usage.totals.cost.usd > 0);
  assert.doesNotMatch(JSON.stringify(runs()), /PRIVATE_SOURCE_SENTINEL|private-workspace/); untouched();
});

test('provider process failures retain unpriced request metadata and cannot retry automatically', async () => {
  background.setAutoSummary(true); await append(64); control({ failStage: 'chunk' }); await warm();
  assert.equal(calls().length, 1); const run = runs()[0]; assert.equal(run.status, 'failed'); assert.equal(run.invocations, 1);
  const metrics = JSON.parse(run.metrics_json); assert.equal(metrics.length, 1); assert.equal(metrics[0].status, 'failed');
  const usage = preparationUsage(getDb(), {}, Date.now() + 1000); assert.equal(usage.totals.requests, 1);
  assert.equal(usage.totals.cost.usd, null); assert.equal(usage.totals.cost.complete, false); assert.equal(usage.totals.failed_attempts, 1);
  control({}); await warm(); assert.equal(calls().length, 1); untouched();
});

test('preview reads verified existing discovery without scanning, reserving, or persisting snapshot data', async () => {
  await append(64); const before = getDb().prepare('SELECT total_changes() n').get().n;
  const extra = { type: 'message', id: '64', parentId: '63', timestamp: stamp(64), message: { role: 'assistant', content: 'Unscanned synthetic arrival' } };
  fs.appendFileSync(file, JSON.stringify(extra) + '\n');
  const input = store.previewSummaryInput(); assert.equal(input.items.length, 64); assert.equal(input.models.summary, LUNA);
  assert.equal(getDb().prepare('SELECT total_changes() n').get().n, before); untouched();
  fs.unlinkSync(file); assert.throws(() => store.previewSummaryInput(), /Original session evidence/);
});

test('cancelled same-input work resumes the same invocation allowance and metrics after restart', async () => {
  process.env.DRAKEN_PI_MAX_INVOCATIONS = '2'; background.setAutoSummary(true); await append(64); control({ delay: 10000 });
  const life = new AbortController(), running = prep.warmSummaryCache(life.signal);
  await waitFor(() => calls().length === 1); assert.equal(prep.summaryPreparationSettings().status, 'running');
  life.abort(); await running; const first = runs()[0]; assert.equal(first.status, 'cancelled'); assert.equal(first.invocations, 1);
  getDb().prepare("UPDATE background_runs SET status='running',processed_entries=999,cache_hits=999 WHERE id=?").run(first.id);
  await background.stopBackgroundIndexing(); closeDb(); store.recoverInterruptedRuns(); assert.equal(runs()[0].status, 'interrupted');
  const failures = JSON.parse(runs()[0].failure_events_json); assert.deepEqual(failures.map(event => event.status), ['cancelled', 'interrupted']);
  store.recoverInterruptedRuns(); assert.deepEqual(JSON.parse(runs()[0].failure_events_json), failures, 'recovery is recorded only once');
  control({}); await warm(); const last = runs()[0]; assert.equal(runs().length, 1); assert.equal(last.id, first.id); assert.equal(last.status, 'completed');
  assert.equal(last.invocations, 2); assert.equal(JSON.parse(last.metrics_json).length, 2); assert.equal(last.processed_entries, 64); assert.ok(last.cache_hits < 999); untouched();
});

test('cancellation after a successful request keeps its failed-attempt history when the same run resumes entirely from cache', async () => {
  background.setAutoSummary(true); await append(64);
  const pi = require('../dist/sync/pi'), original = pi.invokePi; let release;
  pi.invokePi = async (...args) => { const response = await original(...args); release = activity.beginStart(); return response; };
  try {
    await warm(); const run = runs()[0]; assert.equal(run.status, 'cancelled');
    assert.equal(JSON.parse(run.metrics_json)[0].status, 'completed');
    assert.equal(preparationUsage(getDb(), {}, Date.now() + 1000).totals.failed_attempts, 1);
    release(); release = undefined; pi.invokePi = original;
    await warm(); assert.equal(runs().length, 1); assert.equal(runs()[0].status, 'completed'); assert.equal(calls().length, 1);
    const usage = preparationUsage(getDb(), {}, Date.now() + 1000);
    assert.equal(usage.totals.failed_attempts, 1); assert.equal(usage.totals.requests, 1);
    assert.equal(JSON.parse(runs()[0].failure_events_json).length, 1); untouched();
  } finally { release?.(); pi.invokePi = original; }
});

test('an unrecovered running ledger cannot silently become a fresh allowance', async () => {
  background.setAutoSummary(true); await append(64); const input = store.previewSummaryInput();
  getDb().prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,input_key,invocations)
    VALUES (?,?,?,?,?,?,1)`).run(LUNA, FINAL, 2, 64, new Date().toISOString(), tree.summaryPreparationKey(input));
  await warm(); assert.equal(calls().length, 0); assert.equal(runs().length, 1); assert.equal(runs()[0].invocations, 1);
  assert.equal(runs()[0].status, 'failed'); assert.equal(prep.summaryPreparationSettings().status, 'error');
  await warm(); assert.equal(calls().length, 0); untouched();
});

test('cancellation at quota cannot trigger a fresh allowance or repeat 409 attempts every tick', async () => {
  process.env.DRAKEN_PI_MAX_INVOCATIONS = '1'; background.setAutoSummary(true); await append(64); control({ delay: 10000 });
  const life = new AbortController(), running = prep.warmSummaryCache(life.signal); await waitFor(() => calls().length === 1);
  life.abort(); await running; assert.equal(runs()[0].status, 'failed'); assert.equal(prep.summaryPreparationSettings().status, 'error');
  control({}); for (let n = 0; n < 4; n++) await warm(); assert.equal(calls().length, 1); assert.equal(runs().length, 1);
  await background.stopBackgroundIndexing(); closeDb(); store.recoverInterruptedRuns(); await warm(); assert.equal(calls().length, 1);
  background.setAutoSummary(true); await warm(); assert.equal(calls().length, 2); assert.equal(runs().length, 2); assert.equal(runs()[1].status, 'completed'); untouched();
});

test('disable-enable cannot revive an old signal and foreground yielding drains the provider before snapshot creation', async () => {
  background.setAutoSummary(true); await append(128); control({ delay: 10000 });
  const running = warm(); await waitFor(() => calls().length === 1);
  background.setAutoSummary(false); background.setAutoSummary(true);
  await background.yieldBackgroundIndexing(); await running; assert.equal(calls().length, 1); assert.equal(runs()[0].status, 'cancelled');
  const sync = store.startConversationSync('manual-after-drain'); assert.equal(sync.items.length, 128);
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM background_runs WHERE status='running'").get().n, 0);
  assert.equal(calls().length, 1);
});

test('disabling automatic preparation cancels both stages; enabling resumes the same bounded allowance', async () => {
  background.setAutoSummary(true); await append(64); control({ delay: 10000 });
  const running = warm(); await waitFor(() => calls().length === 1);
  background.setAutoIndex(false); await background.yieldBackgroundIndexing(); await running;
  assert.equal(prep.summaryPreparationSettings().enabled, false); assert.equal(prep.summaryPreparationSettings().status, 'off');
  control({}); await warm(); assert.equal(calls().length, 1);
  background.setAutoIndex(true); await warm(); assert.equal(runs().length, 1); assert.equal(runs()[0].invocations, 2); assert.equal(runs()[0].status, 'completed'); untouched();
});

test('background stages never persist source titles or paths, including cancellation and recovery', async () => {
  background.setAutoSummary(true); await append(64); control({ delay: 10000 });
  const running = warm(); await waitFor(() => calls().length === 1);
  assert.doesNotMatch(JSON.stringify(runs()), /PRIVATE_SOURCE_SENTINEL|private-workspace/);
  background.setAutoSummary(false); await running;
  assert.doesNotMatch(JSON.stringify(runs()), /PRIVATE_SOURCE_SENTINEL|private-workspace/);
  getDb().prepare("UPDATE background_runs SET status='running' WHERE id=?").run(runs()[0].id);
  store.recoverInterruptedRuns(); assert.doesNotMatch(JSON.stringify(runs()), /PRIVATE_SOURCE_SENTINEL|private-workspace/);
  untouched();
});

test('cancellation ledger failure remains owned and cannot create an unhandled rejection or a fresh paid allowance', async () => {
  background.setAutoSummary(true); await append(64); control({ delay: 10000 });
  const settling = warm().then(() => null, error => error); await waitFor(() => calls().length === 1);
  getDb().exec("CREATE TRIGGER reject_summary_terminal BEFORE UPDATE OF status ON background_runs BEGIN SELECT RAISE(ABORT,'synthetic ledger unavailable'); END");
  try {
    background.setAutoIndex(false);
    assert.match((await settling).message, /synthetic ledger unavailable/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs()[0].status, 'running');
  } finally { getDb().exec('DROP TRIGGER reject_summary_terminal'); }
  background.setAutoIndex(true); control({}); await warm();
  assert.equal(calls().length, 1); assert.equal(runs().length, 1); assert.equal(runs()[0].status, 'failed');
  assert.equal(prep.summaryPreparationSettings().status, 'error'); untouched();
});

test('late foreground activity blocks subsequent provider calls even without a route-level yield', async () => {
  process.env.DRAKEN_PI_SUMMARY_MODEL = 'synthetic/conservative';
  background.setAutoSummary(true); await append(128); control({ delay: 100 });
  const running = warm(); await waitFor(() => calls().length === 1);
  const release = activity.beginStart();
  try { await running; assert.equal(calls().length, 1); assert.equal(runs()[0].status, 'cancelled'); await warm(); assert.equal(calls().length, 1); }
  finally { release(); }
  control({}); await warm(); assert.equal(runs()[0].status, 'completed'); untouched();
});

test('later arrivals do not discard a captured batch; explicit source opt-out blocks its receipt', async () => {
  background.setAutoIndex(true); await append(1); control({ delay: 150 });
  let running = warm(); await waitFor(() => calls().length === 1);
  await append(1); await running;
  assert.equal(runs()[0].status, 'completed'); assert.equal(runs()[0].total_entries, 1);
  assert.equal(prep.summaryPreparationSettings().prepared_entries, 1);
  running = warm(); await waitFor(() => calls().length === 2);
  store.setIncluded('synthetic-background', false);
  await running;
  assert.equal(runs().at(-1).status, 'failed');
  assert.equal(prep.summaryPreparationSettings().prepared_entries, 1);
  assert.equal(background.autoIndexSettings().phase, 'error'); untouched();
});

test('a model configuration change during a request cannot publish a receipt for the new input', async () => {
  background.setAutoSummary(true); await append(64); control({ delay: 100 });
  const running = warm(); await waitFor(() => calls().length === 1);
  process.env.DRAKEN_PI_FINAL_MODEL = 'synthetic/different-final'; await running;
  assert.equal(runs()[0].status, 'cancelled'); assert.equal(prep.summaryPreparationSettings().prepared_entries, 0); untouched();
});
