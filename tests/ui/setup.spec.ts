import { test, expect } from '@playwright/test';
import { nativePeer } from './native-fixture';

test('first-run instructions explain private pi and separate voice login; readiness never starts a sync or microphone', async ({ page }) => {
  await nativePeer(page);
  const home = await (await page.request.get('/api/home')).json(), voice = await (await page.request.get('/api/voice/status')).json();
  let state = 'missing', audio = false, fail = false;
  const mutations: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') mutations.push(new URL(request.url()).pathname); });
  await page.route('**/api/home', route => route.fulfill({ json: { ...home, syncs: [], busy: false, active_call: false } }));
  await page.route('**/api/voice/status', route => route.fulfill({ json: { ...voice, installed: audio } }));
  await page.route('**/api/setup*', route => fail ? route.abort('failed') : route.fulfill({ json: {
    data_dir: '/synthetic/private-draken', pi: { source: state === 'missing' ? 'external' : 'managed', state, version: state === 'missing' ? null : '1.5.0',
      agent_dir: '/synthetic/private-draken/pi/agent', models: [], message: state === 'missing' ? 'Summarization needs pi. Run draken setup, then draken login.' : state === 'needs_login' ? 'Use /login in pi.' : 'Credential presence is not model access.' },
  } }));
  await page.goto('/'); const panel = page.getByRole('region', { name: 'Draken setup' }), start = page.getByRole('button', { name: 'Sync with Draken' });
  await expect(panel).toContainText('First-time setup'); await expect(panel).toContainText('pi not found'); await expect(start).toBeDisabled();
  await expect(panel).toContainText('draken setup'); await expect(panel).toContainText('draken login'); await expect(panel).toContainText('/login');
  await expect(panel).toContainText('draken voice setup'); await expect(panel).toContainText('draken voice login'); await expect(panel).toContainText('same environment');
  state = 'needs_login'; await panel.getByRole('button', { name: 'Check setup again' }).click(); await expect(panel).toContainText('sign-in needed'); await expect(start).toBeDisabled();
  state = 'configured'; audio = true; await panel.getByRole('button', { name: 'Check setup again' }).click(); await expect(start).toBeEnabled();
  await expect(panel).toContainText('Draken-private pi 1.5.0'); expect(mutations).toEqual([]); expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
  fail = true; await panel.getByRole('button', { name: 'Check setup again' }).click(); await expect(panel.getByRole('alert')).toContainText('may be stale'); await expect(start).toBeDisabled();
  await page.setViewportSize({ width: 320, height: 700 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.test-artifacts/onboarding-mobile.png' });
  fail = false; await panel.getByRole('button', { name: 'Check setup again' }).click(); await expect(start).toBeEnabled();
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true }); await expect(dialog.getByRole('region', { name: 'Draken setup' })).toContainText('Runtime & sign-in');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); expect(mutations).toEqual([]);
});
