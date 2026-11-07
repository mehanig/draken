// Product-boundary tests: reachable old features are not necessarily wanted features.
require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { getDb, closeDb } = require('../dist/db/schema');
const { createApp, startServer } = require('../dist/server');
const { validateVoiceConfig } = require('../dist/voice/live');
const { legacyCallHistory, recoverLegacyCalls } = require('../dist/voice/legacy-history');
const { liveEvidence } = require('../dist/voice/live-context');
const { getSync } = require('../dist/sync/store');
let root, syncId, server;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-voice-boundary-'));
  Object.assign(process.env, { DRAKEN_DATA_DIR: root, DRAKEN_HOST: '127.0.0.1', DRAKEN_NO_AUTH: 'true',
    DRAKEN_CODEX_HOME: path.join(root, 'account'), DRAKEN_CODEX_BIN: path.join(__dirname, 'fixtures/fake-codex.cjs') });
  delete process.env.DRAKEN_VOICE_MODE;
  syncId = Number(getDb().prepare("INSERT INTO syncs(created_at,snapshot_at,snapshot_version) VALUES (?,?,2)").run('2020-01-01', '2020-01-01').lastInsertRowid);
});
afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve)); server = undefined;
  closeDb(); fs.rmSync(root, { recursive: true, force: true });
  for (const key of ['DRAKEN_VOICE_MODE', 'DRAKEN_CODEX_HOME', 'DRAKEN_CODEX_BIN']) delete process.env[key];
});
function oldCall(status = 'ended') {
  const db = getDb();
  db.prepare('INSERT INTO voice_calls(id,sync_id,status,started_at,model) VALUES (?,?,?,?,?)').run('old-call', syncId, status, '2020-01-01', 'historical-model');
  db.prepare('INSERT INTO voice_turns(call_id,request_id,question,answer,heard_text,status,started_at,messages_saved,evidence_json) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('old-call', 'old-request', 'Historical question', 'Generated full answer', 'Played first sentence.', status === 'active' ? 'speaking' : 'completed', '2020-01-01', status === 'active' ? 0 : 1, '["E1"]');
}

test('ChatGPT voice is the default; obsolete local configuration fails before starting a server', async () => {
  assert.doesNotThrow(validateVoiceConfig);
  server = createApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/voice/status`);
  assert.equal(response.status, 200); const status = await response.json();
  assert.equal(status.mode, 'native'); assert.equal(status.installed, false); assert.equal(status.activeCall, null);
  for (const mode of ['local', 'typo', '']) {
    process.env.DRAKEN_VOICE_MODE = mode;
    assert.throws(startServer, /Only ChatGPT voice/);
  }
});

test('local execution endpoints are gone; historical call rows are returned without rewriting them', async () => {
  oldCall(); const db = getDb();
  const before = JSON.stringify([db.prepare('SELECT * FROM voice_calls').all(), db.prepare('SELECT * FROM voice_turns').all()]);
  recoverLegacyCalls();
  server = createApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api/voice`;
  for (const suffix of ['/calls', '/calls/old-call/transcribe', '/calls/old-call/turns', '/calls/old-call/played', '/calls/old-call/interrupt', '/calls/old-call/heartbeat', '/calls/old-call/end']) {
    assert.equal((await fetch(origin + suffix, { method: 'POST' })).status, 404, suffix);
  }
  assert.equal((await fetch(origin + '/calls/old-call/audio/0/0')).status, 404);
  const history = await (await fetch(`${origin}/syncs/${syncId}/history`)).json();
  assert.equal(history[0].mode, 'legacy'); assert.equal(history[0].turns[0].answer, 'Generated full answer');
  assert.equal(history[0].turns[0].heard_text, 'Played first sentence.');
  assert.equal(JSON.stringify([db.prepare('SELECT * FROM voice_calls').all(), db.prepare('SELECT * FROM voice_turns').all()]), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});

test('unfinished old calls are retained and closed once, never resumed or falsely marked fully played', () => {
  oldCall('active'); recoverLegacyCalls(); recoverLegacyCalls();
  const history = legacyCallHistory(syncId)[0];
  assert.equal(history.status, 'interrupted'); assert.equal(history.turns[0].status, 'interrupted');
  assert.equal(history.turns[0].answer, 'Generated full answer'); assert.equal(history.turns[0].heard_text, 'Played first sentence.');
  const sync = getSync(syncId); assert.equal(sync.messages.length, 2);
  assert.match(sync.messages[1].content, /Voice reply interrupted/);
  assert.match(sync.messages[1].content, /Played first sentence/);
  assert.doesNotMatch(sync.messages[1].content, /Generated full answer/);
  assert.equal(sync.status, 'open'); assert.equal(sync.decisions, '');
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});

test('native context retains late briefing references after removing the old context owner', () => {
  const refs = require('./fixtures/voice-sources.cjs')(getDb(), syncId);
  const packet = liveEvidence(getSync(syncId), '', true), input = JSON.parse(packet.text);
  assert.ok(Buffer.byteLength(packet.text) <= 24000);
  for (const ref of refs) assert.ok(packet.refs.includes(ref), `Missing ${ref}`);
  for (const match of packet.text.matchAll(/\[([EC]\d+)\]/g)) assert.ok(packet.refs.includes(match[1]));
  assert.equal(input.historical_quotes_not_current_requests, undefined);
});

test('retired speech code, installers and browser dependencies cannot quietly return', () => {
  const repo = path.resolve(__dirname, '..');
  for (const file of ['src/voice/calls.ts', 'src/voice/audio.ts', 'src/sync/pi-stream.ts', 'client/src/voice/session.ts', 'client/scripts/voice-assets.mjs', 'voice/setup.mjs', 'voice/worker.py', 'voice/requirements.txt']) {
    assert.equal(fs.existsSync(path.join(repo, file)), false, file);
  }
  const client = require('../client/package.json'), pkg = require('../package.json');
  for (const dependency of ['@ricky0123/vad-web', 'onnxruntime-web']) assert.equal(client.dependencies[dependency], undefined);
  assert.equal(pkg.scripts['voice:setup'], undefined);
  assert.ok(!pkg.files.some(file => /worker\.py|requirements\.txt|voice\/setup\.mjs/.test(file)));
});
