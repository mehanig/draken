const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { PLAIN_ENGLISH } = require('../dist/plain-english');
const { LIVE_PROMPT } = require('../dist/voice/live-context');
const { invokePi } = require('../dist/sync/pi');

test('text-model requests and native voice receive the same plain-English instruction without changing format rules', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-language-'));
  const previous = { ...process.env };
  try {
    const fake = path.join(root, 'pi'); fs.copyFileSync(path.join(__dirname, 'fixtures/fake-pi.cjs'), fake); fs.chmodSync(fake, 0o700);
    Object.assign(process.env, { DRAKEN_DATA_DIR: path.join(root, 'state'), DRAKEN_PI_BIN: fake, DRAKEN_TEST_CALL_LOG: path.join(root, 'requests.jsonl') });
    delete process.env.DRAKEN_FAKE_CONTROL;
    const system = 'Return only JSON. Keep the supplied evidence citations.';
    await invokePi(JSON.stringify({ task: 'sync_recap', records: [] }), { system, model: 'test/cheap', thinking: 'off' });
    const request = JSON.parse(fs.readFileSync(process.env.DRAKEN_TEST_CALL_LOG, 'utf8').trim());
    assert.ok(request.system.includes(system)); assert.ok(request.system.includes(PLAIN_ENGLISH));
    assert.ok(LIVE_PROMPT.includes(PLAIN_ENGLISH));
    assert.match(PLAIN_ENGLISH, /simple, direct English/); assert.match(PLAIN_ENGLISH, /corporate buzzwords/);
    assert.match(PLAIN_ENGLISH, /required JSON formats, citations and important uncertainty/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); fs.rmSync(root, { recursive: true, force: true });
  }
});
