import { test, expect } from '@playwright/test';

test('ordinary history search is automatically hybrid, has no setup controls, and browsing never captures audio', async ({ page, request }) => {
  await request.post('/api/scan');
  let indexRequests = 0, microphoneRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/api/memory/index')) indexRequests++; if (request.url().endsWith('/api/voice/live/calls')) microphoneRequests++; });
  await page.goto('/history');
  await expect(page.getByRole('heading', { name: 'Find earlier work.' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Enable semantic|Update history|Cancel indexing/ })).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByLabel('What do you want to find?').fill('bounded retry');
  await page.getByRole('button', { name: 'Search history', exact: true }).click();
  const results = page.getByRole('region', { name: 'History search results' });
  await expect(results).toContainText('Meaning + keyword matches');
  await expect(results).toContainText('bounded retry');
  const link = results.getByRole('link', { name: 'Read source and surrounding context' }).first();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/history\/H[a-f0-9]{24}$/);
  await page.goto(href!);
  await expect(page.getByRole('region', { name: 'Historical source' })).toContainText('bounded retry');
  await expect(page.getByRole('region', { name: 'Historical source' })).toContainText('assistant');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Historical source', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(indexRequests).toBe(0); expect(microphoneRequests).toBe(0);
});

test('indexing shows download/count/ETA progress without setup controls and cancellation stops polling', async ({ page }) => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let progressRequests = 0;
  const state = { active: true, queued: 0, elapsed_ms: 2000, updated_at: Date.now(), work: {
    stage: 'downloading', completed: 0, total: 0, reused: 0, remaining_seconds: null as number | null,
    downloaded_bytes: 13000000, download_total_bytes: 135000000,
  } };
  await page.route('**/api/memory/search', async route => { await pending; await route.fulfill({ json: { mode: 'hybrid', results: [], limitations: 'Synthetic result' } }).catch(() => {}); });
  await page.route('**/api/memory/progress', route => { progressRequests++; return route.fulfill({ json: state }); });
  try {
    await page.goto('/history'); expect(progressRequests).toBe(0);
    await page.getByLabel('What do you want to find?').fill('deployment strategy');
    await page.getByRole('button', { name: 'Search history', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Local history progress' });
    await expect(panel).toContainText('Downloading the local search model');
    await expect(page.getByRole('progressbar', { name: 'Model download' })).toHaveAttribute('value', '13000000');
    Object.assign(state, { elapsed_ms: 65000, updated_at: Date.now() });
    Object.assign(state.work, { stage: 'indexing', total: 100, completed: 55, reused: 15000, parallelism: { workers: 2, threads: 6 }, remaining_seconds: 90, downloaded_bytes: 0, download_total_bytes: 0 });
    await expect(panel).toContainText('55 / 100 new or changed passages ready · 55%');
    await expect(panel).toContainText('15,000 unchanged passages reused'); await expect(panel).toContainText('About 2 min remaining (estimate)');
    await expect(page.getByRole('progressbar', { name: 'History indexing' })).toHaveAttribute('value', '55');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(panel).toContainText('2 embedding workers, 6 CPU threads total');
    Object.assign(state.work,{completed:0,total:0,reused:15100});await expect(panel).toContainText('History is up to date');
    await expect(page.getByRole('progressbar',{name:'History indexing'})).toHaveCount(0);
    state.updated_at = Date.now() - 20000;
    await expect(panel).toContainText('No new progress for');
    await expect(page.getByRole('button', { name: /Enable semantic|Update history|Cancel indexing/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel search', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Search history', exact: true })).toBeEnabled();
    const stoppedAt = progressRequests; await page.waitForTimeout(1300); expect(progressRequests).toBe(stoppedAt);
  } finally { finish(); }
});
