const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { getDb, closeDb } = require('../dist/db/schema');
const { getDataDir } = require('../dist/data-dir');
const { scanSessions } = require('../dist/sync/collector');
const store = require('../dist/sync/store');
const policy = require('../dist/sources/activity-window');
const { activityMetadata } = require('../dist/sources/activity-metadata');
const { identifySource } = require('../dist/sources/adapters');
const { fileRecords } = require('../dist/sync/jsonl');
const { HistoryIndex } = require('../dist/memory/index');
const { historyStamp } = require('../dist/memory/readiness');
const { createApp } = require('../dist/server');
const { stopBackgroundIndexing } = require('../dist/sync/background');
let root, db, server, cache;
const at = days => new Date(Date.now() - days * 86400000).toISOString();
const msg = (id, parentId, timestamp, content = 'Tests passed; deployment remains unverified.') => ({ type: 'message', id, parentId, timestamp, message: { role: 'assistant', content } });
function session(id, times) {
  const file = path.join(root, 'sessions', id + '.jsonl');
  fs.writeFileSync(file, [{ type: 'session', version: 3, id, cwd: '/synthetic/' + id }, ...times.map((time, n) => msg('m' + n, n ? 'm' + (n - 1) : null, time))].map(JSON.stringify).join('\n') + '\n');
  return file;
}
const days = value => db.prepare("INSERT OR REPLACE INTO sync_settings VALUES('activity_days',?)").run(JSON.stringify(value));
async function scan() { assert.deepEqual((await scanSessions()).warnings, []); }
async function http() {
  server = createApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return (suffix = '', body) => fetch(`http://127.0.0.1:${server.address().port}/api/settings/activity-window${suffix}`, { method: body ? 'PATCH' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
beforeEach(() => {
  closeDb(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-activity-')); fs.mkdirSync(root + '/sessions');
  Object.assign(process.env, { DRAKEN_DATA_DIR: root + '/state', DRAKEN_PI_SESSIONS_DIR: root + '/sessions', DRAKEN_PI_BIN: '/no-provider-allowed', DRAKEN_PI_SUMMARY_MODEL: 'test/cheap', DRAKEN_PI_FINAL_MODEL: 'test/strong', DRAKEN_HOST: '127.0.0.1', DRAKEN_NO_AUTH: 'true' });
  assert.equal(getDataDir(), root + '/state'); db = getDb(); assert.equal(db.name, root + '/state/draken.db');
  db.prepare("UPDATE sync_settings SET value='false' WHERE key='auto_index'").run();
});
afterEach(async () => { await stopBackgroundIndexing(); if (server) await new Promise(resolve => server.close(resolve)); server = undefined; cache?.close(); cache = undefined; closeDb(); fs.rmSync(root, { recursive: true, force: true }); });

test('seven-day default uses session messages, not mtime; recent sessions keep their old messages', async () => {
  const old = session('old', [at(90), at(30)]); fs.utimesSync(old, new Date(), new Date());
  session('recent', [at(90), at(1)]);
  assert.equal(policy.activityDays(db), 7); await scan();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_entries WHERE session_id='old'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_entries WHERE session_id='recent'").get().n, 2);
  assert.equal(store.pendingCount(), 2);
  const rows = store.overview().sessions;
  assert.equal(rows.find(s => s.id === 'old').within_activity_window, false);
  assert.ok(rows.find(s => s.id === 'old').last_message_preview.includes('deployment remains unverified'));
  assert.equal(rows.find(s => s.id === 'recent').within_activity_window, true);
  assert.equal(store.startSync().items.length, 2);
});

test('old-session inspection reads the edges and does not import the middle; new activity admits the whole session', async () => {
  const file = session('large', [at(90)]);
  for (let n = 1; n <= 100; n++) fs.appendFileSync(file, JSON.stringify(msg('m' + n, 'm' + (n - 1), at(30), 'x'.repeat(20000))) + '\n');
  const handle = await fs.promises.open(file, 'r');
  try {
    const size = fs.statSync(file).size, header = identifySource('pi', fileRecords(handle.fd, 65536));
    let bytes = 0; const original = handle.read.bind(handle); handle.read = async (...args) => { const result = await original(...args); bytes += result.bytesRead; return result; };
    const metadata = await activityMetadata(handle, size, header);
    assert.ok(metadata.last_message_at); assert.ok(bytes < size / 4, 'tail probe must not read the whole old transcript');
  } finally { await handle.close(); }
  await scan(); assert.equal(store.pendingCount(), 0);
  const read = fs.readSync;
  fs.readSync = () => { throw new Error('Unchanged ignored sessions must not read transcript bytes'); };
  try { await scan(); } finally { fs.readSync = read; }
  fs.appendFileSync(file, JSON.stringify(msg('new', 'm100', at(0))) + '\n');
  await scan(); assert.equal(store.pendingCount(), 102);
});

test('an append during the activity probe waits for the next scan without failing the captured prefix', async () => {
  const file = session('growing', [at(20)]), metadata = require('../dist/sources/activity-metadata');
  const original = metadata.activityMetadata;
  metadata.activityMetadata = async (...args) => { const result = await original(...args); fs.appendFileSync(file, JSON.stringify(msg('new', 'm0', at(0))) + '\n'); return result; };
  try { await scan(); assert.equal(store.pendingCount(), 0); }
  finally { metadata.activityMetadata = original; }
  await scan(); assert.equal(store.pendingCount(), 2);
});

test('compaction and file touches do not reactivate old work; partial final messages are ignored', async () => {
  const file = session('compacted', [at(30)]);
  fs.appendFileSync(file, JSON.stringify({ type: 'compaction', id: 'c', parentId: 'm0', timestamp: at(0), firstKeptEntryId: 'm0', summary: 'Old work.' }) + '\n');
  fs.appendFileSync(file, JSON.stringify(msg('partial', 'c', at(0))));
  await scan(); assert.equal(store.pendingCount(), 0);
  fs.appendFileSync(file, '\n'); await scan(); assert.equal(store.pendingCount(), 2);
});

test('Codex and Claude activity uses messages, not compaction timestamps', async () => {
  for (const agent of ['codex', 'claude']) { fs.mkdirSync(path.join(root, agent)); process.env[agent === 'codex' ? 'DRAKEN_CODEX_SESSIONS_DIR' : 'DRAKEN_CLAUDE_SESSIONS_DIR'] = path.join(root, agent); store.setAgentEnabled(agent, true); }
  const old = at(20), recent = at(1);
  fs.writeFileSync(path.join(root, 'codex', 'session.jsonl'), [
    { type: 'session_meta', timestamp: old, payload: { id: 'codex-window', cwd: '/synthetic/codex' } },
    { type: 'response_item', timestamp: old, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Old Codex work.' }] } },
    { type: 'compacted', timestamp: at(0), payload: { message: 'Old Codex summary.' } },
  ].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'claude', 'session.jsonl'), [
    { type: 'user', uuid: 'u', sessionId: 'claude-window', cwd: '/synthetic/claude', timestamp: old, message: { role: 'user', content: 'Earlier Claude request.' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', sessionId: 'claude-window', timestamp: recent, message: { role: 'assistant', content: 'Recent Claude reply.' } },
    { type: 'user', uuid: 'summary', parentUuid: 'a', sessionId: 'claude-window', timestamp: at(0), isCompactSummary: true, message: { role: 'user', content: 'Compacted context.' } },
  ].map(JSON.stringify).join('\n') + '\n');
  await scan(); const sessions = store.overview().sessions;
  assert.equal(sessions.find(row => row.agent === 'codex').last_message_at, old);
  assert.equal(sessions.find(row => row.agent === 'codex').within_activity_window, false);
  assert.equal(sessions.find(row => row.agent === 'claude').last_message_at, recent);
  assert.equal(sessions.find(row => row.agent === 'claude').last_message_preview, 'Recent Claude reply.');
  assert.equal(store.pendingCount(), 2);
});

test('widening previews are read-only and manual exclusions survive window changes', async () => {
  session('old', [at(20)]); session('excluded', [at(20)]); await scan(); store.setIncluded('excluded', false);
  const before = db.prepare('SELECT total_changes() n').get().n;
  const preview = policy.activityWindowStatus(db, 30); assert.equal(preview.additional_sessions, 1); assert.equal(preview.confirmation_required, true);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before); assert.equal(policy.activityDays(db), 7);
  days(30); await scan(); assert.equal(store.pendingCount(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_entries WHERE session_id='excluded'").get().n, 0);
  days(1); assert.equal(store.pendingCount(), 0); days(null); assert.equal(store.pendingCount(), 1);
  assert.equal(db.prepare("SELECT included FROM agent_sessions WHERE id='excluded'").get().included, 0);
});

test('HTTP requires current confirmation before widening; rejects invalid values and preserves opt-outs', async () => {
  session('old', [at(20)]); await scan(); const request = await http();
  db.prepare("INSERT INTO sync_settings VALUES('auto_summary','false')").run();
  db.prepare("INSERT INTO sync_settings VALUES('auto_summary_error','Saved provider failure')").run();
  const preview = await (await request('?days=30')).json(); assert.equal(preview.days, 7); assert.equal(preview.additional_sessions, 1);
  assert.equal((await request('', { days: 30 })).status, 409); assert.equal(policy.activityDays(db), 7);
  for (const value of [0, -1, 1.5, '30', true, 36501]) assert.equal((await request('', { days: value })).status, 400);
  store.setIncluded('old', false);
  assert.equal((await request('', { days: 30, confirmation: preview.confirmation })).status, 409);
  const fresh = await (await request('?days=30')).json();
  assert.equal((await request('', { days: 30, confirmation: fresh.confirmation })).status, 200);
  assert.equal(policy.activityDays(db), 30);
  assert.equal(db.prepare("SELECT value FROM sync_settings WHERE key='auto_index'").get().value, 'false');
  assert.equal((await request('', { days: 1 })).status, 200); assert.equal(policy.activityDays(db), 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_runs').get().n, 0);
  assert.equal(db.prepare("SELECT value FROM sync_settings WHERE key='auto_summary'").get().value, 'false');
  assert.equal(db.prepare("SELECT value FROM sync_settings WHERE key='auto_summary_error'").get().value, 'Saved provider failure');
  const release = require('../dist/sync/activity').activity.beginJob(999, new AbortController());
  try { assert.equal((await request('', { days: 1 })).status, 409); assert.equal(policy.activityDays(db), 1); }
  finally { release(); }
});

test('narrowing skips old preparation and search but preserves vectors and explicitly opened historical citations', async () => {
  const file = session('old', [at(20)]); session('recent', [at(1)]); days(null); await scan();
  cache = new Database(':memory:'); let embeddings = 0;
  const model = { fingerprint: 'activity-fixture', ready: () => true, setup: async () => {}, embed: async () => { embeddings++; const v = new Float32Array(384); v[0] = 1; return v; } };
  const index = new HistoryIndex(cache, db, model); await index.prepare();
  const ref = cache.prepare("SELECT ref FROM records WHERE session_id='old'").get().ref;
  const vectors = cache.prepare('SELECT rowid,embedding FROM passage_vectors ORDER BY rowid').all();
  const original = fs.readSync; let oldReads = 0;
  days(7);
  fs.readSync = function(fd, ...args) { try { if (fs.readlinkSync('/proc/self/fd/' + fd) === file) oldReads++; } catch {} return original.call(this, fd, ...args); };
  try { await index.prepare(); } finally { fs.readSync = original; }
  assert.equal(oldReads, 0); assert.deepEqual(cache.prepare('SELECT rowid,embedding FROM passage_vectors ORDER BY rowid').all(), vectors);
  assert.equal(cache.prepare('SELECT COUNT(*) n FROM records WHERE ref=?').get(ref).n, 1);
  const result = await index.search({ question: 'deployment', kind: 'sources' }, undefined, true);
  assert.ok(result.results.every(item => item.session_id !== 'old'));
  assert.ok((await index.read(ref)).record.text.includes('deployment'));
  const count = embeddings; days(null); await scan(); await index.prepare(); assert.equal(embeddings, count);
  store.setIncluded('old', false); await assert.rejects(async () => index.read(ref), /unavailable|prepared|no longer admitted/);
});

test('the summary worker skips old sessions before model requests and processes only recent work', async () => {
  const fake = path.join(root, 'pi'), log = path.join(root, 'calls.jsonl');
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-pi.cjs'), fake); fs.chmodSync(fake, 0o700);
  process.env.DRAKEN_PI_BIN = fake; process.env.DRAKEN_TEST_CALL_LOG = log; delete process.env.DRAKEN_FAKE_CONTROL;
  db.prepare("UPDATE sync_settings SET value='true' WHERE key='auto_index'").run();
  session('old', [at(90), at(20)]); await scan();
  const { warmSummaryCache } = require('../dist/sync/summary-preparation');
  await warmSummaryCache(new AbortController().signal); assert.equal(fs.existsSync(log), false);
  session('recent', [at(20), at(1)]); await scan();
  await warmSummaryCache(new AbortController().signal);
  assert.ok(fs.existsSync(log)); assert.ok(!fs.readFileSync(log, 'utf8').includes('/synthetic/old'));
  assert.equal(db.prepare("SELECT total_entries FROM background_runs WHERE status='completed'").get().total_entries, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM syncs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});

test('an old unfinished snapshot cannot bypass the window or read originals before preparing', async () => {
  const file = session('old', [at(20)]); days(null); await scan(); const sync = store.startSync(); days(7);
  const original = fs.readSync; let reads = 0;
  fs.readSync = function(fd, ...args) { try { if (fs.readlinkSync('/proc/self/fd/' + fd) === file) reads++; } catch {} return original.call(this, fd, ...args); };
  try { await assert.rejects(require('../dist/sync/manager').generateReply(sync.id), /outside the activity window/); }
  finally { fs.readSync = original; }
  assert.equal(reads, 0); assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_runs').get().n, 0);
  assert.equal(store.getSync(sync.id, false).status, 'open');
});

test('clock expiry changes readiness without deleting data or changing manual selection', async () => {
  session('session', [at(1)]); await scan();
  db.prepare("UPDATE agent_sessions SET last_message_at=? WHERE id='session'").run(new Date(Date.now() - 7 * 86400000 + 2000).toISOString());
  const first = historyStamp(db), changes = db.prepare('SELECT total_changes() n').get().n;
  assert.equal(store.pendingCount(), 1); await new Promise(resolve => setTimeout(resolve, 2200));
  assert.notEqual(historyStamp(db), first); assert.equal(db.prepare('SELECT total_changes() n').get().n, changes); assert.equal(store.pendingCount(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_entries').get().n, 1);
  assert.equal(db.prepare('SELECT included FROM agent_sessions').get().included, 1);
});
