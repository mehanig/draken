import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
let control: string, sessions: string;
function activity() {
  const id = crypto.randomUUID(), timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(sessions, `${id}.jsonl`), [
    { type: 'session', version: 3, id, cwd: '/demo/Trailboard', timestamp },
    { type: 'message', id: 'user', parentId: null, timestamp, message: { role: 'user', content: 'Check Trailboard' } },
    { type: 'message', id: 'agent', parentId: 'user', timestamp, message: { role: 'assistant', content: 'Implemented the Trailboard upload retry queue. Tests passed; device acceptance remains unverified.' } },
  ].map(JSON.stringify).join('\n') + '\n');
}
async function noAudio(page: Page, insecure = false) {
  await page.addInitScript(({ insecure }) => {
    const state = { microphone: 0, audio: 0, peers: 0 }; (window as any).__chatMedia = state;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { state.microphone++; throw Error('Chat must not capture'); } } });
    (window as any).AudioContext = class { constructor() { state.audio++; throw Error('Chat must not create audio'); } };
    (window as any).RTCPeerConnection = class { constructor() { state.peers++; throw Error('Chat must not create a peer'); } };
    if (insecure) { Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false }); Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }); }
  }, { insecure });
}
async function start(page: Page) {
  activity(); await page.goto('/'); await page.getByRole('button', { name: 'Chat instead', exact: true }).click();
  await expect(page).toHaveURL(/\/syncs\/\d+\/chat$/);
  await expect(page.getByRole('textbox', { name: 'Message Draken' })).toBeEnabled({ timeout: 20000 });
  return Number(new URL(page.url()).pathname.split('/')[2]);
}
test.beforeEach(async ({ page }) => {
  const overview = await (await page.request.get('/api/overview')).json();
  sessions = overview.session_root; expect(path.basename(path.dirname(sessions))).toMatch(/^draken-browser-/);
  control = path.join(sessions, 'fake-control.json'); fs.writeFileSync(control, '{}');
});
test.afterEach(async ({ page }) => {
  fs.writeFileSync(control, '{}'); const id = /\/syncs\/(\d+)/.exec(page.url())?.[1];
  if (id) {
    const status = await (await page.request.get('/api/voice/status', { maxRetries: 1 })).json();
    if (status.activeCall) await page.request.post(`/api/voice/live/calls/${status.activeCall.id}/end`, { data: {} });
    await page.request.post(`/api/syncs/${id}/cancel`);
    await expect.poll(async () => (await (await page.request.get(`/api/syncs/${id}`)).json()).busy).toBe(false);
    expect((await page.request.post(`/api/syncs/${id}/discard`)).ok()).toBe(true);
  }
});

test('chat works without voice setup or secure-context APIs, shows thinking and has a square mobile avatar', async ({ page }) => {
  await noAudio(page, true); const nativeRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/voice/live/')) nativeRequests.push(request.url()); });
  await page.route('**/api/voice/status', route => route.fulfill({ json: { installed: false, activeCall: null, httpsPort: 44433 } }));
  const id = await start(page), chat = page.getByRole('region', { name: 'Chat with Draken', exact: true });
  await expect(chat.locator('.chat-model')).toHaveCount(0);
  await expect(chat).not.toContainText('Text replies use');
  fs.writeFileSync(control, JSON.stringify({ delay: 4000 }));
  await page.getByRole('textbox', { name: 'Message Draken' }).fill('What is happening with Trailboard?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Chat status' })).toContainText('Draken is thinking');
  await chat.screenshot({ path: '.test-artifacts/chat-thinking-desktop.png' });
  await expect(chat.locator('.chat-message.assistant').filter({ hasNot: page.getByRole('status') })).toHaveCount(1, { timeout: 15000 });
  await expect(chat.getByRole('link', { name: /Inspect historical source/ }).first()).toHaveAttribute('rel', 'noopener noreferrer');
  const stored = await (await page.request.get(`/api/syncs/${id}`)).json();
  expect(stored.messages.filter((message: any) => message.role === 'user')).toHaveLength(1); expect(stored.status).toBe('open'); expect(stored.decisions).toBe('');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const avatar = await chat.getByRole('img', { name: 'Draken', exact: true }).boundingBox(); expect(avatar?.width).toBe(avatar?.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await chat.screenshot({ path: `.test-artifacts/chat-${width}.png` });
  }
  expect(await page.evaluate(() => (window as any).__chatMedia)).toEqual({ microphone: 0, audio: 0, peers: 0 }); expect(nativeRequests).toEqual([]);
  await page.reload(); await expect(chat.locator('.chat-message.user')).toHaveCount(1); await expect(chat.locator('.chat-message.assistant')).toHaveCount(1);
});

