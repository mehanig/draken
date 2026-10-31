// Opt-in only: one voice turn (at most two pi invocations), entirely synthetic context.
// node tests/voice-real.cjs --allow-provider [--browser] [--overview] [--persona] [--debug-stream]
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (!process.argv.includes('--allow-provider')) { console.error('This test uses a real pi voice turn (up to two model invocations). Pass --allow-provider explicitly.'); process.exit(1); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-real-voice-'));
Object.assign(process.env, { DRAKEN_DATA_DIR: root, DRAKEN_PI_SESSIONS_DIR: path.join(root, 'empty-sessions'), DRAKEN_HOST: '127.0.0.1', DRAKEN_NO_AUTH: 'true',
  DRAKEN_VOICE_DATA_DIR: process.env.DRAKEN_VOICE_DATA_DIR || path.join(os.homedir(), '.draken/voice'),
  DRAKEN_PI_SUMMARY_MODEL: 'openai/gpt-6-luna', DRAKEN_PI_FINAL_MODEL: 'openai/gpt-6-astra' });
for (const key of ['DRAKEN_VOICE_WORKER', 'DRAKEN_FAKE_CONTROL', 'DRAKEN_TEST_CALL_LOG']) delete process.env[key];
fs.mkdirSync(process.env.DRAKEN_PI_SESSIONS_DIR);
const { getDb, closeDb } = require('../dist/db/schema');
const voice = require('../dist/voice/calls');
let invocations = 0;
const pi = require('../dist/sync/pi'), invoke = pi.invokePi;
pi.invokePi = async (input, options) => {
  const attempt = ++invocations;
  const result = await invoke(input, options);
  if (process.argv.includes('--debug-stream')) fs.writeFileSync(path.join(root, `synthetic-response-${attempt}.txt`), result);
  return result;
};
console.log(`Synthetic test only; artifacts: ${root}`);
let server, browser;
(async () => {
  const now = new Date().toISOString(), yesterday = new Date(Date.now() - 86400000).toISOString();
  const overview = process.argv.includes('--overview');
  const sources = overview ? [
    'Export retry tests: 5 passed, 0 failed. Deployment has not been verified.',
    'Dashboard: event-driven updates replaced the earlier polling proposal. Implementation is incomplete.',
    'Login cleanup completed; local browser test passed. Real-device testing is pending.',
    'LAN HTTPS configured and verified on the server. A second laptop still needs to trust the certificate.',
    'Nightly scheduling was discussed but was NOT implemented. It requires an explicit decision.',
  ] : ['Export retry test result: 5 passed, 0 failed.', 'Dashboard refresh: need to choose polling versus events. Deployment has not been checked.'];
  const briefing = sources.map((text, index) => `${text} [E${index + 1}]`).join('\n');
  const syncId = Number(getDb().prepare('INSERT INTO syncs(created_at,snapshot_at,snapshot_version,briefing,compression_complete) VALUES (?,?,2,?,1)')
    .run(yesterday, now, briefing).lastInsertRowid);
  for (const [index, text] of sources.entries()) {
    const item = { ref: `E${index + 1}`, session_id: 'synthetic', session_name: 'Synthetic export review', cwd: '/demo/export-service', entry_id: String(index),
      event_key: 'synthetic-' + index, source_path: '/synthetic/session.jsonl', timestamp: yesterday, role: 'toolResult', text };
    getDb().prepare('INSERT INTO sync_items VALUES (?,?,?)').run(syncId, item.event_key, JSON.stringify(item));
  }
  let questionWav = path.join(__dirname, 'fixtures/voice-question.wav');
  if (overview) {
    const speech = await require('../dist/voice/audio').localAudio.request({ op: 'synthesize', text: 'Can you explain me what was done yesterday and what were the blockers in general?' });
    // The browser VAD records 16 kHz. Match that contract for the direct test too;
    // Kokoro's generated fixture is 24 kHz PCM16, not a valid STT upload as-is.
    const source = Buffer.from(speech.audio, 'base64'), rate = source.readUInt32LE(24);
    assert.equal(source.toString('ascii', 36, 40), 'data');
    assert.equal(source.readUInt16LE(22), 1); assert.equal(source.readUInt16LE(34), 16);
    const samples = (source.length - 44) / 2, count = Math.floor(samples * 16000 / rate);
    const wav = Buffer.alloc(44 + count * 2); source.copy(wav, 0, 0, 44);
    wav.writeUInt32LE(wav.length - 8, 4); wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28); wav.writeUInt32LE(count * 2, 40);
    for (let i = 0; i < count; i++) {
      const position = i * rate / 16000, left = Math.floor(position), fraction = position - left;
      const a = source.readInt16LE(44 + left * 2), b = source.readInt16LE(44 + Math.min(left + 1, samples - 1) * 2);
      wav.writeInt16LE(Math.round(a + (b - a) * fraction), 44 + i * 2);
    }
    questionWav = path.join(root, 'synthetic-question.wav'); fs.writeFileSync(questionWav, wav);
  }
  let transcription;
  if (process.argv.includes('--browser')) {
    const { createApp } = require('../dist/server');
    server = createApp({ staticDir: process.env.DRAKEN_TEST_STATIC_DIR || path.resolve(__dirname, '../public') }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    browser = await require('@playwright/test').chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__question.wav', route => route.fulfill({ path: questionWav, contentType: 'audio/wav' }));
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
    await require('@playwright/test').expect(state).toHaveText('Draken is speaking', { timeout: 65000 });
    if (process.argv.includes('--persona')) {
      await require('@playwright/test').expect(page.locator('.dp-stage')).toHaveAttribute('data-renderer', 'webgl');
      await require('@playwright/test').expect.poll(async () => Number(await page.locator('.dp-canvas').getAttribute('data-mouth')), { timeout: 15000 }).toBeGreaterThan(3);
    }
    await require('@playwright/test').expect(state).toHaveText('Your turn', { timeout: 65000 });
    if (process.argv.includes('--persona')) await require('@playwright/test').expect(page.locator('.dp-canvas')).toHaveAttribute('data-mouth', '0');
    await page.getByRole('button', { name: 'End call', exact: true }).click();
    await require('@playwright/test').expect(page.getByRole('dialog')).not.toBeVisible();
    assert.deepEqual(errors, []);
  } else {
    const call = await voice.startCall(syncId);
    transcription = await voice.transcribe(call.id, fs.readFileSync(questionWav), new AbortController().signal);
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
  assert.match(turn.question, overview ? /yesterday.*blockers/i : /export tests/i);
  assert.equal(turn.heard_text, turn.answer);
  assert.ok(invocations >= 1 && invocations <= 2);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
  const report = { synthetic_only: true, browser: process.argv.includes('--browser'), persona: process.argv.includes('--persona'), overview, invocations, transcription, answer: turn.answer, evidence: JSON.parse(turn.evidence_json),
    model_ms: turn.model_ms, first_audio_ms: turn.first_audio_ms, status: turn.status, artifacts: root };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); voice.stopVoiceCalls(); await new Promise(resolve => server ? server.close(resolve) : resolve()); closeDb();
});
