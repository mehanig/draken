require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { getDb, closeDb, initSchema } = require('../dist/db/schema');
const lifecycle = require('../dist/sync/conversation'), store = require('../dist/sync/store');
const { activity } = require('../dist/sync/activity');
const memory = require('../dist/memory/service');
let root, clock, originalNow, originalReady, originalStatus;
const IDLE = 30 * 60_000;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-conversation-'));
  process.env.DRAKEN_DATA_DIR = root;
  process.env.DRAKEN_PI_SESSIONS_DIR = path.join(root, 'sessions');
  originalNow = Date.now; clock = originalNow(); Date.now = () => clock;
  originalReady = memory.historyReadiness; originalStatus = memory.historyPreparationStatus;
  memory.historyPreparationStatus = () => memory.historyReadiness(true);
  memory.historyReadiness = () => ({ ready: false, before: null });
});
afterEach(() => { Date.now = originalNow; memory.historyReadiness = originalReady; memory.historyPreparationStatus = originalStatus; closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
function sync() {
  return Number(getDb().prepare('INSERT INTO syncs(created_at,snapshot_at,snapshot_version) VALUES (?,?,2)').run(new Date(clock).toISOString(), new Date(clock).toISOString()).lastInsertRowid);
}
const persisted = id => getDb().prepare('SELECT * FROM syncs WHERE id=?').get(id);

test('exact idle deadline is metadata-only until cleanup, never review or transcript deletion', () => {
  const id = sync(), db = getDb(), original = lifecycle.conversationStatus(id);
  db.prepare("INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES (?,'assistant','A later generated answer',?)").run(id, new Date(clock + IDLE - 1).toISOString());
  store.saveNotes(id, 'Keep decision', 'Keep carry forward');
  clock += IDLE - 1;
  assert.equal(lifecycle.conversationStatus(id).ended_at, null);
  for (let n = 0; n < 3; n++) { store.homeOverview(); store.overview(); store.getProgress(id); }
  assert.equal(lifecycle.conversationStatus(id).last_user_at, original.last_user_at);
  clock++;
  const changes = db.prepare('SELECT total_changes() n').get().n;
  assert.equal(lifecycle.conversationStatus(id).ended_at, original.expires_at);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changes, 'Polling does not persist expiry');
  assert.equal(persisted(id).conversation_ended_at, null);
  lifecycle.expireConversations();
  const ended = persisted(id);
  assert.equal(ended.status, 'open'); assert.equal(ended.completed_at, null);
  assert.equal(ended.decisions, 'Keep decision'); assert.equal(ended.carry_forward, 'Keep carry forward');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_messages').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
  assert.equal(store.homeOverview().syncs[0].conversation.ended_at, original.expires_at);
  assert.equal(store.overview().active_sync_id, null);
  store.saveNotes(id, 'Edited after ending', 'Intact');
  assert.equal(persisted(id).decisions, 'Edited after ending');
  assert.throws(() => lifecycle.touchConversation(id), error => error.status === 410 && /new sync/.test(error.message));
  closeDb();
  assert.equal(lifecycle.conversationStatus(id).ended_at, original.expires_at);
  assert.throws(() => lifecycle.assertConversationActive(id), error => error.status === 410);
});

test('in-flight response and real voice turn defer expiry; idle connected calls and unrelated jobs do not', () => {
  const id = sync(), other = sync(), release = activity.beginJob(id, new AbortController());
  try {
    clock += IDLE;
    lifecycle.expireConversations();
    assert.equal(lifecycle.conversationStatus(id).ended_at, null);
    assert.ok(lifecycle.conversationStatus(other).ended_at, 'Another conversation cannot borrow this response lease');
  } finally { release(); }
  lifecycle.expireConversations(); assert.ok(persisted(id).conversation_ended_at);
  const spoken = sync(), call = activity.beginCall(spoken); call.connected(); const turn = call.beginTurn();
  try {
    clock += IDLE; lifecycle.expireConversations(); assert.equal(persisted(spoken).conversation_ended_at, null);
    turn(); lifecycle.expireConversations(); assert.ok(persisted(spoken).conversation_ended_at);
    assert.equal(activity.callActive, true, 'Connection is not user activity');
  } finally { turn(); call(); }
});

test('history is explicitly prepared once and adopted only on real turn admission', () => {
  const id = sync(), first = new Date(clock - 1000).toISOString(), next = new Date(clock).toISOString();
  memory.historyReadiness = () => ({ ready: true, before: first });
  assert.equal(lifecycle.captureConversationHistory(id), null, 'Another ready corpus cannot prepare a new conversation');
  lifecycle.markConversationPrepared(id, first);
  memory.historyReadiness = () => ({ ready: true, before: next });
  const clockBefore = lifecycle.conversationStatus(id).last_user_at;
  assert.equal(lifecycle.conversationStatus(id).history_before, first);
  assert.equal(lifecycle.conversationStatus(id).available_before, next);
  assert.equal(lifecycle.conversationStatus(id).update_state, 'new_info');
  lifecycle.markConversationPrepared(id, next); assert.equal(persisted(id).conversation_before, first);
  assert.equal(lifecycle.captureConversationHistory(id), next);
  memory.historyReadiness = () => ({ ready: false, before: null });
  assert.equal(lifecycle.captureConversationHistory(id), next, 'Updating/unavailable history retains the last known cutoff');
  assert.equal(lifecycle.conversationStatus(id).last_user_at, clockBefore, 'Preparation and cutoff adoption never touch the clock');
  clock += 1000; lifecycle.touchConversation(id);
  assert.equal(lifecycle.conversationStatus(id).last_user_at, new Date(clock).toISOString());
  closeDb(); assert.equal(lifecycle.conversationStatus(id).history_before, next);
});

test('expired sessions reject paid generation/preparation without creating a run', async () => {
  const id = sync(); clock += IDLE;
  const manager = require('../dist/sync/manager'), preparation = require('../dist/sync/preparation');
  assert.throws(() => manager.launchChat(id, 'Continue', '12345678-1234-1234-1234-123456789012'), error => error.status === 410);
  assert.throws(() => manager.launchReply(id), error => error.status === 410);
  await assert.rejects(manager.generateReply(id), error => error.status === 410);
  assert.throws(() => preparation.prepareCall(id), error => error.status === 410);
  assert.equal(preparation.callReadiness(id, true).ready, false);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sync_runs').get().n, 0);
});

test('text and voice readiness retain durable preparation despite new evidence, but never prepare on GET', () => {
  const { callReadiness } = require('../dist/sync/preparation');
  const id = sync(), fresh = sync(), first = new Date(clock - 1000).toISOString(), next = new Date(clock).toISOString();
  getDb().prepare("UPDATE syncs SET briefing='Prepared briefing', compression_complete=1").run();
  lifecycle.markConversationPrepared(id, first);
  for (const latest of [{ ready: false, before: null }, { ready: true, before: next }]) {
    memory.historyReadiness = () => latest;
    const changes = getDb().prepare('SELECT total_changes() n').get().n, saved = persisted(id);
    for (const captured of [false, true]) {
      const ready = callReadiness(id, captured);
      assert.equal(ready.ready, true); assert.equal(ready.historyReady, true); assert.equal(ready.before, first);
      assert.equal(callReadiness(fresh, captured).ready, false, 'A global receipt cannot initialize either mode');
    }
    assert.deepEqual(persisted(id), saved);
    assert.equal(getDb().prepare('SELECT total_changes() n').get().n, changes);
  }
  closeDb(); memory.historyReadiness = () => ({ ready: false, before: null });
  assert.equal(callReadiness(id).before, first, 'Durable/fallback preparation survives restart and unavailable global history');
  const release = activity.beginJob(id, new AbortController());
  try { assert.equal(callReadiness(id).ready, false); } finally { release(); }
  const voice = activity.beginCall(id);
  try { assert.equal(callReadiness(id).ready, false); } finally { voice(); }
  clock += IDLE;
  assert.equal(callReadiness(id).ready, false);
});

test('update metadata reports recorded availability and scheduler progress, not full-history verification', () => {
  const bridge = require('../dist/sync/update-status');
  const id = sync(), first = new Date(clock - 1000).toISOString(), next = new Date(clock).toISOString();
  lifecycle.markConversationPrepared(id, first);
  let strict = true, available = first, state = { phase: 'waiting', error: '', pending_records: 0 }, reads = [];
  memory.historyReadiness = captured => { reads.push(Boolean(captured)); return { ready: captured || strict, before: captured || strict ? available : null }; };
  const unregister = bridge.registerUpdateStatus(() => state), progress = memory.historyProgress;
  const saved = persisted(id), changes = getDb().prepare('SELECT total_changes() n').get().n;
  const check = expected => { reads = []; assert.equal(lifecycle.conversationStatus(id).update_state, expected); };
  try {
    check('up_to_date'); assert.deepEqual(reads, [true]);
    strict = false; check('up_to_date');
    available = next; check('new_info'); assert.deepEqual(reads, [true], 'No unnecessary strict query');
    state = { phase: 'indexing', error: '', pending_records: 1 }; check('new_info');
    available = first; strict = true; check('preparing');
    state = { phase: 'waiting', error: '', pending_records: 1 }; check('preparing');
    state = { phase: 'summarizing', error: '', pending_records: 0 }; check('up_to_date');
    memory.historyProgress = () => ({ active: true, queued: 0, work: { stage: 'searching' } }); check('up_to_date');
    memory.historyProgress = () => ({ active: true, queued: 0, work: { stage: 'indexing' } }); check('preparing');
    state = { phase: 'error', error: 'PRIVATE /source/path provider details', pending_records: 1 }; check('error');
    assert.doesNotMatch(lifecycle.conversationStatus(id).error, /PRIVATE|source\/path|provider details/);
    state.phase = 'paused'; check('error');
    assert.deepEqual(persisted(id), saved);
    assert.equal(getDb().prepare('SELECT total_changes() n').get().n, changes, 'All metadata polls are read-only');
    getDb().prepare("UPDATE sync_settings SET value='false' WHERE key='auto_index'").run(); check('paused');
    assert.equal(lifecycle.conversationStatus(id).error, '');
    getDb().prepare("UPDATE sync_settings SET value='true' WHERE key='auto_index'").run();
    getDb().prepare("UPDATE syncs SET status='completed' WHERE id=?").run(id); check('paused');
    getDb().prepare("UPDATE syncs SET status='open' WHERE id=?").run(id); clock += IDLE; check('paused');
  } finally { unregister(); memory.historyProgress = progress; }
  assert.equal(bridge.backgroundUpdateStatus(), null);
});

test('production background status reports failure, recovery and opt-out without GETs doing work', async t => {
  const background = require('../dist/sync/background'), bridge = require('../dist/sync/update-status');
  const collector = require('../dist/sync/collector'), stamps = require('../dist/memory/stamps');
  const summary = require('../dist/sync/summary-preparation');
  const id = sync(), first = new Date(clock - 1000).toISOString(), next = new Date(clock).toISOString();
  lifecycle.markConversationPrepared(id, first);
  let strict = true, cutoff = first, scans = 0, prepares = 0, rejectPrepare, resolvePrepare;
  memory.historyReadiness = captured => ({ ready: captured || strict, before: cutoff });
  t.mock.method(collector, 'scanSessions', async () => { scans++; return { warnings: [] }; });
  t.mock.method(stamps, 'sourceStamps', () => new Map([['synthetic', 'changed']]));
  t.mock.method(stamps, 'loadSourceCheckpoint', () => new Map());
  t.mock.method(summary, 'warmSummaryCache', async () => {});
  t.mock.method(memory, 'prepareHistory', () => { prepares++; return new Promise((resolve, reject) => { resolvePrepare = resolve; rejectPrepare = reject; }); });
  const until = async predicate => { for (let n = 0; n < 100 && !predicate(); n++) await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate()); };
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    assert.equal(bridge.backgroundUpdateStatus(), null);
    background.startBackgroundIndexing();
    assert.ok(bridge.backgroundUpdateStatus());
    assert.equal(lifecycle.conversationStatus(id).update_state, 'up_to_date');
    background.setAutoIndex(false);
    assert.equal(lifecycle.conversationStatus(id).update_state, 'paused', 'Old valid receipt cannot hide opt-out');
    background.setAutoIndex(true); strict = false;
    assert.equal(lifecycle.conversationStatus(id).update_state, 'up_to_date', 'Until the scheduler detects work, status reports the last completed checkpoint');
    clock += 60_000; t.mock.timers.tick(60_000); await until(() => prepares === 1);
    assert.equal(bridge.backgroundUpdateStatus().phase, 'indexing');
    assert.equal(lifecycle.conversationStatus(id).update_state, 'preparing');
    rejectPrepare(Error('PRIVATE /original/session failure'));
    await until(() => background.autoIndexSettings().summary.error_count === 1);
    const saved = persisted(id), changes = getDb().prepare('SELECT total_changes() n').get().n;
    for (let n = 0; n < 3; n++) {
      const status = lifecycle.conversationStatus(id);
      assert.equal(status.update_state, 'preparing'); assert.equal(status.error,'');assert.equal(background.autoIndexSettings().phase,'waiting');
    }
    assert.equal(scans, 1); assert.equal(prepares, 1, 'Polling never retries work');
    assert.deepEqual(persisted(id), saved); assert.equal(getDb().prepare('SELECT total_changes() n').get().n, changes);
    background.setAutoIndex(true); clock += 60_000; t.mock.timers.tick(60_000); await until(() => prepares === 2);
    strict = true; cutoff = next; resolvePrepare(); await until(() => background.autoIndexSettings().phase === 'waiting');
    assert.equal(lifecycle.conversationStatus(id).update_state, 'new_info');
    assert.deepEqual(persisted(id), saved, 'Background completion and GET do not adopt or touch the clock');
    const stopping = background.stopBackgroundIndexing(); background.startBackgroundIndexing(); await stopping;
    assert.ok(bridge.backgroundUpdateStatus());
    await background.stopBackgroundIndexing(); assert.equal(bridge.backgroundUpdateStatus(), null);
  } finally { resolvePrepare?.(); await background.stopBackgroundIndexing(); t.mock.timers.reset(); }
});