test('reload keeps an active reply, stop preserves the question, and retry does not review the sync', async ({ page }) => {
  await noAudio(page); const id = await start(page); fs.writeFileSync(control, JSON.stringify({ delay: 30000 }));
  await page.getByRole('textbox', { name: 'Message Draken' }).fill('What remains in Trailboard?'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Chat status' })).toContainText('Draken is thinking'); await page.reload();
  await expect(page.getByRole('status', { name: 'Chat status' })).toContainText('Draken is thinking'); await expect(page.locator('.chat-message.user')).toHaveCount(1);
  await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await expect(page.getByText('Reply stopped.', { exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/syncs/${id}`)).json()).messages).toHaveLength(1);
  fs.writeFileSync(control, '{}'); await page.getByRole('button', { name: 'Retry chat reply', exact: true }).click();
  await expect(page.locator('.chat-message.assistant').filter({ hasNot: page.getByRole('status') })).toHaveCount(1, { timeout: 15000 });
  const stored = await (await page.request.get(`/api/syncs/${id}`)).json(); expect(stored.messages).toHaveLength(3); expect(stored.status).toBe('open'); expect(stored.decisions).toBe('');
  expect(await page.evaluate(() => (window as any).__chatMedia)).toEqual({ microphone: 0, audio: 0, peers: 0 });
});

test('a lost accepted-send response recovers the same job, and multiline drafts are guarded', async ({ page }) => {
  await noAudio(page); const id = await start(page); let deliveries = 0;
  await page.route(`**/api/syncs/${id}/chat/messages`, async route => { deliveries++; await route.fetch(); await route.abort('failed'); });
  const input = page.getByRole('textbox', { name: 'Message Draken' }); await input.fill('What remains'); await input.press('Shift+Enter'); await input.press('End'); await input.press('x');
  expect(await input.inputValue()).toContain('\n'); await input.fill('What remains in Trailboard?'); await input.press('Enter');
  await expect(page.locator('.chat-message.assistant').filter({ hasNot: page.getByRole('status') })).toHaveCount(1, { timeout: 15000 }); expect(deliveries).toBe(1);
  expect((await (await page.request.get(`/api/syncs/${id}`)).json()).messages).toHaveLength(2);
  await input.fill('Unsent follow-up'); page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Voice & call history', exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/); await expect(input).toHaveValue('Unsent follow-up');
});

test('failed replies are retryable and sending chat never implicitly saves note edits', async ({ page }) => {
  await noAudio(page); const id = await start(page);
  await page.getByText('Decisions & carry-forward', { exact: true }).click(); await page.getByLabel('Decisions', { exact: true }).fill('Uncommitted note');
  await page.getByRole('textbox', { name: 'Message Draken' }).fill('What remains in Trailboard?'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Chat does not save decisions');
  let stored = await (await page.request.get(`/api/syncs/${id}`)).json(); expect(stored.decisions).toBe(''); expect(stored.messages).toHaveLength(0);
  await expect(page.getByLabel('Decisions', { exact: true })).toHaveValue('Uncommitted note'); await page.getByLabel('Decisions', { exact: true }).fill('');
  fs.writeFileSync(control, JSON.stringify({ hugeOutput: true })); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Reply failed.', { exact: true })).toBeVisible(); await page.reload(); await expect(page.getByText('Reply failed.', { exact: true })).toBeVisible();
  stored = await (await page.request.get(`/api/syncs/${id}`)).json(); expect(stored.messages).toHaveLength(1); expect(stored.messages[0].role).toBe('user');
  fs.writeFileSync(control, '{}'); await page.getByRole('button', { name: 'Retry chat reply', exact: true }).click();
  await expect(page.locator('.chat-message.assistant').filter({ hasNot: page.getByRole('status') })).toHaveCount(1, { timeout: 15000 });
  stored = await (await page.request.get(`/api/syncs/${id}`)).json(); expect(stored.status).toBe('open'); expect(stored.decisions).toBe(''); expect(stored.messages).toHaveLength(3);
});

test('Chat instead consumes an auto-call intent while preparation is still running', async ({ page }) => {
  await noAudio(page); activity(); fs.writeFileSync(control, JSON.stringify({ delay: 1200 })); const calls: string[] = [];
  page.on('request', request => { if (request.url().includes('/voice/live/')) calls.push(request.url()); });
  await page.goto('/'); await page.getByRole('button', { name: 'Sync with Draken', exact: true }).click(); await expect(page).toHaveURL(/\/syncs\/\d+$/);
  await page.getByRole('button', { name: 'Chat instead', exact: true }).click(); await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole('textbox', { name: 'Message Draken' })).toBeEnabled({ timeout: 20000 });
  expect(calls).toEqual([]); expect(await page.evaluate(() => (window as any).__chatMedia)).toEqual({ microphone: 0, audio: 0, peers: 0 });
});
