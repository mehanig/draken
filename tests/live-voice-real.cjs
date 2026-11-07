// Opt-in native-provider/UI qualification, synthetic facts and injected audio only.
if (!process.argv.includes('--allow-provider')) throw Error('Pass --allow-provider; this uses native ChatGPT voice.');
process.umask(0o077);
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-native-ui-'));
Object.assign(process.env, { DRAKEN_DATA_DIR: root, DRAKEN_HOST: '127.0.0.1', DRAKEN_NO_AUTH: 'true', DRAKEN_VOICE_MODE: 'native' });
delete process.env.DRAKEN_CODEX_BIN; delete process.env.DRAKEN_CODEX_HOME;
process.env.DRAKEN_PI_BIN = path.join(root, 'fake-pi');
fs.copyFileSync(path.join(__dirname, 'fixtures/fake-pi.cjs'), process.env.DRAKEN_PI_BIN); fs.chmodSync(process.env.DRAKEN_PI_BIN, 0o700);
process.env.DRAKEN_PI_SUMMARY_MODEL = 'test/cheap'; // Only the post-call recap uses this synthetic provider.
const schema = require('../dist/db/schema'), live = require('../dist/voice/live');
let server, browser, page, timer; const errors = [];
(async () => {
  const db = schema.getDb(), now = new Date().toISOString();
  const syncId = Number(db.prepare('INSERT INTO syncs(created_at, snapshot_at, snapshot_version, briefing, compression_complete) VALUES (?, ?, 2, ?, 1)').run(now, now, 'The targeted export tests passed [E1]. Deployment is unverified.').lastInsertRowid);
  db.prepare('UPDATE syncs SET memory_json=? WHERE id=?').run(JSON.stringify([{sync_id:42,status:'open',snapshot_at:now,recap:'The previous call discussed a copper desk lamp; choosing a supplier remained unresolved.',decisions:'',carry_forward:''}]),syncId);
  db.prepare('INSERT INTO sync_items(sync_id, event_key, evidence_json) VALUES (?, ?, ?)').run(syncId, 'synthetic', JSON.stringify({ ref: 'E1', event_key: 'synthetic', session_id: 'synthetic', session_name: 'Export service', cwd: '/demo/export', source_path: '/synthetic', entry_id: '1', timestamp: now, role: 'toolResult', text: 'Targeted export tests: 5 passed, 0 failed. Deployment was not checked. Synthetic test data.' }));
  db.prepare('INSERT INTO sync_items(sync_id, event_key, evidence_json) VALUES (?, ?, ?)').run(syncId, 'lookup-only', JSON.stringify({ ref: 'E2', event_key: 'lookup-only', session_id: 'synthetic', session_name: 'Demo banner', cwd: '/demo/export', source_path: '/synthetic', entry_id: '2', timestamp: now, role: 'toolResult', text: 'Synthetic rendering inspection: the demo banner colour is violet. No deployment was checked.' }));
  server = require('../dist/server').createApp({ staticDir: process.env.DRAKEN_TEST_STATIC_DIR || '/tmp/draken-live-preview' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const wav = fs.readFileSync(path.join(__dirname, 'fixtures/voice-question.wav')).toString('base64');
  browser = await chromium.launch({ headless: true }); page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  timer = setTimeout(() => { void browser?.close(); }, 180000);
  await page.addInitScript(({ wav }) => {
    window.__tracks = []; window.__wire = []; window.__peers = 0;
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(...args) { super(...args); window.__peers++; }
      createDataChannel(...args) { const channel = super.createDataChannel(...args); channel.addEventListener('message', event => { try { const value = JSON.parse(event.data); window.__wire.push({ at: performance.now(), type: value.type, role: value.turn?.role, id: value.turn?.id }); } catch {} }); return channel; }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(); await context.resume(); const destination = context.createMediaStreamDestination();
      const silence = context.createConstantSource(); silence.offset.value = 0; silence.connect(destination); silence.start();
      const bytes = Uint8Array.from(atob(wav), c => c.charCodeAt(0)); const buffer = await context.decodeAudioData(bytes.buffer);
      window.__speak = () => new Promise(resolve => { const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination); source.onended = resolve; source.start(); });
      window.__tracks.push(...destination.stream.getTracks()); return destination.stream;
    };
  }, { wav });
  await page.goto(`http://127.0.0.1:${server.address().port}/syncs/${syncId}`);
  const setupAt = Date.now(); await page.getByRole('button', { name: 'Call Draken', exact: true }).click();
  const dialog = page.getByRole('dialog'), status = dialog.getByRole('status');
  await expect(status).toHaveText('Your turn', { timeout: 60000 }); const setupMs = Date.now() - setupAt;
  await page.getByRole('button', { name: 'Headphone mode', exact: true }).click();
  await page.evaluate(() => window.__speak()); const firstInputEnd = Date.now();
  await expect(status).toHaveText('Draken is speaking', { timeout: 40000 }); const firstAudioMs = Date.now() - firstInputEnd;
  await page.waitForFunction(() => Number(document.querySelector('.dp-canvas')?.dataset.mouth) > 3, null, { timeout: 15000 });
  const mouthMoved = true;
  // Barge in while the first real provider reply is audible, same connection.
  await page.evaluate(() => window.__speak()); const secondInputEnd = Date.now();
  await expect.poll(() => db.prepare("SELECT COUNT(*) AS n FROM live_messages WHERE role='user'").get().n, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => db.prepare("SELECT COUNT(*) AS n FROM live_messages WHERE role='assistant' AND status <> 'streaming'").get().n, { timeout: 50000 }).toBeGreaterThanOrEqual(2);
  await expect(status).toHaveText('Your turn', { timeout: 50000 });
  await page.getByRole('button', { name: 'Type a question', exact: true }).click();
  await page.getByRole('textbox', { name: 'Type a question for this call' }).fill('Explain in four short sentences what those tests do and do not establish.');
  await page.getByRole('button', { name: 'Send voice-call question' }).click();
  await expect(status).toHaveText('Draken is speaking', { timeout: 30000 });
  await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
  await expect(status).toHaveText('Your turn', { timeout: 3000 });
  await page.waitForFunction(() => Number(document.querySelector('.dp-canvas')?.dataset.mouth) === 0, null, { timeout: 3000 });
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__tracks.every(track => track.readyState === 'ended')), true);
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  await page.getByRole('textbox', { name: 'Type a question for this call' }).fill('Look up source E2. In one sentence, quote the colour recorded for the demo banner.');
  await page.getByRole('button', { name: 'Send voice-call question' }).click();
  await expect(status).toHaveText('Draken is speaking', { timeout: 30000 });
  await expect.poll(() => db.prepare("SELECT text FROM live_messages WHERE role='assistant' AND status <> 'streaming' ORDER BY id DESC LIMIT 1").get()?.text || '', { timeout: 50000 }).toMatch(/violet/i);
  await expect(status).toHaveText('Your turn', { timeout: 50000 });
  await expect(dialog.locator('.voice-answer')).toContainText(/violet/i);
  assert.ok(db.prepare("SELECT sources_json FROM live_messages WHERE role='assistant' ORDER BY id DESC LIMIT 1").get().sources_json.includes('E2'), 'E2 must actually be retrieved, not guessed from initial context');
  await expect(dialog.getByRole('alert')).not.toBeVisible();
  await page.getByRole('textbox', { name: 'Type a question for this call' }).fill('What did we discuss in the previous sync? Use its recap, without claiming an exact quotation.');
  await page.getByRole('button', { name: 'Send voice-call question' }).click();
  await expect.poll(() => db.prepare("SELECT text FROM live_messages WHERE role='assistant' AND status <> 'streaming' ORDER BY id DESC LIMIT 1").get()?.text || '', { timeout: 50000 }).toMatch(/copper/i);
  await expect(status).toHaveText('Your turn', { timeout: 50000 });
  assert.match(db.prepare("SELECT text FROM live_messages WHERE role='assistant' ORDER BY id DESC LIMIT 1").get().text,/unresolved|undecided|not (?:chosen|decided|selected)|still (?:open|pending)/i);
  const state = await page.evaluate(() => ({ peers: window.__peers, wire: window.__wire }));
  await page.getByRole('button', { name: 'End call', exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect.poll(() => require('../dist/sync/store').busySyncs.size).toBe(0);
  const report = { syntheticOnly: true, physicalMicrophone: false, priorRecapAnswered: true, setupMs, firstAudioAfterInputMs: firstAudioMs, secondInputEndedAt: secondInputEnd, mouthMoved, state, errors, history: live.liveHistory(syncId), tracksEnded: await page.evaluate(() => window.__tracks.every(track => track.readyState === 'ended')), coverage: db.prepare('SELECT COUNT(*) AS n FROM sync_coverage').get().n };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  assert.equal(state.peers, 1); assert.deepEqual(errors, []); assert.equal(report.tracksEnded, true); assert.equal(report.coverage, 0);
  console.log(JSON.stringify({ root, setupMs, firstAudioAfterInputMs: firstAudioMs, onePeer: true, mouthMoved, tracksEnded: report.tracksEnded }));
})().catch(async error => { if (page) fs.writeFileSync(path.join(root, 'failure-wire.json'), JSON.stringify(await page.evaluate(() => ({ wire: window.__wire, status: document.querySelector('[role=status]')?.textContent })).catch(() => ({})), null, 2)); fs.writeFileSync(path.join(root, 'failure.txt'), error.stack); console.error(JSON.stringify({ root, error: error.message })); process.exitCode = 1; }).finally(async () => { clearTimeout(timer); await browser?.close(); await live.stopLiveCalls(); if (server) await new Promise(resolve => server.close(resolve)); schema.closeDb(); });
