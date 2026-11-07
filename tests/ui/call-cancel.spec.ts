import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativePeer } from './native-fixture';

test('End releases a server reservation even when the browser has not received the create response', async ({ page }) => {
  const overview = await (await page.request.get('/api/overview')).json();
  expect(path.basename(path.dirname(overview.session_root))).toMatch(/^draken-browser-/);
  fs.writeFileSync(path.join(overview.session_root, 'fake-control.json'), JSON.stringify({ delay: 20 }));
  await nativePeer(page);
  const { sync } = await (await page.request.post('/api/syncs/start-call', { data: { request_id: randomUUID() } })).json();
  let reserved = '', release!: () => void;
  const held = new Promise<void>(resolve => release = resolve);
  try {
    await expect.poll(async () => (await (await page.request.get(`/api/syncs/${sync.id}/progress`)).json()).run?.status, { timeout: 30000 }).toBe('completed');
    await page.goto(`/syncs/${sync.id}`);
    await expect(page.getByRole('button', { name: 'Call Draken', exact: true })).toBeEnabled();
    await page.route('**/api/voice/live/calls', async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      reserved = (await response.json()).id;
      expect(reserved).toBe(route.request().postDataJSON().requestId);
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole('button', { name: 'Call Draken', exact: true }).click();
    await expect.poll(() => reserved).not.toBe('');
    expect((await (await page.request.get('/api/voice/status')).json()).activeCall.id).toBe(reserved);
    await page.getByRole('button', { name: 'End call', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect.poll(async () => (await (await page.request.get('/api/voice/status')).json()).activeCall).toBeNull();
    release();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Call Draken', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
    expect((await (await page.request.get(`/api/syncs/${sync.id}`)).json()).status).toBe('open');
  } finally {
    release();
    if (reserved) await page.request.post(`/api/voice/live/calls/${reserved}/end`, { data: {} });
    // Leave the shared synthetic source inventory available to the other tests.
    await expect.poll(async () => (await (await page.request.get(`/api/syncs/${sync.id}/progress`)).json()).busy).toBe(false);
    expect((await page.request.post(`/api/syncs/${sync.id}/discard`)).ok()).toBe(true);
  }
});
