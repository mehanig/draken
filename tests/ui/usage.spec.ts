import { test, expect } from '@playwright/test';
function usage(range = '7d', bucket = '1h', usd: number | null = 1.25, model: string | null = null, operation: string | null = null) {
  const totals = { cost: { usd, complete: false }, completed_batches: 3, entries: 192, requests: 5, incomplete_pricing: 1, approximate_timing: 2, failed_attempts: 1 };
  return { range, bucket, filters: { model, operation }, models: ['openai/gpt-6-astra', 'openai/gpt-6-luna', 'unknown'], operations: ['summarize', 'compare_workflow_identity', 'enrich_workflow', 'unknown'], from: '2026-01-14T12:30:00.000Z', to: '2026-01-15T12:30:00.000Z', active_attempts: 1, totals,
    buckets: [{ ...totals, to: '2026-01-15T12:00:00.000Z', from: '2026-01-14T12:30:00.000Z', requests: 4, incomplete_pricing: 0, cost: { usd, complete: true } },
      { ...totals, from: '2026-01-15T12:00:00.000Z', to: '2026-01-15T12:30:00.000Z', cost: { usd: null, complete: false }, completed_batches: 0, entries: 0, requests: 1 }] };
}
test('Settings usage offers every range and bucket, honest partial costs and a wider responsive read-only dashboard', async ({ page }) => {
  test.setTimeout(60000);
  let requests = 0, mutations = 0;
  page.on('request', request => { if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations++; });
  await page.route('**/api/settings/preparation-usage?*', route => { requests++; const q = new URL(route.request().url()).searchParams; return route.fulfill({ json: usage(q.get('range')!, q.get('bucket')!) }); });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/settings');
  const dialog = page.getByRole('main', { name: 'Settings', exact: true }), panel = dialog.getByRole('region', { name: 'Preparation usage', exact: true });
  await expect(panel).toContainText('Known cost subtotal'); await expect(panel.locator('.usage-totals')).toContainText('$1.25'); await expect(panel).toContainText('not your bill');
  expect((await dialog.boundingBox())!.width).toBeGreaterThan(800);
  await expect(panel.locator('.usage-y-axis span')).toHaveText(['$0', '$0.50', '$1.00', '$1.50']);
  expect(Number(await panel.locator('.usage-chart rect').first().getAttribute('height'))).toBeCloseTo(1.25 / 1.5 * 112);
  await expect(panel.locator('.usage-gridline')).toHaveCount(4);
  for (const range of ['6h', '1d', '7d', '14d']) for (const bucket of ['1h', '6h', '24h']) {
    await panel.getByLabel('Look back').selectOption(range); await panel.getByLabel('Bucket size').selectOption(bucket);
    await expect(panel.getByRole('img')).toHaveAttribute('aria-label', new RegExp(`by ${bucket} bucket`));
    await expect(panel.locator('.usage-totals')).toContainText('$1.25');
  }
  await panel.getByRole('combobox', { name: 'Chart', exact: true }).selectOption('batches'); await expect(panel.getByRole('img')).toHaveAttribute('aria-label', /Briefings prepared/);
  await expect(panel.locator('.usage-y-axis span')).toHaveText(['0', '1', '2', '3']);
  await expect(panel.locator('.usage-axis-unit')).toHaveText('Briefings');
  await panel.getByRole('combobox', { name: 'Chart', exact: true }).selectOption('cost');
  await page.screenshot({ path: '.test-artifacts/usage-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  const chart = (await panel.locator('.usage-chart').boundingBox())!, topTick = (await panel.locator('.usage-y-axis span').last().boundingBox())!;
  expect(topTick.y + topTick.height / 2).toBeCloseTo(chart.y + 7 / 120 * chart.height, 0);
  expect((await panel.locator('.usage-chart-axis').boundingBox())!.x).toBeCloseTo(chart.x, 0);
  expect(await panel.locator('.usage-y-axis span').first().evaluate(e => getComputedStyle(e).fontSize)).toBe('12px');
  await panel.locator('.usage-chart-frame').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.test-artifacts/usage-mobile.png' });
  await panel.getByText('Bucket details', { exact: true }).click(); await expect(panel.getByRole('table')).toContainText('Unavailable (partial)');
  expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.getByRole('link', { name: 'Draken sync history', exact: true }).click(); const closed = requests; await page.waitForTimeout(16000); expect(requests).toBe(closed); expect(mutations).toBe(0);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click(); await expect(panel.getByLabel('Look back')).toHaveValue('7d'); await expect(panel.getByLabel('Bucket size')).toHaveValue('1h'); await expect(panel.locator('.usage-totals')).toContainText('$1.25');
});
for (const usd of [0, 0.0000002, 0.000001, 1000000, 1e12, null]) test(`Y-axis stays readable for cost ${usd} and a single batch on a narrow screen`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route('**/api/settings/preparation-usage?*', route => {
    const data = usage('7d', '1h', usd); data.totals.completed_batches = 1; data.buckets[0].completed_batches = 1;
    if (usd === null) data.buckets[0].cost.complete = false;
    return route.fulfill({ json: data });
  });
  await page.goto('/settings');
  const panel = page.getByRole('region', { name: 'Preparation usage', exact: true });
  await expect(panel.locator('.usage-axis-unit')).toHaveText('USD');
  const labels = await panel.locator('.usage-y-axis span').allTextContents();
  if (usd === null) {
    expect(labels).toEqual([]); await expect(panel).toContainText('No priced amounts are available');
    await expect(panel.getByRole('img')).toHaveAttribute('aria-label', /pricing unavailable/);
  } else {
    expect(labels[0]).toBe('$0'); expect(labels.length).toBeGreaterThan(1); expect(new Set(labels).size).toBe(labels.length);
    expect(labels.join(' ')).not.toMatch(/NaN|Infinity|Unavailable/);
    if (usd > 0 && usd <= 0.000001) expect(labels.at(-1)).toMatch(/e-/);
  }
  expect(await panel.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  for (const tick of await panel.locator('.usage-y-axis span').all()) {
    const box = (await tick.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThan(320);
  }
  await panel.getByRole('combobox', { name: 'Chart', exact: true }).selectOption('batches');
  await expect(panel.locator('.usage-y-axis span')).toHaveText(['0', '1']);
  expect(await panel.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
});

test('model and operation filters combine, preserve unknown costs, handle empty results and remain read-only on mobile', async ({ page }) => {
  let mutations = 0; const queries: URLSearchParams[] = [];
  page.on('request', r => { if (r.url().includes('/api/') && !['GET','HEAD'].includes(r.method())) mutations++; });
  await page.route('**/api/settings/preparation-usage?*', route => {
    const q = new URL(route.request().url()).searchParams; queries.push(q);
    const model = q.get('model'), operation = q.get('operation');
    const data = usage(q.get('range')!, q.get('bucket')!, model === 'unknown' ? null : operation ? .25 : model ? .8 : 1.25, model, operation);
    if (model === 'openai/gpt-6-luna' && operation === 'compare_workflow_identity') { data.totals.requests = 0; data.totals.cost = { usd: 0, complete: true }; data.totals.incomplete_pricing = 0; }
    return route.fulfill({ json: data });
  });
  await page.goto('/settings'); const panel = page.getByRole('region', { name: 'Preparation usage', exact: true });
  await expect(panel.locator('.usage-totals')).toContainText('$1.25');
  const chart = panel.getByRole('combobox', { name: 'Chart', exact: true }), model = panel.getByRole('combobox', { name: 'Model', exact: true }), operation = panel.getByRole('combobox', { name: 'Operation', exact: true });
  await chart.selectOption('batches');
  await model.selectOption('openai/gpt-6-astra'); await expect(panel.locator('.usage-totals')).toContainText('$0.80');
  await expect(chart).toHaveValue('cost');
  await expect(chart.locator('option[value="batches"]')).toHaveAttribute('disabled', '');
  await operation.selectOption('compare_workflow_identity'); await expect(panel.locator('.usage-totals')).toContainText('$0.25');
  expect(queries.at(-1)?.get('model')).toBe('openai/gpt-6-astra'); expect(queries.at(-1)?.get('operation')).toBe('compare_workflow_identity');
  await expect(panel).toContainText('Briefings prepared (all preparation)'); await expect(panel).toContainText('Filters apply to costs and requests');
  await panel.getByText('Bucket details', { exact: true }).click(); await expect(panel.getByRole('columnheader', { name: 'Briefings', exact: true })).toHaveCount(0);
  for (const width of [320, 1440]) { await page.setViewportSize({ width, height: 1000 }); expect(await panel.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true); }
  await model.selectOption('openai/gpt-6-luna'); await expect(panel).toContainText('No model requests match these filters'); await expect(panel.getByRole('img')).toHaveCount(0);
  await model.selectOption('unknown'); await operation.selectOption('unknown'); await expect(panel).toContainText('No priced amounts are available');
  await model.selectOption(''); await operation.selectOption(''); await expect(panel.locator('.usage-totals')).toContainText('$1.25');
  expect(queries.at(-1)?.has('model')).toBe(false); expect(queries.at(-1)?.has('operation')).toBe(false); expect(mutations).toBe(0);
  await expect(chart.locator('option[value="batches"]')).not.toHaveAttribute('disabled', '');
});
test('changing a model filter ignores a late response and keeps filter choices on a failed refresh', async ({ page }) => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let waiting = false, fail = false;
  await page.route('**/api/settings/preparation-usage?*', async route => {
    const q = new URL(route.request().url()).searchParams, model = q.get('model'), operation = q.get('operation');
    if (model === 'openai/gpt-6-astra') { waiting = true; await held; await route.fulfill({ json: usage('7d','1h',999,model,operation) }).catch(() => {}); return; }
    if (fail) { await route.fulfill({ status:503, json:{error:'Synthetic filter read failure'} }); return; }
    await route.fulfill({ json: usage(q.get('range')!,q.get('bucket')!,2.5,model,operation) });
  });
  await page.goto('/settings'); const panel = page.getByRole('region', { name:'Preparation usage', exact:true }); await expect(panel.locator('.usage-totals')).toContainText('$2.50');
  const model = panel.getByRole('combobox', { name:'Model', exact:true }), operation = panel.getByRole('combobox', { name:'Operation', exact:true });
  await model.selectOption('openai/gpt-6-astra'); await expect.poll(() => waiting).toBe(true);
  await model.selectOption('openai/gpt-6-luna'); await expect(panel.locator('.usage-totals')).toContainText('$2.50'); release(); await page.waitForTimeout(100); await expect(panel).not.toContainText('$999');
  fail = true; await operation.selectOption('enrich_workflow'); await expect(panel.getByRole('alert')).toContainText('Usage unavailable'); await expect(panel.locator('.usage-totals')).toHaveCount(0); await expect(model).toHaveValue('openai/gpt-6-luna');
  fail = false; await operation.selectOption('summarize'); await expect(panel.locator('.usage-totals')).toContainText('$2.50');
});
test('changed range ignores an old response and a failed refresh never presents stale costs as current', async ({ page }) => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let first = true, fail = false;
  await page.route('**/api/settings/preparation-usage?*', async route => {
    const q = new URL(route.request().url()).searchParams;
    if (first) { first = false; await held; await route.fulfill({ json: usage('7d', '1h', 999) }).catch(() => {}); return; }
    if (fail) { await route.fulfill({ status: 503, json: { error: 'Synthetic usage read failure' } }); return; }
    await route.fulfill({ json: usage(q.get('range')!, q.get('bucket')!, 2.5) });
  });
  await page.goto('/settings');
  const panel = page.getByRole('region', { name: 'Preparation usage', exact: true }); await expect(panel).toContainText('Loading preparation usage');
  await expect.poll(() => first).toBe(false); await panel.getByLabel('Look back').selectOption('1d'); await expect(panel.locator('.usage-totals')).toContainText('$2.50');
  release(); await page.waitForTimeout(100); await expect(panel).not.toContainText('$999');
  fail = true; await panel.getByLabel('Bucket size').selectOption('6h'); await expect(panel.getByRole('alert')).toContainText('Usage unavailable'); await expect(panel.locator('.usage-totals')).toHaveCount(0);
  fail = false; await panel.getByLabel('Look back').selectOption('6h'); await expect(panel.locator('.usage-totals')).toContainText('$2.50');
});