test('home/overview share lazy global metadata per response, never across requests or closed cards', () => {
  const db = getDb(), first = new Date(clock - 1000).toISOString();
  for (let n = 0; n < 55; n++) lifecycle.markConversationPrepared(sync(), first);
  let reads = [], progressReads = 0, backgroundReads = 0, ready = true;
  memory.historyReadiness = captured => { reads.push(Boolean(captured)); return { ready, before: ready ? first : null }; };
  const progress = memory.historyProgress;
  memory.historyProgress = () => { progressReads++; return { active: false, queued: 0 }; };
  const unregister = require('../dist/sync/update-status').registerUpdateStatus(() => { backgroundReads++; return { phase: 'waiting', error: '', pending_records: 0 }; });
  const saved = db.prepare('SELECT * FROM syncs').all(), changes = db.prepare('SELECT total_changes() n').get().n;
  try {
    for (const [view, count] of [[store.homeOverview, 20], [store.overview, 50]]) {
      for (let n = 0; n < 2; n++) {
        reads = []; progressReads = backgroundReads = 0;
        const cards = view().syncs; assert.equal(cards.length, count);
        assert.ok(cards.every(card => card.conversation.update_state === 'up_to_date'));
        assert.deepEqual(reads, [true]); assert.equal(progressReads, 1); assert.equal(backgroundReads, 1);
      }
    }
    ready = false; reads = [];
    assert.ok(store.overview().syncs.every(card => card.conversation.update_state === 'preparing' && card.conversation.available_before === null));
    assert.deepEqual(reads, [true], 'A fresh response rechecks readiness without an unnecessary strict check');
    assert.deepEqual(db.prepare('SELECT * FROM syncs').all(), saved);
    assert.equal(db.prepare('SELECT total_changes() n').get().n, changes, 'No expiry, cutoff adoption or lifecycle writes');
    db.exec("UPDATE syncs SET status='completed' WHERE id%2=0"); clock += IDLE;
    reads = []; progressReads = backgroundReads = 0;
    for (const view of [store.homeOverview, store.overview]) {
      assert.ok(view().syncs.every(card => card.conversation.update_state === 'paused' && card.conversation.available_before === null));
    }
    assert.deepEqual(reads, []); assert.equal(progressReads, 0); assert.equal(backgroundReads, 0);
  } finally { memory.historyProgress = progress; unregister(); }
});

