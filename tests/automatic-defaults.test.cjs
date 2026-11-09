// Synthetic state only. No server timer, source scan, models or real accounts.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { getDb, closeDb } = require('../dist/db/schema');
const { autoIndexSettings } = require('../dist/memory/automatic');
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-default-auto-')); process.env.DRAKEN_DATA_DIR = root; process.env.DRAKEN_PI_SESSIONS_DIR = root + '/sessions'; });
afterEach(() => { closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
function legacy(settings = []) {
  const db = new Database(path.join(root, 'draken.db'));
  db.exec('CREATE TABLE sync_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  for (const [key, value] of settings) db.prepare('INSERT INTO sync_settings VALUES(?,?)').run(key, value);
  db.close();
}
function noActivity(db) {
  for (const table of ['agent_sessions', 'agent_entries', 'syncs', 'sync_runs', 'sync_messages', 'sync_coverage', 'live_calls']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
}
test('fresh initialization persists the combined default once; settings reads start no work or writes', () => {
  const db = getDb();
  for (const key of ['auto_index', 'auto_prepare_conversations']) assert.equal(db.prepare('SELECT value FROM sync_settings WHERE key=?').get(key).value, 'true');
  const changes = db.prepare('SELECT total_changes() n').get().n;
  for (let n = 0; n < 3; n++) assert.equal(autoIndexSettings().enabled, true);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changes); noActivity(db);
  const sources = db.prepare('SELECT id,enabled FROM agent_sources ORDER BY id').all();
  assert.equal(sources.find(s => s.id === 'pi').enabled, 1);
  for (const id of ['codex', 'claude']) assert.equal(sources.find(s => s.id === id).enabled, 0);
  closeDb(); assert.equal(autoIndexSettings().enabled, true); noActivity(getDb());
});
for (const settings of [[], [['auto_index', 'true']], [['auto_index', 'false']], [['auto_prepare_conversations', 'false']], [['auto_prepare_conversations', 'true']], [['auto_index', 'true'], ['auto_prepare_conversations', 'false']], [['auto_prepare_conversations', 'invalid']], [['auto_index', 'false'], ['auto_prepare_conversations', 'true']]]) {
  test(`existing preference is preserved across upgrade/restart: ${JSON.stringify(settings)}`, () => {
    legacy(settings); const expected = settings.some(([key, value]) => key === 'auto_prepare_conversations' && value === 'true');
    for (let n = 0; n < 2; n++) {
      assert.equal(autoIndexSettings().enabled, expected);
      assert.deepEqual(getDb().prepare("SELECT key,value FROM sync_settings WHERE key IN ('auto_index','auto_prepare_conversations') ORDER BY key").all(), settings.map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key)));
      noActivity(getDb()); closeDb();
    }
  });
}
test('an older nonempty database without sync settings is not mistaken for a new installation', () => {
  const old = new Database(path.join(root, 'draken.db'));
  old.exec("CREATE TABLE sqliteX_prior_data(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO sqliteX_prior_data VALUES(1,'keep me')"); old.close();
  assert.equal(autoIndexSettings().enabled, false);
  assert.equal(getDb().prepare('SELECT note FROM sqliteX_prior_data').get().note, 'keep me');
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM sync_settings WHERE key LIKE 'auto_%'").get().n, 0);
});
