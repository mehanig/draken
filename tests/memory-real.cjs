// Explicit local-model qualification. Synthetic records only; fake pi/native
// helpers. No OpenAI request or real account. Downloads require a separate flag.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LocalEmbedder } = require('../dist/memory/model');
const service = require('../dist/memory/service');
const { getDb, closeDb } = require('../dist/db/schema');
const { getSync } = require('../dist/sync/store');
const { scanSessions } = require('../dist/sync/collector');
const { generateReply } = require('../dist/sync/manager');
const live = require('../dist/voice/live');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const modelDirectory = process.argv.find(arg => arg.startsWith('--model-dir='))?.slice(12) || path.join(os.tmpdir(), 'draken-synthetic-memory-model');
const model = new LocalEmbedder(path.resolve(modelDirectory));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-memory-local-proof-')); fs.chmodSync(root, 0o700);
let cache;
(async () => {
  if (process.argv.includes('--download-model')) await model.setup();
  if (!model.ready()) throw new Error('Model absent. Pass --download-model explicitly, or --model-dir=<existing pinned model directory>.');
  // Prove inference itself is offline; model loading must not fetch code/assets.
  const fetch = global.fetch; global.fetch = () => { throw new Error('Unexpected inference network request'); };
  const a = await model.embed('Retire Whisper and Kokoro. Native ChatGPT voice is the only supported speech path.', false);
  const b = await model.embed('Почему отказались от локальной озвучки?', true);
  assert.ok(a.reduce((sum, value, index) => sum + value * b[index], 0) > 0.75);
  global.fetch = fetch;
  const fakePi = path.join(root, 'pi'); fs.copyFileSync(path.join(__dirname, 'fixtures/fake-pi.cjs'), fakePi); fs.chmodSync(fakePi, 0o700);
  Object.assign(process.env, { DRAKEN_DATA_DIR: path.join(root, 'state'), DRAKEN_PI_SESSIONS_DIR: path.join(root, 'sessions'), DRAKEN_PI_BIN: fakePi,
    DRAKEN_PI_SUMMARY_MODEL: 'test/cheap', DRAKEN_PI_FINAL_MODEL: 'test/strong', DRAKEN_TEST_CALL_LOG: path.join(root, 'pi.jsonl'),
    DRAKEN_CODEX_BIN: path.join(__dirname, 'fixtures/fake-codex.cjs'), DRAKEN_CODEX_HOME: path.join(root, 'account') });
  delete process.env.DRAKEN_VOICE_MODE;
  fs.mkdirSync(path.join(process.env.DRAKEN_DATA_DIR, 'memory'), { recursive: true }); fs.symlinkSync(path.resolve(modelDirectory), path.join(process.env.DRAKEN_DATA_DIR, 'memory/model'), 'dir');
  fs.mkdirSync(process.env.DRAKEN_CODEX_HOME); fs.writeFileSync(path.join(process.env.DRAKEN_CODEX_HOME, 'scenario.txt'), 'conversation');
  fs.writeFileSync(path.join(process.env.DRAKEN_CODEX_HOME, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic', refresh_token: 'synthetic', id_token: 'synthetic' } }));
  const db = getDb(), at = '2020-01-01T00:00:00.000Z';
  const texts = ['Retire Whisper and Kokoro. Native ChatGPT voice is the only supported speech path.', 'The copper desk lamp supplier is unresolved; no purchase was agreed.', 'HTTP 403 occurred in export_request_17. Deployment was not checked.'];
  fs.mkdirSync(process.env.DRAKEN_PI_SESSIONS_DIR);
  fs.writeFileSync(path.join(process.env.DRAKEN_PI_SESSIONS_DIR, 'demo.jsonl'), [
    { type: 'session', version: 3, id: 'demo', cwd: '/demo', timestamp: at },
    { type: 'session_info', id: 'name', parentId: null, timestamp: at, name: 'Synthetic history' },
    ...texts.map((text, i) => ({ type: 'message', id: String(i), parentId: i ? String(i - 1) : 'name', timestamp: at, message: { role: 'assistant', content: text } })),
  ].map(JSON.stringify).join('\n') + '\n');
  await scanSessions();
  const syncId = Number(db.prepare("INSERT INTO syncs(created_at,snapshot_at,snapshot_version,briefing,compression_complete) VALUES(?,?,2,'Ready synthetic sync.',1)").run(at, at).lastInsertRowid);
  const protectedRows = () => JSON.stringify(['agent_entries', 'agent_sessions', 'sync_items', 'sync_coverage'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  const original = protectedRows();
  // No setup/index call or scope flag: the ordinary request must prepare itself.
  const progress = [], timer = setInterval(() => { const value = service.historyProgress(); if (value.active) progress.push(value); }, 50);
  const start = Date.now(); let found;
  try { found = await service.searchHistory({ question: 'Why did we stop using the speech pipeline on our machine?' }); }
  finally { clearInterval(timer); }
  assert.ok(progress.some(value => value.work?.total === 3), 'real worker sends progress while loading/indexing');
  assert.equal(service.historyProgress().active, false);
  assert.equal(found.mode, 'hybrid'); assert.match(found.results[0].text, /Whisper/);
  const firstLookupMs = Date.now() - start;
  const warmStart = Date.now(); await service.searchHistory({ question: 'Why did we stop using the speech pipeline on our machine?' });
  const warmLookupMs = Date.now() - warmStart;
  const unrelated = await service.searchHistory({ question: 'How many moons orbit Jupiter?' }); assert.equal(unrelated.results.length, 0);
  service.stopHistory(); await delay(150); // Readiness survives worker retirement; call creation cannot prepare it again.
  assert.equal(service.historyReadiness().ready, true);
  cache = new (require('better-sqlite3'))(path.join(process.env.DRAKEN_DATA_DIR, 'memory/index.sqlite'), { readonly: true });
  const cacheVersion = cache.pragma('data_version', { simple: true });
  const call = await live.createLiveCall(syncId, new AbortController().signal);
  await live.connectLiveCall(call.id, 'v=0\r\nm=audio 9 test', new AbortController().signal);
  await live.sendLiveText(call.id, 'Why did we stop using the speech pipeline on our machine?', randomUUID()); await delay(60);
  const requests = fs.readFileSync(path.join(process.env.DRAKEN_CODEX_HOME, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const context = requests.find(row => row.method === 'thread/realtime/appendText' && row.params.role === 'developer');
  assert.ok(context); assert.match(context.params.text, /read_only_history/); assert.match(context.params.text, /Whisper/); assert.ok(Buffer.byteLength(context.params.text) <= 4096);
  assert.ok(live.liveHistory(syncId)[0].turns.some(row => JSON.parse(row.evidence_json).some(ref => /^H[a-f0-9]{24}$/.test(ref))));
  await live.endLiveCall(call.id);
  assert.equal(cache.pragma('data_version', { simple: true }), cacheVersion, 'Cold voice lookup must not write the corpus index'); cache.close(); cache = null;
  await generateReply(syncId, 'Why did we change the speech approach?');
  assert.match(getSync(syncId).messages.at(-1).content, /\[H[a-f0-9]{24}\]/);
  assert.equal(getSync(syncId).tree.run.history_scope, undefined);
  assert.equal(protectedRows(), original); assert.equal(getSync(syncId).decisions, '');
  assert.equal(getSync(syncId).status, 'open');
  service.stopHistory();
  const cancel = new AbortController();
  const cancelled = service.searchHistory({ question: 'speech' }, cancel.signal); cancel.abort();
  await assert.rejects(cancelled, /stopped/);
  const resumed = await service.searchHistory({ question: 'Whisper Kokoro' });
  assert.ok(resumed.results.some(item => /Whisper/.test(item.text)), 'next ordinary lookup resumes automatically');
  console.log(JSON.stringify({ realLocalModel: true, offlineInference: true, multilingualMatch: true, automaticPreparation: true, liveProgress: true, firstLookupMs, warmLookupMs, topHit: found.results[0].kind,
    unrelatedQuestionAbstained: true, nativeContextAndHistoryLinked: true, callReadyAfterWorkerRestart: true, callCorpusWrites: 0, textReplyCitationsValidated: true, cancelResume: true,
    canonicalEvidenceUnchanged: true, coverage: 0, productionWrites: 0, realProviderCalls: 0 }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await live.stopLiveCalls(); service.stopHistory(); await delay(150); cache?.close(); closeDb(); fs.rmSync(root, { recursive: true, force: true });
});
