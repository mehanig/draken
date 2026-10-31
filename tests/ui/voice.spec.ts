import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

async function prepare(page: Page) {
  const status = await (await page.request.get('/api/voice/status')).json();
  if (status.activeCall) await page.request.post(`/api/voice/calls/${status.activeCall.id}/end`, { data: {} });
  const overview = await (await page.request.get('/api/overview')).json();
  const root = path.dirname(overview.session_root);
  expect(path.basename(root)).toMatch(/^draken-browser-/);
  if (overview.active_sync_id) await page.request.post(`/api/syncs/${overview.active_sync_id}/discard`);
  fs.writeFileSync(path.join(overview.session_root, 'fake-control.json'), JSON.stringify({ delay: 50 }));
  fs.writeFileSync(path.join(root, 'audio/audio-control.json'), JSON.stringify({ seconds: 1 }));
  const id = randomUUID(), timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(overview.session_root, `${id}.jsonl`), [
    { type: 'session', version: 3, id, cwd: '/demo/voice-export', timestamp },
    { type: 'message', id: 'q', parentId: null, timestamp, message: { role: 'user', content: 'Fix export timeouts' } },
    { type: 'message', id: 'a', parentId: 'q', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'Implemented bounded retry.' }] } },
    { type: 'message', id: 't', parentId: 'a', timestamp, message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'Export tests: 5 passed, 0 failed. Deployment not checked.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const result = await (await page.request.post('/api/syncs', { data: {} })).json();
  const syncId = result.sync.id;
  expect((await page.request.post(`/api/syncs/${syncId}/briefing`)).status()).toBe(202);
  await expect.poll(async () => (await (await page.request.get(`/api/syncs/${syncId}/progress`)).json()).complete).toBe(true);
  return { syncId, root };
}

