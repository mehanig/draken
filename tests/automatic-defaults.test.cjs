// Synthetic state only. No server timer, source scan, models or real accounts.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { getDb, closeDb } = require('../dist/db/schema');
const { autoIndexSettings } = require('../dist/sync/background');
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-default-auto-')); process.env.DRAKEN_DATA_DIR = root; process.env.DRAKEN_PI_SESSIONS_DIR = root + '/sessions'; });
afterEach(() => { closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
const obsolete = ['auto_prepare_conversations', 'auto_preparing_sync', 'auto_briefing_failed'];
function legacy(settings = []) {
  const db = new Database(path.join(root, 'draken.db'));
  db.exec('CREATE TABLE sync_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  for (const [key, value] of settings) db.prepare('INSERT INTO sync_settings VALUES(?,?)').run(key, value);
  db.close();
}
function noActivity(db) {
  for (const table of ['agent_sessions', 'agent_entries', 'syncs', 'sync_items', 'sync_runs', 'sync_messages', 'sync_coverage', 'live_calls']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
}
function readOnlySettings(expected) {
  const db = getDb(), changes = db.prepare('SELECT total_changes() n').get().n;
  for (let n = 0; n < 3; n++) assert.equal(autoIndexSettings().enabled, expected);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changes, 'settings reads do not migrate, seed or start work');
  for (const key of obsolete) assert.equal(db.prepare('SELECT value FROM sync_settings WHERE key=?').get(key), undefined);
  noActivity(db);
}
test('fresh initialization seeds only canonical auto_index true once; settings reads are read-only', () => {
  const db = getDb();
  assert.deepEqual(db.prepare("SELECT key,value FROM sync_settings WHERE key LIKE 'auto_%'").all(), [{ key: 'auto_index', value: 'true' }]);
  readOnlySettings(true);
  const sources = db.prepare('SELECT id,enabled FROM agent_sources ORDER BY id').all();
  assert.equal(sources.find(s => s.id === 'pi').enabled, 1);
  for (const id of ['codex', 'claude']) assert.equal(sources.find(s => s.id === id).enabled, 0);
  closeDb(); readOnlySettings(true);
});
for (const settings of [
  [], [['auto_index', 'true']], [['auto_index', 'false']],
  [['auto_prepare_conversations', 'false']], [['auto_prepare_conversations', 'true']],
  [['auto_prepare_conversations', 'invalid']],
  [['auto_index', 'true'], ['auto_prepare_conversations', 'false']],
  [['auto_index', 'false'], ['auto_prepare_conversations', 'true']],
  [['auto_index', 'invalid'], ['auto_prepare_conversations', 'true']],
]) {
  test(`canonical preference wins; legacy-only preference migrates across restart: ${JSON.stringify(settings)}`, () => {
    legacy([...settings, ['auto_preparing_sync', '42'], ['auto_briefing_failed', 'Legacy provider failure'], ['unrelated_preference', 'keep me']]);
    const saved = new Map(settings), value = saved.has('auto_index') ? saved.get('auto_index') : saved.get('auto_prepare_conversations');
    for (let n = 0; n < 2; n++) {
      readOnlySettings(value === 'true');
      assert.deepEqual(getDb().prepare("SELECT key,value FROM sync_settings WHERE key LIKE 'auto_%'").all(), value === undefined ? [] : [{ key: 'auto_index', value }]);
      assert.equal(getDb().prepare("SELECT value FROM sync_settings WHERE key='unrelated_preference'").get().value, 'keep me');
      closeDb();
    }
  });
}
test('an older nonempty database without sync settings stays off and is never seeded on restart', () => {
  const old = new Database(path.join(root, 'draken.db'));
  old.exec("CREATE TABLE sqliteX_prior_data(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO sqliteX_prior_data VALUES(1,'keep me')"); old.close();
  for (let n = 0; n < 2; n++) {
    readOnlySettings(false);
    assert.equal(getDb().prepare('SELECT note FROM sqliteX_prior_data').get().note, 'keep me');
    assert.equal(getDb().prepare("SELECT COUNT(*) n FROM sync_settings WHERE key LIKE 'auto_%'").get().n, 0);
    closeDb();
  }
});
