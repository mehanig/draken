import { test, expect } from '@playwright/test';
import { nativePeer } from './native-fixture';
import { isFreePreviewRequest } from './preparation-preview-fixture';

test('paid cache preparation is a separate explicit choice with visible failures and retry, never a sync action', async ({ page }) => {
  await nativePeer(page);
  let indexing = true, fail = false;
  let summary = { enabled: false, status: 'off', prepared_entries: 0, last_completed_at: null as string | null, error: '' };
  const mutations: { path: string; body: unknown }[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && !isFreePreviewRequest(request)) mutations.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await page.route('**/api/settings/auto-index', route => route.fulfill({ json: {
    enabled: indexing, summary_enabled: summary.enabled, check_seconds: 60, batch_records: 64,
    phase: indexing ? 'waiting' : 'off', pending_records: 7, pending_entries: 200, last_completed_at: null, error: '',
  } }));
  await page.route('**/api/settings/auto-summary', route => {
    if (route.request().method() === 'PATCH') {
      if (fail) {
        summary = { ...summary, prepared_entries: Math.max(64, summary.prepared_entries + 1), last_completed_at: '2026-01-01T00:00:00Z' };
        return route.fulfill({ status: 503, json: { error: 'Synthetic consent write failure' } });
      }
      const { enabled } = route.request().postDataJSON();
      summary = { ...summary, enabled, status: enabled ? 'waiting' : 'off', error: '' };
    }
    return route.fulfill({ json: summary });
  });
  const open = async () => {
    await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
    return page.getByRole('dialog', { name: 'Settings', exact: true });
  };
  await page.goto('/'); let dialog = await open();
  let toggle = dialog.getByRole('switch', { name: /Prepare summaries ahead/ });
  await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
  await expect(dialog).toContainText('quota or API billing');
  await expect(dialog).toContainText('Never create a sync or briefing automatically');
  expect(mutations).toEqual([]);
  fail = true; await toggle.click();
  // This count arrives only in the successful follow-up GET. Its rendered value
  // proves that polling cannot erase the preceding failed write's explanation.
  await expect(dialog).toContainText('Last successful background pass: 64 entries');
  await expect(dialog.getByRole('alert')).toHaveText('Synthetic consent write failure');
  await expect(toggle).not.toBeChecked();
  fail = false; await toggle.click(); await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked();
  await page.reload(); dialog = await open(); toggle = dialog.getByRole('switch', { name: /Prepare summaries ahead/ });
  await expect(toggle).toBeChecked();
  fail = true; await toggle.click();
  await expect(dialog).toContainText('Last successful background pass: 65 entries');
  await expect(dialog.getByRole('alert')).toHaveText('Synthetic consent write failure'); await expect(toggle).toBeChecked();
  fail = false;
  summary = { ...summary, status: 'error', error: 'Paid work paused; retry explicitly.', prepared_entries: 128, last_completed_at: '2026-01-01T00:00:00Z' };
  await page.reload(); dialog = await open();
  await expect(dialog).toContainText('Last successful background pass: 128 entries');
  await expect(dialog.getByRole('alert')).toHaveText(summary.error);
  await dialog.getByRole('button', { name: 'Retry summary preparation' }).click();
  await expect(dialog.getByRole('button', { name: 'Retry summary preparation' })).toHaveCount(0);
  indexing = false;
  await page.reload(); dialog = await open(); toggle = dialog.getByRole('switch', { name: /Prepare summaries ahead/ });
  await expect(dialog).toContainText('paused while automatic indexing is off');
  // Turning off remains possible even while the prerequisite is off.
  await expect(toggle).toBeEnabled(); await toggle.click(); await expect(toggle).not.toBeChecked(); await expect(toggle).toBeDisabled();
  expect(mutations).toEqual([true, true, false, true, false].map(enabled => ({ path: '/api/settings/auto-summary', body: { enabled } })));
  expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
});
