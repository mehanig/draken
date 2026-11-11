import { test, expect } from '@playwright/test';

test('Home exposes one automatic pipeline with truthful summary progress, readiness and errors', async ({ page }) => {
  let state: any = { enabled: true, check_seconds: 60, batch_records: 64, phase: 'briefing', pending_records: 64, pending_entries: 0, last_completed_at: null, error: '', sync_id: 7, ready_sync_id: null, progress: { stage: 'Summarizing a source batch', completed: 30, total: 64, invocations: 2, max_invocations: 120 } };
  let unavailable = false, mutations = 0;
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method())) mutations++; });
  await page.addInitScript(() => {
    (window as any).__captures = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { (window as any).__captures++; throw Error('No capture while viewing progress'); } } });
  });
  await page.route('**/api/settings/auto-index', route => unavailable ? route.abort() : route.fulfill({ json: state }));
  await page.route('**/api/memory/progress', route => route.fulfill({ json: { active: false, background: false, queued: 0, elapsed_ms: 0, updated_at: null, work: null } }));
  await page.goto('/');
  const progress = page.getByRole('region', { name: 'Automatic preparation', exact: true });
  await expect(progress).toBeVisible(); await expect(progress).toContainText('Preparing your next briefing');
  await expect(progress.getByRole('progressbar', { name: 'Automatic briefing summaries' })).toHaveAttribute('value', '30');
  await expect(progress).toContainText('30 / 64 entries summarized'); await expect(progress).toContainText('2 / 120 model calls');
  await expect(page.getByText('not yet in a sync', { exact: false })).toBeVisible();
  for (const width of [390, 1440]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  state = { ...state, phase: 'waiting', sync_id: null, ready_sync_id: 7, progress: null, pending_entries: 3, last_completed_at: new Date().toISOString() };
  await expect(progress).toContainText('Your next briefing is prepared', { timeout: 8000 });
  await expect(progress).toContainText('3 entries not yet assigned to a preparation batch'); await expect(progress.getByRole('link', { name: 'Open prepared briefing' })).toHaveAttribute('href', '/syncs/7');
  await expect(progress).not.toContainText('unfinished preparation');
  state = { ...state, phase: 'error', error: 'Automatic briefing stopped. Retry explicitly.', ready_sync_id: null, sync_id: 8, pending_entries: 0, progress: { stage: 'Recapping earlier sync #7', completed: 0, total: 98, invocations: 2, max_invocations: 120 } };
  await expect(progress.getByRole('alert')).toContainText('Retry explicitly', { timeout: 8000 });
  await expect(progress).toContainText('0 entries not yet assigned to a preparation batch');
  await expect(progress).toContainText('98 entries in unfinished preparation #8');
  await expect(progress).toContainText('Stopped at: Recapping earlier sync #7');
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog.getByRole('switch', { name: /Automatically prepare conversations/ })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Retry automatic preparation' })).toBeVisible();
  await expect(dialog).toContainText('configured pi summary and final models'); await page.keyboard.press('Escape');
  unavailable = true; await expect(page.getByRole('status').filter({ hasText: 'Automatic preparation status is temporarily unavailable' })).toBeVisible({ timeout: 8000 });
  expect(mutations).toBe(0); expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
});
