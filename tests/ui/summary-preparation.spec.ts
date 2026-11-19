import { test, expect } from '@playwright/test';
import { nativePeer } from './native-fixture';

test('one preparation control preserves old opt-outs, exposes paid failures and retries both stages without creating a sync', async ({ page }) => {
  await nativePeer(page);
  let indexing = true, fail = false;
  let summary = { enabled: false, status: 'off', prepared_entries: 0, last_completed_at: null as string | null, error: '' };
  const mutations: unknown[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET') mutations.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await page.route('**/api/settings/auto-index', route => {
    if (route.request().method() === 'PATCH') {
      if (fail) {
        summary = { ...summary, prepared_entries: 64, last_completed_at: '2026-01-01T00:00:00Z' };
        return route.fulfill({ status: 503, json: { error: 'Synthetic consent write failure' } });
      }
      indexing = route.request().postDataJSON().enabled;
      summary = { ...summary, enabled: indexing, status: indexing ? 'waiting' : 'off', error: '' };
    }
    return route.fulfill({ json: { enabled: indexing, summary_enabled: summary.enabled, summary,
      check_seconds: 60, batch_records: 1, phase: summary.error ? 'error' : indexing ? 'waiting' : 'off',
      pending_records: 7, pending_entries: 200, last_completed_at: null, error: summary.error } });
  });
  const open = async () => {
    await page.getByRole('banner').getByRole('link', { name: 'Settings', exact: true }).click();
    return page.getByRole('main', { name: 'Settings', exact: true });
  };
  await page.goto('/'); let dialog = await open();
  let toggle = dialog.getByRole('switch', { name: /Automatically prepare history/ });
  await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
  await expect(dialog).toContainText('quota or API billing');
  await expect(dialog).toContainText('Indexing only: summary preparation is off');
  expect(mutations).toEqual([]);
  fail = true; await toggle.click();
  await expect(dialog).toContainText('Last successful summary pass: 64 entries');
  await expect(dialog.getByRole('alert')).toHaveText('Synthetic consent write failure');
  await expect(toggle).not.toBeChecked();
  fail = false; await toggle.check(); await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked();
  summary = { ...summary, status: 'error', error: 'Paid work paused; retry explicitly.' };
  await page.reload();
  await expect(page.getByRole('region', { name: 'Automatic preparation', exact: true }).getByRole('alert')).toHaveText(summary.error);
  dialog = await open(); toggle = dialog.getByRole('switch', { name: /Automatically prepare history/ });
  await expect(toggle).toBeChecked();
  await dialog.getByRole('button', { name: 'Retry automatic preparation' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await toggle.uncheck(); await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
  expect(mutations).toEqual([true, true, true, false].map(enabled => ({ path: '/api/settings/auto-index', body: { enabled, summaries: true } })));
  expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
});
