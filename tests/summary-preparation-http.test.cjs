const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { getDb, closeDb } = require('../dist/db/schema');
const background = require('../dist/sync/background');
const store = require('../dist/sync/store');
let root, server, url;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-summary-api-')); fs.mkdirSync(root + '/sessions');
  Object.assign(process.env, { DRAKEN_DATA_DIR: root + '/state', DRAKEN_PI_SESSIONS_DIR: root + '/sessions',
    DRAKEN_NO_AUTH: 'true', DRAKEN_HOST: '127.0.0.1', DRAKEN_PI_BIN: '/not-a-provider' });
  const { createApp } = require('../dist/server');
  server = createApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}/api/settings/auto-summary`;
});
afterEach(async () => {
  await background.stopBackgroundIndexing(); await new Promise(resolve => server.close(resolve));
  closeDb(); fs.rmSync(root, { recursive: true, force: true });
});
const patch = (body, headers = {}) => fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('summary consent HTTP rejects malformed and cross-origin writes, persists separately and creates no work', async () => {
  assert.equal((await (await fetch(url)).json()).enabled, true);
  for (const body of [{}, [], null, { enabled: 'true' }, { enabled: true, scope: 'automatic-syncs' }]) assert.equal((await patch(body)).status, 400);
  assert.equal((await patch({ enabled: true }, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await (await fetch(url)).json()).enabled, true);
  background.setAutoIndex(false); assert.equal((await patch({ enabled: true })).status, 409);
  background.setAutoIndex(true);
  assert.equal((await (await patch({ enabled: true })).json()).enabled, true);
  await background.stopBackgroundIndexing(); closeDb();
  assert.equal((await (await fetch(url)).json()).enabled, true, 'explicit paid preference survives restart');
  background.setAutoIndex(false); assert.equal((await (await fetch(url)).json()).status, 'paused');
  assert.equal((await (await patch({ enabled: false })).json()).enabled, false, 'opt-out works while indexing is off');
  for (const table of ['background_runs', 'summary_cache', 'agent_sessions', 'syncs', 'sync_items', 'sync_runs', 'sync_messages', 'sync_coverage']) {
    assert.equal(getDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  }
});

test('summary progress GET reads historical accounting only, never opens originals to claim live readiness', async () => {
  const db = getDb(), completed = '2026-01-01T00:00:00.000Z';
  db.prepare(`INSERT INTO background_runs(status,summary_model,final_model,max_invocations,total_entries,processed_entries,
    started_at,completed_at,input_key,source_keys_json) VALUES ('completed','synthetic/summary','synthetic/final',10,64,64,?,?,?,'{}')`)
    .run(completed, completed, 'historical-receipt');
  const original = store.previewSummaryInput; let reads = 0;
  store.previewSummaryInput = () => { reads++; throw Error('Original bodies must not be opened by a status read'); };
  try {
    const before = db.prepare('SELECT total_changes() n').get().n;
    for (let n = 0; n < 3; n++) {
      const response = await fetch(url); assert.equal(response.status, 200);
      const value = await response.json(); assert.equal(value.prepared_entries, 64); assert.equal(value.last_completed_at, completed);
      assert.equal(value.error, ''); assert.equal(value.status, 'waiting');
    }
    assert.equal(reads, 0); assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  } finally { store.previewSummaryInput = original; }
});
