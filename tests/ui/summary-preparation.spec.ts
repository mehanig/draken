import { test, expect } from '@playwright/test';
import { nativePeer } from './native-fixture';

test('one preparation control preserves old opt-outs, exposes paid failures and retries both stages without creating a sync', async ({ page }) => {
  await nativePeer(page);
  let indexing = true, fail = false, indexingError = '';
  let summary = { enabled: false, status: 'off', prepared_entries: 0, last_completed_at: null as string | null, error: '', error_count: 0, failed_operations: 0, operation: undefined as string | undefined };
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
      indexing = route.request().postDataJSON().enabled; indexingError = '';
      summary = { ...summary, enabled: indexing, status: indexing ? 'waiting' : 'off', error: '', failed_operations: 0 };
    }
    return route.fulfill({ json: { enabled: indexing, summary_enabled: summary.enabled, summary,
      check_seconds: 60, batch_records: 1, phase: summary.error ? 'error' : summary.status === 'running' ? 'summarizing' : indexing ? 'waiting' : 'off', indexing_error: indexingError,
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
  await expect(dialog).toContainText('Model preparation: off');
  expect(mutations).toEqual([]);
  fail = true; await toggle.click();
  await expect(dialog).toContainText('Last completed automatic preparation attempt: 64 entries');
  await expect(dialog.getByRole('alert')).toHaveText('Synthetic consent write failure');
  await expect(toggle).not.toBeChecked();
  fail = false; await toggle.check(); await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked();
  summary = { ...summary, status: 'running', operation: 'Workflow comparison' };
  await page.reload(); await expect(page.getByRole('status').filter({ hasText: 'Workflow comparison…' })).toBeVisible();
  summary = { ...summary, status: 'waiting', error_count: 2, failed_operations: 2, operation: undefined };
  await page.reload();
  await expect(page.getByRole('region', { name: 'Automatic preparation', exact: true })).toContainText('2 preparation errors recorded.');
  dialog = await open(); toggle = dialog.getByRole('switch', { name: /Automatically prepare history/ });
  await expect(toggle).toBeChecked();
  await expect(dialog).toContainText('Local indexing: enabled (no model API). Model preparation: enabled.');
  await expect(dialog).toContainText('Retrying can make model calls and incur costs. It does not execute saved workflows.');
  indexingError = 'Local indexing did not finish. Completed indexing work is retained.';
  await page.reload();
  await expect(dialog.getByRole('alert')).toHaveText(indexingError);
  await expect(dialog).toContainText('Local indexing: enabled');
  await dialog.getByRole('button', { name: 'Retry failed operations' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);await expect(dialog).toContainText('2 preparation errors recorded.');
  await expect(dialog.getByRole('button', { name: 'Retry failed operations' })).toHaveCount(0);
  await toggle.uncheck(); await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
  expect(mutations).toEqual([true, true, true, false].map(enabled => ({ path: '/api/settings/auto-index', body: { enabled, summaries: true } })));
  expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
});
