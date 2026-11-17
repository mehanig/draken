require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getDb, closeDb } = require('../dist/db/schema');
const { scanSessions } = require('../dist/sync/collector');
const store = require('../dist/sync/store');
const { SummaryTree } = require('../dist/sync/tree');
const { LUNA_BATCH } = require('../dist/sync/summary-budget');
const preview = require('../dist/sync/preparation-preview');
const { activity } = require('../dist/sync/activity');
const background = require('../dist/sync/background');
const { createApp } = require('../dist/server');
const { install } = require('./fixtures/preview-worker.cjs');
let root, server, base, providers, worker;
function instrument(options) { worker?.restore(); return worker = install(options); }
const originalCall = SummaryTree.prototype.call;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-free-preview-')); fs.mkdirSync(root + '/sessions');
  Object.assign(process.env, { DRAKEN_DATA_DIR: root + '/state', DRAKEN_PI_SESSIONS_DIR: root + '/sessions', DRAKEN_PI_BIN: '/no-provider',
    DRAKEN_PI_SUMMARY_MODEL: 'openai/gpt-6-luna', DRAKEN_PI_FINAL_MODEL: 'synthetic/final', DRAKEN_NO_AUTH: 'true' });
  instrument();
  providers = 0; SummaryTree.prototype.call = async () => { providers++; throw Error('Provider forbidden'); };
});
afterEach(async () => {
  await activity.drainPreview(); await background.stopBackgroundIndexing();
  if (server) { await new Promise(resolve => server.close(resolve)); server = undefined; }
  SummaryTree.prototype.call = originalCall;
  worker.restore();
  assert.ok(worker.events.every(event => !['provider', 'leaked-handles'].includes(event.previewTest)));
  for (const child of worker.workers) assert.equal(fs.existsSync(child.previewDirectory), false, 'clone cleaned before lease release');
  assert.equal(providers, 0);
  closeDb(); fs.rmSync(root, { recursive: true, force: true });
});
function session(count = 5) {
  const id = randomUUID(), file = root + '/sessions/' + id + '.jsonl';
  const rows = [{ type: 'session', version: 3, id, cwd: '/synthetic/work', timestamp: '2026-01-01T00:00:00Z' },
    ...Array.from({ length: count }, (_, n) => ({ type: 'message', id: `${id}-${n}`, parentId: n ? `${id}-${n - 1}` : null,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), message: { role: n ? 'assistant' : 'user',
        content: [{ type: 'text', text: `Synthetic private sentinel ${n}. Work remains unverified.` }] } }))];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n'); return { id, file, rows };
}
async function api() {
  server = createApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
}
const post = (route = '/preparation-preview', body = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const turn = () => new Promise(resolve => setImmediate(resolve));
async function settled() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const result = preview.preparationPreview(); if (result.phase !== 'checking') return result; await new Promise(r => setTimeout(r, 5)); }
  throw Error('Preview did not settle');
}
async function verify() { preview.requestPreparationPreview(); return settled(); }
function counts(value, cached, pending) {
  assert.equal(value.phase, 'ready', JSON.stringify(value)); assert.equal(value.cached, cached); assert.equal(value.needs_processing, pending);
  assert.equal(value.total, cached + pending); assert.ok(Date.parse(value.checked_at)); assert.equal(value.error, '');
}
function receipt(input, indices, backgroundIndices = [], batch = true) {
  const tree = SummaryTree.forPreview(input, new AbortController().signal);
  try {
    const leaf = { session: input.items[0].session_id, workspace: input.items[0].cwd,
      evidence: indices.map(i => input.items[i]), background: backgroundIndices.map(i => input.items[i]) };
    const spec = tree.leafSpec(leaf, batch), output = JSON.stringify({ observations: [], limitations: ['Synthetic cached processing.'] });
    getDb().prepare('INSERT OR REPLACE INTO summary_cache(key,kind,model,prompt_version,output_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(spec.key, 'chunk', input.models.summary, batch ? LUNA_BATCH.version : 'sync-tree-v2-short-labels', output, new Date().toISOString());
    const leaves = tree.leafStore(); leaves.save(spec.key, input.models.summary, tree.leafRecipe(batch), batch, leaves.encode(leaf), output);
    return spec.key;
  } finally { tree.leaves?.close(); }
}
function durable() {
  return ['syncs', 'sync_items', 'sync_runs', 'background_runs', 'sync_messages', 'sync_coverage', 'sync_settings', 'live_calls', 'voice_calls']
    .map(table => [table, getDb().prepare(`SELECT * FROM ${table}`).all()]);
}

for (const batch of [true, false]) {
  test(`${batch ? 'batch' : 'conservative'} fresh, mixed and complete overlapping/interleaved union counts use full leaves, not citations`, async () => {
    if (!batch) process.env.DRAKEN_PI_SUMMARY_MODEL = 'synthetic/conservative';
    session(); await scanSessions(); const before = durable();
    counts(await verify(), 0, 5);
    let input = store.previewSummaryInput(); receipt(input, [0, 2], [], batch); receipt(input, [2, 4], [0], batch);
    assert.equal(preview.preparationPreview().phase, 'stale'); counts(await verify(), 3, 2);
    input = store.previewSummaryInput(); receipt(input, [1, 3], [0, 2], batch);
    counts(await verify(), 5, 0);
    assert.deepEqual(durable(), before, 'no snapshots, runs, notes, reviews, consent or accounting mutations');
  });
}

test('GET is metadata only, null before verification; POST is strict, free and coalesced', async () => {
  session(); await scanSessions(); await api();
  const original = store.previewSummaryInput; let reads = 0;
  store.previewSummaryInput = () => { reads++; return original(); };
  try {
    let value = await (await fetch(base + '/preparation-preview')).json();
    assert.equal(value.phase, 'stale'); assert.equal(value.total, null); assert.equal(reads, 0);
    for (const body of [null, [], { force: true }]) assert.equal((await post('/preparation-preview', body)).status, 400);
    const results = await Promise.all(Array.from({ length: 4 }, () => post()));
    assert.ok(results.every(r => [200, 202].includes(r.status))); counts(await settled(), 0, 5);
    const prior = reads, changes = getDb().prepare('SELECT total_changes() n').get().n;
    const plan = SummaryTree.prototype.planLeaves;
    SummaryTree.prototype.planLeaves = () => { throw Error('GET must not plan'); };
    try { for (let n = 0; n < 4; n++) counts(await (await fetch(base + '/preparation-preview')).json(), 0, 5); }
    finally { SummaryTree.prototype.planLeaves = plan; }
    assert.equal(reads, prior); assert.equal(getDb().prepare('SELECT total_changes() n').get().n, changes);
    assert.equal(reads, 0, 'no corpus reads on the main thread');
    assert.equal(worker.workers.length, 1, 'duplicate POSTs own one worker');
    assert.equal(worker.events.filter(e => e.previewTest === 'input').length, 1, 'worker snapshots once; final physical proof uses tree dependencies');
  } finally { store.previewSummaryInput = original; }
});

test('metadata invalidation includes effective sources, models, consent, membership and outputs, not unrelated index bookkeeping', async () => {
  const data = session(); await scanSessions(); counts(await verify(), 0, 5);
  await scanSessions(); counts(preview.preparationPreview(), 0, 5);
  getDb().prepare('UPDATE agent_sessions SET modified_at=?,byte_offset=byte_offset+1 WHERE id=?').run(new Date().toISOString(), data.id);
  counts(preview.preparationPreview(), 0, 5);
  const invalidate = () => { const value = preview.preparationPreview(); assert.equal(value.phase, 'stale'); assert.equal(value.cached, null); assert.equal(value.needs_processing, null); };
  process.env.DRAKEN_PI_FINAL_MODEL = 'synthetic/changed'; invalidate(); counts(await verify(), 0, 5);
  getDb().prepare("INSERT OR REPLACE INTO sync_settings VALUES ('auto_summary','true')").run(); invalidate(); counts(await verify(), 0, 5);
  getDb().prepare('UPDATE agent_sessions SET included=0 WHERE id=?').run(data.id); invalidate(); counts(await verify(), 0, 0);
  getDb().prepare('UPDATE agent_sessions SET included=1 WHERE id=?').run(data.id); invalidate(); counts(await verify(), 0, 5);
  getDb().prepare('UPDATE agent_entries SET active=0 WHERE id=(SELECT MAX(id) FROM agent_entries)').run(); invalidate(); counts(await verify(), 0, 4);
  receipt(store.previewSummaryInput(), [0, 1]); invalidate(); counts(await verify(), 2, 2);
  getDb().prepare('DELETE FROM summary_cache').run(); invalidate(); counts(await verify(), 0, 4);
});

test('summary model, agent admission and explicit review invalidate cached membership without side effects', async () => {
  session(); await scanSessions(); receipt(store.previewSummaryInput(), [0, 1]); counts(await verify(), 2, 3);
  process.env.DRAKEN_PI_SUMMARY_MODEL = 'synthetic/changed-summary';
  assert.equal(preview.preparationPreview().phase, 'stale'); counts(await verify(), 0, 5);
  getDb().prepare("UPDATE agent_sources SET enabled=0 WHERE id='pi'").run();
  assert.equal(preview.preparationPreview().phase, 'stale'); counts(await verify(), 0, 0);
  getDb().prepare("UPDATE agent_sources SET enabled=1 WHERE id='pi'").run(); counts(await verify(), 0, 5);
  const sync = store.startSync(); store.discardSync(sync.id);
  counts(await verify(), 0, 5);
  getDb().prepare('INSERT INTO sync_coverage(event_key,sync_id) SELECT event_key,? FROM agent_entries ORDER BY id LIMIT 1').run(sync.id);
  assert.equal(preview.preparationPreview().phase, 'stale'); counts(await verify(), 0, 4);
});

test('free preview never scans, builds, embeds, searches or warms paid summaries', async () => {
  session(); await scanSessions();
  const service = require('../dist/memory/service'), collector = require('../dist/sync/collector');
  const paid = require('../dist/sync/summary-preparation'), originals = [];
  for (const [object, name] of [[collector, 'scanSessions'], [service, 'prepareHistory'], [service, 'searchHistory'],
    [service, 'searchPreparedHistory'], [service, 'readHistory'], [paid, 'warmSummaryCache'], [SummaryTree.prototype, 'build']]) {
    originals.push([object, name, object[name]]); object[name] = () => { throw Error('Forbidden work: ' + name); };
  }
  try { const before = durable(); counts(await verify(), 0, 5); assert.deepEqual(durable(), before); }
  finally { for (const [object, name, value] of originals) object[name] = value; }
});

test('receipt provenance and changed originals fail closed with generic safe error; failed GET never retries', async () => {
  const data = session(); await scanSessions(); const key = receipt(store.previewSummaryInput(), [0, 2], [1]);
  counts(await verify(), 2, 3);
  const row = getDb().prepare('SELECT input_json FROM summary_leaf_inputs WHERE key=?').get(key), encoded = JSON.parse(row.input_json);
  encoded.background[0].source_pointer.original.record_hash = '0'.repeat(64);
  getDb().prepare('UPDATE summary_leaf_inputs SET input_json=? WHERE key=?').run(JSON.stringify(encoded), key);
  let result = await verify(); assert.equal(result.phase, 'unavailable'); assert.equal(result.cached, null);
  assert.doesNotMatch(result.error, /sentinel|synthetic\/work|jsonl|record_hash/);
  const original = store.previewSummaryInput; store.previewSummaryInput = () => { throw Error('GET retried'); };
  try { for (let n = 0; n < 3; n++) assert.equal(preview.preparationPreview().phase, 'unavailable'); }
  finally { store.previewSummaryInput = original; }
  getDb().prepare('UPDATE summary_leaf_inputs SET input_json=? WHERE key=?').run(row.input_json, key);
  counts(await verify(), 2, 3);
  fs.writeFileSync(data.file, fs.readFileSync(data.file, 'utf8').replace('Synthetic private sentinel 1', 'Synthetic private sentinel X'));
  // Physical changes are bounded by the disclosed five-minute verification TTL.
  const now = Date.now; Date.now = () => now() + 6 * 60_000;
  try { assert.equal(preview.preparationPreview().phase, 'stale'); }
  finally { Date.now = now; }
  result = await verify(); assert.equal(result.phase, 'unavailable'); assert.equal(result.total, null);
});

test('revoked uncited background consent blocks a completed receipt rather than advertising paid replacement', async () => {
  const primary = session(), dependency = session(2); await scanSessions();
  const input = store.previewSummaryInput();
  input.items = [...input.items.filter(item => item.session_id === primary.id), ...input.items.filter(item => item.session_id === dependency.id)];
  receipt(input, [0, 2], [5]); counts(await verify(), 2, 5);
  getDb().prepare('UPDATE agent_sessions SET included=0 WHERE id=?').run(dependency.id);
  const result = await verify(); assert.equal(result.phase, 'unavailable'); assert.equal(result.needs_processing, null);
});

test('a genuinely changed background projection requires fresh processing rather than invalid cache coverage', async () => {
  const data = session(); await scanSessions();
  receipt(store.previewSummaryInput(), [0, 2], [1, 3]); counts(await verify(), 2, 3);
  data.rows[4].message.content[0].text = 'A legitimately changed synthetic background input.';
  fs.writeFileSync(data.file, data.rows.map(JSON.stringify).join('\n') + '\n'); await scanSessions();
  counts(await verify(), 0, 5);
});

test('source or cache mutation after worker physical verification cannot publish or import metadata', async () => {
  session(); await scanSessions();
  for (const mutate of [() => getDb().prepare('UPDATE agent_entries SET active=0 WHERE id=1').run(),
    () => getDb().prepare("INSERT INTO summary_leaf_plans VALUES ('concurrent','[]')").run(),
    () => { process.env.DRAKEN_PI_FINAL_MODEL += '-changed'; }]) {
    instrument({ onResult: mutate });
    const result = await verify(); assert.equal(result.phase, 'stale'); assert.equal(result.cached, null);
    assert.equal(getDb().prepare("SELECT COUNT(*) n FROM summary_leaf_plans WHERE identity!='concurrent'").get().n, 0);
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM summary_pending_plans').get().n, 0);
  }
});

test('foreground start reserves ownership while cancellation drains, coalesces duplicate previews and keeps Home Start enabled', async () => {
  session(); await scanSessions(); await api();
  let release;
  const retirement = new Promise(resolve => { release = resolve; });
  instrument({ hold: 'before', retirement });
  try {
    assert.equal((await post()).status, 202);
    await worker.entered;
    assert.equal(activity.busy, false); assert.equal(activity.backgroundIdle, false);
    assert.throws(() => scanSessions(), /verification is stopping/);
    assert.throws(() => store.setIncluded(getDb().prepare('SELECT id FROM agent_sessions').get().id, false), /verification is stopping/);
    assert.equal(store.homeOverview().busy, false);
    await post(); assert.equal(worker.workers.length, 1);
    let started = false; const start = post('/syncs').then(r => { started = true; return r; });
    for (let n = 0; n < 10; n++) await turn();
    assert.equal(started, false); assert.equal(getDb().prepare('SELECT COUNT(*) n FROM syncs').get().n, 0);
    assert.equal((await (await post()).json()).phase, 'paused');
    release(); assert.equal((await start).status, 200);
    assert.equal(worker.workers.length, 1); assert.equal(getDb().prepare('SELECT COUNT(*) n FROM syncs').get().n, 1);
    assert.notEqual(preview.preparationPreview().phase, 'ready');
  } finally { release(); worker.release(); await activity.drainPreview(); }
});

test('preview is paused during call/foreground leases; provider guard precedes even an overridden call', async () => {
  session(); await scanSessions();
  for (const acquire of [() => activity.beginStart(), () => activity.beginCall(123), () => activity.beginJob(123, new AbortController())]) {
    const release = acquire(); try { assert.equal(preview.requestPreparationPreview().phase, 'paused'); } finally { release(); }
  }
  const tree = SummaryTree.forPreview(store.previewSummaryInput(), new AbortController().signal);
  await assert.rejects(tree.build(), /cannot invoke a provider/);
  await assert.rejects(originalCall.call(tree, {}, 'synthetic'), /cannot invoke a provider/);
  const spec = [...tree.chunkSpecs(false).values()].flat()[0];
  try { await assert.rejects(tree.node(spec, () => ({})), /cannot invoke a provider/); }
  finally { tree.leaves?.close(); }
  assert.equal(providers, 0);
});

test('all original file descriptors close on success, failure and cancellation', async () => {
  session(); await scanSessions();
  const open = fs.openSync, close = fs.closeSync, handles = new Set();
  fs.openSync = function(file, ...args) { const fd = open.call(this, file, ...args); if (String(file).startsWith(root + '/sessions')) handles.add(fd); return fd; };
  fs.closeSync = function(fd) { handles.delete(fd); return close.call(this, fd); };
  try {
    counts(await verify(), 0, 5); assert.equal(handles.size, 0);
    assert.ok(worker.events.some(e => e.previewTest === 'closed-handles'), 'worker closed original descriptors');
    instrument({ action: 'freezeError' });
    process.env.DRAKEN_PI_FINAL_MODEL = 'synthetic/other'; assert.equal((await verify()).phase, 'unavailable');
    assert.ok(worker.events.some(e => e.previewTest === 'closed-handles'), 'worker failure closed originals');
    assert.equal(handles.size, 0);
    instrument({ hold: 'before' }); preview.requestPreparationPreview(); await worker.entered;
    await activity.drainPreview(); assert.equal(handles.size, 0);
    assert.notEqual(preview.preparationPreview().phase, 'ready');
  } finally { fs.openSync = open; fs.closeSync = close; }
});

test('preview drains background indexing through the index-only path without cancelling itself', async () => {
  session(); await scanSessions();
  let release, scans = 0, stopRequested = false;
  const gate = new Promise(resolve => { release = resolve; });
  const indexer = background.createAutoIndexer({ enabled: () => true, idle: () => activity.backgroundIdle, now: Date.now,
    scan: async signal => { scans++; signal.addEventListener('abort', () => { stopRequested = true; }, { once: true }); await gate; return { warnings: [] }; },
    stamp: () => new Map(), baseline: () => new Map(), prepare: async () => { throw Error('No embeddings'); }, completed: () => {} });
  const job = indexer.tick(), drain = background.yieldIndexingForPreview;
  background.yieldIndexingForPreview = () => indexer.stop();
  try {
    assert.equal(preview.requestPreparationPreview().phase, 'checking');
    for (let n = 0; n < 10 && !stopRequested; n++) await turn();
    assert.equal(stopRequested, true); assert.equal(activity.backgroundIdle, false);
    assert.equal(preview.preparationPreview().phase, 'checking');
    release(); await job; counts(await settled(), 0, 5); assert.equal(scans, 1);
  } finally { release(); await activity.drainPreview(); background.yieldIndexingForPreview = drain; }
});

test('shutdown aborts and drains the preview, rejects queued foreground work and blocks new POST ownership', async () => {
  session();
  const { execFile } = require('node:child_process');
  const run = require('node:util').promisify(execFile);
  await run(process.execPath, ['-e', `
    require('./tests/fixtures/fake-memory.cjs');
    const assert = require('node:assert/strict');
    const { activity } = require('./dist/sync/activity');
    const { SummaryTree } = require('./dist/sync/tree');
    const preview = require('./dist/sync/preparation-preview');
    const { route } = require('./dist/routes/http');
    const { getDb, closeDb } = require('./dist/db/schema');
    (async () => {
      await require('./dist/sync/collector').scanSessions();
      let release;
      const retirement = new Promise(r => release = r);
      const worker = require('./tests/fixtures/preview-worker.cjs').install({ hold: 'before', retirement });
      preview.requestPreparationPreview(); await worker.entered;
      let invoked = false, error;
      const queued = new Promise(resolve => route(() => { invoked = true; })(
        { method: 'POST', path: '/syncs' }, {}, value => { error = value; resolve(); }));
      let stopped = false; const shutdown = activity.shutdown().then(() => { stopped = true; });
      await new Promise(r => setImmediate(r)); assert.equal(stopped, false);
      assert.throws(() => preview.requestPreparationPreview(), /stopping/);
      assert.throws(() => activity.beginStart(), /stopping/);
      release(); await queued; await shutdown;
      assert.equal(invoked, false); assert.equal(error.status, 503);
      assert.notEqual(preview.preparationPreview().phase, 'ready');
      assert.equal(getDb().prepare('SELECT COUNT(*) n FROM syncs').get().n, 0);
      assert.equal(require('node:fs').existsSync(worker.workers[0].previewDirectory), false);
      worker.restore(); closeDb();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.resolve(__dirname, '..'), env: process.env, timeout: 10000 });
});

test('POST yields an event-loop turn before the first original input read', async () => {
  session(); await scanSessions();
  const original = store.previewSummaryInput; let reads = 0;
  store.previewSummaryInput = () => { reads++; return original(); };
  try {
    assert.equal(preview.requestPreparationPreview().phase, 'checking');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(reads, 0, 'microtasks alone must not start a corpus read');
    counts(await settled(), 0, 5);
    assert.equal(reads, 0, 'all physical verification is off the main thread');
    assert.equal(worker.events.filter(e => e.previewTest === 'input').length, 1);
    await api();
    let responseFinished = false;
    server.on('request', (_req, res) => res.once('finish', () => { responseFinished = true; }));
    store.previewSummaryInput = () => {
      assert.equal(responseFinished, true, 'HTTP 202 must be written before a corpus read');
      return original();
    };
    process.env.DRAKEN_PI_FINAL_MODEL = 'synthetic/force-fresh-proof';
    assert.equal((await post()).status, 202);
    counts(await settled(), 0, 5);
  } finally { store.previewSummaryInput = original; }
});

test('historical run provenance invalidates proof but progress-only bookkeeping does not', async () => {
  session(); await scanSessions();
  const db = getDb(), sync = store.startSync(); store.discardSync(sync.id);
  const backgroundId = db.prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,input_key)
    VALUES ('synthetic/summary','synthetic/final',10,5,'2026-01-01','synthetic')`).run().lastInsertRowid;
  const runId = db.prepare(`INSERT INTO sync_runs(sync_id,summary_model,final_model,max_invocations,total_entries,started_at)
    VALUES (?,'synthetic/summary','synthetic/final',10,5,'2026-01-01')`).run(sync.id).lastInsertRowid;
  const ready = await verify(); counts(ready, 0, 5);
  for (const table of ['background_runs', 'sync_runs']) {
    db.prepare(`UPDATE ${table} SET stage='Waiting',status='completed',invocations=1,cache_hits=1,error='synthetic'`).run();
    assert.deepEqual(preview.preparationPreview(), ready, table + ' housekeeping must retain checked_at');
  }
  for (const [table, id, values] of [
    ['background_runs', backgroundId, { summary_model: 'synthetic/other', input_key: 'new', source_keys_json: '{"keys":[]}', cache_receipt_json: '[["key","hash"]]', processed_entries: 1, started_at: '2026-01-02', completed_at: '2026-01-03' }],
    ['sync_runs', runId, { summary_model: 'synthetic/other', started_at: '2026-01-02' }],
  ]) {
    for (const [column, value] of Object.entries(values)) {
      db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(value, id);
      assert.equal(preview.preparationPreview().phase, 'stale', table + '.' + column);
      counts(await verify(), 0, 5);
      db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(value, id);
      assert.equal(preview.preparationPreview().phase, 'ready', 'unchanged update');
    }
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    assert.equal(preview.preparationPreview().phase, 'stale', table + ' deletion');
    counts(await verify(), 0, 5);
  }
});

function unchangedTables() {
  const allowed = new Set(['summary_leaf_inputs', 'summary_leaf_plans', 'summary_pending_plans', 'summary_replay_attempts']);
  return getDb().prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").all()
    .filter(row => !allowed.has(row.name)).map(row => [row.name, getDb().prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()]);
}

test('private clone permissions, narrow complete merge, recovered receipts and warm plans retain the actual planner result', async () => {
  session(12); await scanSessions();
  const input = store.previewSummaryInput();
  // An output-only deployed conservative leaf needs a legitimate receipt recovery.
  const tree = SummaryTree.forPreview(input, new AbortController().signal);
  const spec = [...tree.chunkSpecs(false).values()].flat()[0];
  const output = JSON.stringify({ observations: [], limitations: ['Synthetic output-only legacy work.'] });
  getDb().prepare('INSERT INTO summary_cache VALUES (?,?,?,?,?,?)').run(spec.key, 'chunk', input.models.summary, 'sync-tree-v2-short-labels', output, new Date().toISOString());
  const before = unchangedTables();
  const vector = Buffer.from([0, 255, 31, 5, 0, 72]); fs.writeFileSync(root + '/state/history-vector-sentinel', vector);
  instrument({ hold: 'after' }); preview.requestPreparationPreview(); const child = await worker.entered;
  assert.equal(fs.statSync(child.previewDirectory).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(child.previewDirectory)) assert.equal(fs.statSync(path.join(child.previewDirectory, file)).mode & 0o777, 0o600, file);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM summary_leaf_inputs').get().n, 0, 'no partial metadata import');
  worker.release(); counts(await settled(), 12, 0);
  assert.deepEqual(unchangedTables(), before, 'all non-allowlisted rows and cached output bytes unchanged');
  assert.deepEqual(fs.readFileSync(root + '/state/history-vector-sentinel'), vector);
  assert.equal(getDb().prepare('SELECT output_hash FROM summary_leaf_inputs WHERE key=?').get(spec.key).output_hash, require('../dist/sync/normalize').digest(output));
  assert.ok(getDb().prepare('SELECT COUNT(*) n FROM summary_leaf_plans').get().n > 0);
  // Force a genuinely new check without changing the planner scope; receipts
  // must suppress cold archive replay, not just a UI ready-count fast path.
  getDb().prepare("INSERT OR REPLACE INTO sync_settings VALUES ('auto_summary','true')").run();
  instrument({ action: 'noReplay' }); counts(await verify(), 12, 0);
  const direct = SummaryTree.forPreview(store.previewSummaryInput(), new AbortController().signal);
  assert.deepEqual(await direct.previewCounts(), { cached: 12, needs_processing: 0, total: 12 });
});

test('worker crash, planner exception and forbidden clone writes fail safely without any partial merge', async () => {
  session(); await scanSessions(); const before = unchangedTables();
  for (const action of ['crash', 'error', 'write']) {
    instrument({ action });
    const result = await verify(); assert.equal(result.phase, 'unavailable'); assert.equal(result.total, null);
    assert.doesNotMatch(result.error, /sentinel|synthetic|state|jsonl/);
    assert.deepEqual(unchangedTables(), before);
    for (const table of ['summary_leaf_inputs', 'summary_leaf_plans', 'summary_pending_plans', 'summary_replay_attempts']) assert.equal(getDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    assert.equal(fs.existsSync(worker.workers[0].previewDirectory), false);
    assert.equal(activity.previewIdle, true);
  }
});

test('cancelling after completed planning discards all private metadata and waits for worker exit and cleanup', async () => {
  session(); await scanSessions(); instrument({ hold: 'after' });
  preview.requestPreparationPreview(); const child = await worker.entered;
  let exited = false; child.once('exit', () => { exited = true; });
  assert.equal(fs.existsSync(child.previewDirectory), true);
  await activity.drainPreview(); assert.equal(exited, true);
  assert.equal(fs.existsSync(child.previewDirectory), false);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM summary_leaf_plans').get().n, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM summary_pending_plans').get().n, 0);
});

test('backup cancellation drains the real chunked backup before releasing ownership; no worker is launched', async () => {
  session(); await scanSessions();
  const db = getDb(); db.exec('CREATE TABLE synthetic_backup_payload (bytes BLOB); INSERT INTO synthetic_backup_payload VALUES (zeroblob(8388608))');
  const original = db.backup; let completed = false, file, drain;
  db.backup = async function(target, options) {
    file = target;
    try { return await original.call(this, target, { progress(info) { drain ||= activity.drainPreview(); return options.progress(info); } }); }
    finally { completed = true; }
  };
  try {
    preview.requestPreparationPreview();
    while (!drain) await turn();
    await drain;
    assert.equal(completed, true); assert.equal(activity.previewIdle, true);
    assert.equal(fs.existsSync(path.dirname(file)), false); assert.equal(worker.workers.length, 0);
    assert.notEqual(preview.preparationPreview().phase, 'ready');
  } finally { db.backup = original; }
});

test('external SQLite writes, source roots and expired reservations reject worker results before import', async () => {
  session(); await scanSessions();
  for (const mutation of [
    () => { const external = new (require('better-sqlite3'))(root + '/state/draken.db'); try { external.prepare("INSERT OR REPLACE INTO sync_settings VALUES ('external-sentinel','changed')").run(); } finally { external.close(); } },
    () => { process.env.DRAKEN_PI_SESSIONS_DIR += '/different'; },
  ]) {
    instrument({ onResult: mutation }); assert.equal((await verify()).phase, 'stale');
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM summary_leaf_plans').get().n, 0);
  }
  process.env.DRAKEN_PI_SESSIONS_DIR = root + '/sessions';
  const sync = store.startSync(), expires = Date.now() + 200;
  getDb().prepare('UPDATE syncs SET conversation_last_user_at=?,created_at=? WHERE id=?')
    .run(new Date(expires - 30 * 60_000).toISOString(), new Date(expires - 30 * 60_000).toISOString(), sync.id);
  instrument({ hold: 'after' }); preview.requestPreparationPreview(); await worker.entered;
  await new Promise(r => setTimeout(r, Math.max(1, expires - Date.now() + 10))); worker.release();
  assert.equal((await settled()).phase, 'stale');
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM summary_leaf_plans').get().n, 0);
});

test('worker configuration is captured before backup, even when model environment changes and returns during the await', async () => {
  session(); await scanSessions(); receipt(store.previewSummaryInput(), [0, 2]);
  const db = getDb(), backup = db.backup, summary = process.env.DRAKEN_PI_SUMMARY_MODEL;
  db.backup = async function(...args) {
    const value = await backup.apply(this, args);
    process.env.DRAKEN_PI_SUMMARY_MODEL = 'synthetic/transient-model';
    return value;
  };
  instrument({ onResult() { process.env.DRAKEN_PI_SUMMARY_MODEL = summary; } });
  try { counts(await verify(), 2, 3); }
  finally { db.backup = backup; process.env.DRAKEN_PI_SUMMARY_MODEL = summary; }
  const id = db.prepare('SELECT id FROM agent_sessions').get().id;
  db.prepare('UPDATE agent_sessions SET external_id=? WHERE id=?').run('changed-agent-identity', id);
  assert.equal(preview.preparationPreview().phase, 'stale', 'physical external identity is planner-relevant metadata');
});

test('metadata import is atomic on SQL failure, and external write contention never waits on the main loop', async () => {
  session(); await scanSessions(); const db = getDb(), before = unchangedTables();
  db.exec("CREATE TEMP TRIGGER synthetic_import_failure BEFORE INSERT ON summary_pending_plans BEGIN SELECT RAISE(ABORT,'synthetic import failure'); END");
  assert.equal((await verify()).phase, 'unavailable');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM summary_leaf_plans').get().n, 0, 'earlier merge statements rolled back');
  assert.deepEqual(unchangedTables(), before);
  db.exec('DROP TRIGGER synthetic_import_failure');
  const external = new (require('better-sqlite3'))(root + '/state/draken.db');
  let blockedAt;
  instrument({ onResult() { external.exec('BEGIN IMMEDIATE'); blockedAt = performance.now(); } });
  try {
    assert.equal((await verify()).phase, 'unavailable');
    assert.ok(performance.now() - blockedAt < 500, 'merge must fail immediately, not use the app 5-second busy timeout');
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM summary_leaf_plans').get().n, 0);
  } finally { external.exec('ROLLBACK'); external.close(); }
  instrument(); counts(await verify(), 0, 5);
});

test('large synthetic corpus keeps metadata GET/event loop responsive during full physical verification and cancels early', async () => {
  session(2500); await scanSessions(); await api();
  // A large backup as well as many original records: timer probes cover backup,
  // worker planning/final verification, merge, and cleanup, not just HTTP 202.
  getDb().exec('CREATE TABLE synthetic_backup_payload (bytes BLOB); INSERT INTO synthetic_backup_payload VALUES (zeroblob(8388608))');
  let maxDelay = 0, ticks = 0, previous = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - previous); previous = now; ticks++; }, 10);
  try {
    assert.equal((await post()).status, 202);
    const result = await settled(); counts(result, 0, 2500);
    assert.ok(ticks > 10, 'timer stays live throughout corpus work');
    assert.ok(maxDelay < 500, `maximum main event-loop timer gap ${maxDelay.toFixed(1)}ms`);
    console.log(JSON.stringify({ synthetic_entries: 2500, max_event_loop_gap_ms: Math.round(maxDelay), timer_ticks: ticks }));
    getDb().prepare("INSERT OR REPLACE INTO sync_settings VALUES ('auto_summary','true')").run();
    instrument();
    assert.equal((await post()).status, 202);
    while (!worker.events.some(event => event.previewTest === 'input')) await turn();
    // Cancel while the real worker is reading/planning the corpus, not a mocked
    // asynchronous planner promise (or merely the initial 202 flush).
    const getAt = performance.now(), status = await (await fetch(base + '/preparation-preview')).json();
    assert.equal(status.phase, 'checking'); assert.ok(performance.now() - getAt < 500);
    const cancelAt = performance.now(); await activity.drainPreview();
    assert.ok(performance.now() - cancelAt < 1500, 'cancellation terminates synchronous worker work, not merely its promise');
    assert.equal(fs.existsSync(worker.workers[0].previewDirectory), false);
  } finally { clearInterval(timer); }
});

test('reservation expiry is metadata-only invalidation and preview never writes expiry or review', async () => {
  session(); await scanSessions(); const sync = store.startSync(); counts(await verify(), 0, 0);
  const now = Date.now; Date.now = () => now() + 31 * 60_000;
  try {
    assert.equal(preview.preparationPreview().phase, 'stale');
  } finally { Date.now = now; }
  // Advance the real reservation rather than only the parent process's clock;
  // the isolated worker deliberately has its own physical verification time.
  getDb().prepare('UPDATE syncs SET conversation_last_user_at=?,created_at=? WHERE id=?')
    .run(new Date(now() - 31 * 60_000).toISOString(), new Date(now() - 31 * 60_000).toISOString(), sync.id);
  counts(await verify(), 0, 5);
  assert.equal(getDb().prepare('SELECT conversation_ended_at FROM syncs WHERE id=?').get(sync.id).conversation_ended_at, null);
});
