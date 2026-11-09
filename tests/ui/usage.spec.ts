import { test, expect } from '@playwright/test';
function usage(range = '7d', bucket = '1h', usd = 1.25) {
  const totals = { cost: { usd, complete: false }, completed_batches: 3, entries: 192, requests: 5, incomplete_pricing: 1, approximate_timing: 2, failed_attempts: 1 };
  return { range, bucket, from: '2026-01-14T12:30:00.000Z', to: '2026-01-15T12:30:00.000Z', active_attempts: 1, totals,
    buckets: [{ ...totals, to: '2026-01-15T12:00:00.000Z', from: '2026-01-14T12:30:00.000Z', requests: 4, incomplete_pricing: 0, cost: { usd, complete: true } },
      { ...totals, from: '2026-01-15T12:00:00.000Z', to: '2026-01-15T12:30:00.000Z', cost: { usd: null, complete: false }, completed_batches: 0, entries: 0, requests: 1 }] };
}
test('Settings usage offers every range and bucket, honest partial costs and a wider responsive read-only dashboard', async ({ page }) => {
  test.setTimeout(60000);
  let requests = 0, mutations = 0;
  page.on('request', request => { if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations++; });
  await page.route('**/api/settings/preparation-usage?*', route => { requests++; const q = new URL(route.request().url()).searchParams; return route.fulfill({ json: usage(q.get('range')!, q.get('bucket')!) }); });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true }), panel = dialog.getByRole('region', { name: 'Preparation usage', exact: true });
  await expect(panel).toContainText('Known cost subtotal'); await expect(panel.locator('.usage-totals')).toContainText('$1.25'); await expect(panel).toContainText('not your bill');
  expect((await dialog.boundingBox())!.width).toBeGreaterThan(800);
  for (const range of ['6h', '1d', '7d', '14d']) for (const bucket of ['1h', '6h', '24h']) {
    await panel.getByLabel('Look back').selectOption(range); await panel.getByLabel('Bucket size').selectOption(bucket);
    await expect(panel.getByRole('img')).toHaveAttribute('aria-label', new RegExp(`by ${bucket} bucket`));
    await expect(panel.locator('.usage-totals')).toContainText('$1.25');
  }
  await panel.getByRole('combobox', { name: 'Chart', exact: true }).selectOption('batches'); await expect(panel.getByRole('img')).toHaveAttribute('aria-label', /Completed batches/);
  await panel.getByRole('combobox', { name: 'Chart', exact: true }).selectOption('cost');
  await page.screenshot({ path: '.test-artifacts/usage-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({ path: '.test-artifacts/usage-mobile.png' });
  await panel.getByText('Bucket details', { exact: true }).click(); await expect(panel.getByRole('table')).toContainText('Unavailable (partial)');
  expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.keyboard.press('Escape'); const closed = requests; await page.waitForTimeout(16000); expect(requests).toBe(closed); expect(mutations).toBe(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(panel.getByLabel('Look back')).toHaveValue('14d'); await expect(panel.getByLabel('Bucket size')).toHaveValue('24h'); await expect(panel.locator('.usage-totals')).toContainText('$1.25');
});
test('changed range ignores an old response and a failed refresh never presents stale costs as current', async ({ page }) => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let first = true, fail = false;
  await page.route('**/api/settings/preparation-usage?*', async route => {
    const q = new URL(route.request().url()).searchParams;
    if (first) { first = false; await held; await route.fulfill({ json: usage('7d', '1h', 999) }).catch(() => {}); return; }
    if (fail) { await route.fulfill({ status: 503, json: { error: 'Synthetic usage read failure' } }); return; }
    await route.fulfill({ json: usage(q.get('range')!, q.get('bucket')!, 2.5) });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Preparation usage', exact: true }); await expect(panel).toContainText('Loading preparation usage');
  await expect.poll(() => first).toBe(false); await panel.getByLabel('Look back').selectOption('1d'); await expect(panel.locator('.usage-totals')).toContainText('$2.50');
  release(); await page.waitForTimeout(100); await expect(panel).not.toContainText('$999');
  fail = true; await panel.getByLabel('Bucket size').selectOption('6h'); await expect(panel.getByRole('alert')).toContainText('Usage unavailable'); await expect(panel.locator('.usage-totals')).toHaveCount(0);
  fail = false; await panel.getByLabel('Look back').selectOption('6h'); await expect(panel.locator('.usage-totals')).toContainText('$2.50');
});