async function virtualMicrophone(page: Page, denied = false) {
  await page.route('**/__voice_question.wav', route => route.fulfill({ path: path.join(__dirname, '../fixtures/voice-question.wav'), contentType: 'audio/wav' }));
  await page.addInitScript(({ denied }) => {
    const microphones: { context: AudioContext; destination: MediaStreamAudioDestinationNode }[] = [];
    (window as any).__microphones = microphones;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      if (denied) throw new DOMException('Synthetic permission refusal', 'NotAllowedError');
      const context = new AudioContext(); await context.resume();
      const destination = context.createMediaStreamDestination(); microphones.push({ context, destination });
      return destination.stream;
    } });
    (window as any).__say = async () => {
      const mic = [...microphones].reverse().find(item => item.destination.stream.getTracks().some(track => track.readyState === 'live'));
      if (!mic) throw new Error('No active virtual microphone');
      const response = await fetch('/__voice_question.wav');
      const buffer = await mic.context.decodeAudioData(await response.arrayBuffer());
      const source = mic.context.createBufferSource(); source.buffer = buffer; source.connect(mic.destination);
      await mic.context.resume();
      await new Promise<void>(resolve => { source.onended = () => { source.disconnect(); resolve(); }; source.start(); });
    };
  }, { denied });
}
const dialog = (page: Page) => page.getByRole('dialog', { name: /Sync #/ });
async function openCall(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Call Draken', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('status')).toHaveText('Your turn', { timeout: 15000 });
}
async function typeQuestion(page: Page, text: string) {
  if (!await page.getByRole('textbox', { name: 'Type a question for this call' }).isVisible())
    await page.getByRole('button', { name: 'Type a question', exact: true }).click();
  await page.getByRole('textbox', { name: 'Type a question for this call' }).fill(text);
  await page.getByRole('button', { name: 'Send voice-call question' }).click();
}
async function stoppedTracks(page: Page) {
  return page.evaluate(() => (window as any).__microphones.every((item: any) => item.destination.stream.getTracks().every((track: MediaStreamTrack) => track.readyState === 'ended')));
}

test('call playback, mute, source inspection, interruption, failure recovery and mobile layout', async ({ page }) => {
  const { syncId } = await prepare(page);
  await virtualMicrophone(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const noteWrites: string[] = []; page.on('request', request => { if (request.method() === 'PATCH' && /\/notes$/.test(request.url())) noteWrites.push(request.url()); });
  await openCall(page);
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  expect(await stoppedTracks(page)).toBe(true);
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  expect(await stoppedTracks(page)).toBe(false);
  await page.evaluate(() => {
    const track = (window as any).__microphones.at(-1).destination.stream.getAudioTracks()[0];
    track.stop(); track.dispatchEvent(new Event('ended')); // Simulate device unplugging, not application mute.
  });
  await page.getByRole('button', { name: 'Enable mic', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute', exact: true })).toBeVisible();
  expect(await stoppedTracks(page)).toBe(false);
  await typeQuestion(page, 'Did the export tests pass?');
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  await expect(page.locator('.voice-answer')).toContainText('Deployment is not confirmed');
  await page.getByRole('button', { name: /Source E/ }).first().click();
  await expect(page.locator('.voice-source pre')).toContainText(/tests/i);
  await dialog(page).screenshot({ path: '.test-artifacts/voice-desktop.png' });
  await expect(dialog(page).getByRole('status')).toHaveText('Your turn');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog(page).screenshot({ path: '.test-artifacts/voice-mobile.png' });
  await page.getByRole('button', { name: 'Close source' }).click();
  await typeQuestion(page, 'What is still blocked?');
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
  await expect(dialog(page).getByRole('status')).toHaveText('Your turn');
  await typeQuestion(page, 'FAIL');
  await expect(dialog(page).getByRole('alert')).toContainText('pi failed');
  await typeQuestion(page, 'What do we know about deployment?');
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  await expect(dialog(page).getByRole('status')).toHaveText('Your turn');
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible(); expect(await stoppedTracks(page)).toBe(true);
  const history = await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json();
  expect(history[0].status).toBe('ended');
  expect(history[0].turns.map((turn: any) => turn.status)).toEqual(['completed', 'interrupted', 'failed', 'completed']);
  const sync = await (await page.request.get(`/api/syncs/${syncId}`)).json();
  expect(sync.status).toBe('open'); expect(sync.messages).toHaveLength(8);
  expect(errors).toEqual([]); expect(noteWrites).toEqual([]);
});

test('headphone mode supports hands-free speech and spoken interruption', async ({ page }) => {
  test.setTimeout(45000);
  const { syncId } = await prepare(page);
  await virtualMicrophone(page);
  const external: string[] = [];
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== 'http://127.0.0.1:41889') external.push(request.url()); });
  await openCall(page);
  await page.getByRole('button', { name: 'Headphone mode', exact: true }).click();
  const firstSpeech = page.evaluate(() => (window as any).__say());
  await expect(dialog(page).getByRole('status')).toHaveText('Listening to you');
  await firstSpeech;
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  const interruptingSpeech = page.evaluate(() => (window as any).__say());
  await expect(dialog(page).getByRole('status')).toHaveText('Listening to you');
  await interruptingSpeech;
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  await expect(dialog(page).getByRole('status')).toHaveText('Your turn');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).not.toBeVisible(); expect(await stoppedTracks(page)).toBe(true);
  const history = await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json();
  expect(history[0].turns.map((turn: any) => turn.status)).toEqual(['interrupted', 'completed']);
  expect(history[0].turns.every((turn: any) => turn.question === 'Did the export tests pass?')).toBe(true);
  expect(external).toEqual([]);
});

test('speaker-safe playback ignores microphone feedback and listens again after the entire reply', async ({ page }) => {
  test.setTimeout(45000);
  const { syncId, root } = await prepare(page);
  fs.writeFileSync(path.join(root, 'audio/audio-control.json'), JSON.stringify({ seconds: 3 }));
  await virtualMicrophone(page); await openCall(page);
  let recognitions = 0; page.on('request', request => { if (request.url().endsWith('/transcribe')) recognitions++; });
  await expect(page.getByRole('button', { name: 'Headphone mode', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await typeQuestion(page, 'Did the export tests pass?');
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  await page.evaluate(() => (window as any).__say()); // Speech leaking into the microphone during output.
  await expect(dialog(page).getByRole('status')).toHaveText('Your turn', { timeout: 10000 });
  expect(recognitions).toBe(0);
  let history = await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json();
  expect(history[0].turns).toHaveLength(1); expect(history[0].turns[0].status).toBe('completed');
  await page.evaluate(() => (window as any).__say());
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  await expect(dialog(page).getByRole('status')).toHaveText('Your turn', { timeout: 10000 });
  expect(recognitions).toBe(1);
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible(); expect(await stoppedTracks(page)).toBe(true);
  history = await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json();
  expect(history[0].turns.map((turn: any) => turn.status)).toEqual(['completed', 'completed']);
});

test('a later format error cannot stop a valid sentence after its first second', async ({ page }) => {
  const { syncId, root } = await prepare(page);
  fs.writeFileSync(path.join(root, 'sessions/fake-control.json'), JSON.stringify({ voiceCommas: true, voiceBadTail: true, streamDelay: 20 }));
  fs.writeFileSync(path.join(root, 'audio/audio-control.json'), JSON.stringify({ seconds: 3 }));
  await virtualMicrophone(page); await openCall(page);
  await typeQuestion(page, 'Did the export tests pass?');
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  await expect(page.locator('.voice-notice')).toContainText('validated part');
  await expect(dialog(page).getByRole('status')).toHaveText('Your turn', { timeout: 10000 });
  const history = await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json();
  expect(history[0].turns[0].status).toBe('failed');
  expect(history[0].turns[0].heard_text).toBe('The targeted export tests passed. Deployment is not confirmed by this evidence.');
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
});

test('microphone denial keeps a usable typed call with local spoken replies', async ({ page }) => {
  await prepare(page); await virtualMicrophone(page, true); await page.goto('/');
  await page.getByRole('button', { name: 'Call Draken', exact: true }).click();
  await expect(dialog(page).getByRole('status')).toHaveText('Microphone muted');
  await expect(page.getByRole('textbox', { name: 'Type a question for this call' })).toBeVisible();
  await typeQuestion(page, 'Can you explain the test results?');
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  await expect(dialog(page).getByRole('status')).toHaveText('Microphone muted');
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
});

test('a lost playback receipt can be retried without replaying or regenerating the answer', async ({ page }) => {
  const { syncId } = await prepare(page); await virtualMicrophone(page); await openCall(page);
  let failed = false; const receipts: number[] = [];
  await page.route('**/api/voice/calls/*/played', async route => {
    const body = route.request().postDataJSON(); receipts.push(body.index);
    if (body.turnId && !failed) { failed = true; await route.fulfill({ status: 503, json: { error: 'Synthetic receipt failure' } }); }
    else await route.continue();
  });
  await typeQuestion(page, 'Did the export tests pass?');
  await expect(dialog(page).getByRole('status')).toHaveText('Sound paused');
  await page.getByRole('button', { name: 'Resume sound', exact: true }).click();
  await expect(dialog(page).getByRole('status')).toHaveText('Your turn');
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  expect(receipts).toEqual([0, 0, 1]);
  const history = await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json();
  expect(history[0].turns).toHaveLength(1); expect(history[0].turns[0].status).toBe('completed');
});

test('reload ends the call and cancels a pending model reply rather than resuming microphone capture', async ({ page }) => {
  const { syncId, root } = await prepare(page); await virtualMicrophone(page); await openCall(page);
  fs.writeFileSync(path.join(root, 'sessions/fake-control.json'), JSON.stringify({ delay: 4000 }));
  await typeQuestion(page, 'Check the export tests again');
  await expect(dialog(page).getByRole('status')).toHaveText('Thinking it through');
  await expect.poll(async () => (await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json())[0].turns.length).toBe(1);
  await page.reload();
  await expect(dialog(page)).not.toBeVisible();
  await expect.poll(async () => (await (await page.request.get('/api/voice/status')).json()).activeCall).toBeNull();
  const history = await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json();
  expect(history[0].turns[0].status).toBe('interrupted');
});
