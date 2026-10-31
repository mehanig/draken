// Opt-in only: one real pi/subscription call using entirely synthetic context.
// node tests/voice-real.cjs --allow-provider [--browser]
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (!process.argv.includes('--allow-provider')) { console.error('This test uses one real pi model call. Pass --allow-provider explicitly.'); process.exit(1); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-real-voice-'));
Object.assign(process.env, { DRAKEN_DATA_DIR: root, DRAKEN_PI_SESSIONS_DIR: path.join(root, 'empty-sessions'), DRAKEN_HOST: '127.0.0.1', DRAKEN_NO_AUTH: 'true',
  DRAKEN_VOICE_DATA_DIR: process.env.DRAKEN_VOICE_DATA_DIR || path.join(os.homedir(), '.draken/voice'),
  DRAKEN_PI_SUMMARY_MODEL: 'openai/gpt-6-luna', DRAKEN_PI_FINAL_MODEL: 'openai/gpt-6-astra' });
for (const key of ['DRAKEN_VOICE_WORKER', 'DRAKEN_FAKE_CONTROL', 'DRAKEN_TEST_CALL_LOG']) delete process.env[key];
fs.mkdirSync(process.env.DRAKEN_PI_SESSIONS_DIR);
const { getDb, closeDb } = require('../dist/db/schema');
const voice = require('../dist/voice/calls');
if (process.argv.includes('--debug-stream')) {
  const pi = require('../dist/sync/pi'), invoke = pi.invokePi;
  pi.invokePi = (input, options) => invoke(input, { ...options, onText: delta => {
    fs.appendFileSync(path.join(root, 'synthetic-stream.txt'), delta); options.onText(delta);
  } });
}
console.log(`Synthetic test only; artifacts: ${root}`);
let server, browser;
(async () => {
  const now = new Date().toISOString();
  const syncId = Number(getDb().prepare('INSERT INTO syncs(created_at,snapshot_at,snapshot_version,briefing,compression_complete) VALUES (?,?,2,?,1)')
    .run(now, now, 'Export retry tests passed [E1]. Polling versus events remains undecided [E2]. No deployment evidence is available.').lastInsertRowid);
  for (const [index, text] of ['Export retry test result: 5 passed, 0 failed.', 'Dashboard refresh: need to choose polling versus events. Deployment has not been checked.'].entries()) {
    const item = { ref: `E${index + 1}`, session_id: 'synthetic', session_name: 'Synthetic export review', cwd: '/demo/export-service', entry_id: String(index),
      event_key: 'synthetic-' + index, source_path: '/synthetic/session.jsonl', timestamp: now, role: 'toolResult', text };
    getDb().prepare('INSERT INTO sync_items VALUES (?,?,?)').run(syncId, item.event_key, JSON.stringify(item));
  }
  let transcription;
  if (process.argv.includes('--browser')) {
    const { createApp } = require('../dist/server');
    server = createApp({ staticDir: process.env.DRAKEN_TEST_STATIC_DIR || path.resolve(__dirname, '../public') }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    browser = await require('@playwright/test').chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__question.wav', route => route.fulfill({ path: path.join(__dirname, 'fixtures/voice-question.wav'), contentType: 'audio/wav' }));
    await page.addInitScript(() => {
      let context, destination;
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        context = new AudioContext(); destination = context.createMediaStreamDestination(); await context.resume(); return destination.stream;
      } });
      window.__say = async () => {
        const buffer = await context.decodeAudioData(await (await fetch('/__question.wav')).arrayBuffer());
        const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
        await new Promise(resolve => { source.onended = resolve; source.start(); });
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Call Draken', exact: true }).click();
    const state = page.getByRole('dialog').getByRole('status');
    await require('@playwright/test').expect(state).toHaveText('Your turn', { timeout: 30000 });
    await page.evaluate(() => window.__say());
    await require('@playwright/test').expect(state).toHaveText('Draken is speaking', { timeout: 30000 });
    await require('@playwright/test').expect(state).toHaveText('Your turn', { timeout: 30000 });
    await page.getByRole('button', { name: 'End call', exact: true }).click();
    await require('@playwright/test').expect(page.getByRole('dialog')).not.toBeVisible();
    assert.deepEqual(errors, []);
  } else {
    const call = await voice.startCall(syncId);
    transcription = await voice.transcribe(call.id, fs.readFileSync(path.join(__dirname, 'fixtures/voice-question.wav')), new AbortController().signal);
    await voice.reply(call.id, transcription.text, crypto.randomUUID(), new AbortController().signal, event => {
      if (event.type === 'audio') {
        fs.writeFileSync(path.join(root, `answer-${event.index}.wav`), voice.getAudio(call.id, event.id, event.index));
        voice.played(call.id, event.id, event.index); // Synthetic receipts, not a claim of audible playback.
      }
    });
    voice.endCall(call.id);
  }
  const turn = voice.callHistory(syncId)[0].turns[0];
  assert.equal(turn?.status, 'completed', turn?.error || 'No completed voice turn');
  assert.match(turn.question, /export tests/i);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
  const report = { synthetic_only: true, browser: process.argv.includes('--browser'), transcription, answer: turn.answer, evidence: JSON.parse(turn.evidence_json),
    model_ms: turn.model_ms, first_audio_ms: turn.first_audio_ms, status: turn.status, artifacts: root };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); voice.stopVoiceCalls(); await new Promise(resolve => server ? server.close(resolve) : resolve()); closeDb();
});