test('status bridge replacement cleanup cannot remove the current owner', () => {
  const bridge = require('../dist/sync/update-status');
  const old = bridge.registerUpdateStatus(() => ({ phase: 'error', error: 'old', pending_records: 1 }));
  const replacement = bridge.registerUpdateStatus(() => ({ phase: 'waiting', error: '', pending_records: 0 }));
  old(); assert.equal(bridge.backgroundUpdateStatus().phase, 'waiting');
  replacement(); assert.equal(bridge.backgroundUpdateStatus(), null);
});

test('upgrade seeds user activity only and preserves previously used chat preparation', () => {
  const db = new Database(':memory:');
  try {
    initSchema(db);
    db.exec('ALTER TABLE syncs DROP COLUMN conversation_last_user_at; ALTER TABLE syncs DROP COLUMN conversation_ended_at; ALTER TABLE syncs DROP COLUMN conversation_before;');
    db.prepare("INSERT INTO syncs(id,created_at,snapshot_at,briefing,compression_complete) VALUES (1,'2026-01-01','2026-01-01','Initial briefing',1)").run();
    db.prepare("INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES (1,'user','Question','2026-01-02'),(1,'assistant','Reply','2026-01-05')").run();
    db.prepare("INSERT INTO live_calls(id,sync_id,started_at) VALUES ('call',1,'2026-01-03')").run();
    db.prepare("INSERT INTO live_messages(call_id,request_id,role,text,started_at) VALUES ('call','user','user','Spoken question','2026-01-03'),('call','assistant','assistant','Output','2026-01-06')").run();
    db.prepare("INSERT INTO syncs(id,status,created_at,completed_at,decisions) VALUES (2,'completed','2026-01-01','2026-01-02','Explicit review')").run();
    initSchema(db);
    const migrated = db.prepare('SELECT * FROM syncs WHERE id=1').get();
    assert.equal(migrated.conversation_last_user_at, '2026-01-03'); assert.equal(migrated.conversation_before, '2026-01-01');
    assert.equal(migrated.status, 'open'); assert.equal(migrated.briefing, 'Initial briefing');
    const closed = db.prepare('SELECT * FROM syncs WHERE id=2').get();
    assert.equal(closed.conversation_last_user_at, null); assert.equal(closed.status, 'completed'); assert.equal(closed.decisions, 'Explicit review');
    db.prepare("UPDATE syncs SET conversation_ended_at='2026-01-03T00:30:00.000Z' WHERE id=1").run(); initSchema(db);
    assert.equal(db.prepare('SELECT conversation_ended_at FROM syncs WHERE id=1').get().conversation_ended_at, '2026-01-03T00:30:00.000Z');
  } finally { db.close(); }
});
