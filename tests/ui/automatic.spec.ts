import { test, expect } from '@playwright/test';

test('Home shows accumulated local history without automatic sync links, summaries or capture', async ({ page }) => {
  test.setTimeout(60_000);
  let state = { enabled: true, summary_enabled: true, check_seconds: 60, batch_records: 64, phase: 'indexing', pending_records: 64, pending_entries: 64, last_completed_at: null as string | null, error: '' };
  let unavailable = false, mutations = 0;
  const home = await (await page.request.get('/api/home')).json();
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method())) mutations++; });
  await page.addInitScript(() => {
    (window as any).__captures = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { (window as any).__captures++; throw Error('No capture while viewing progress'); } } });
  });
  await page.route('**/api/home', route => route.fulfill({ json: { ...home, available: state.pending_entries, new_entries: state.pending_entries } }));
  await page.route('**/api/settings/auto-index', route => unavailable ? route.abort() : route.fulfill({ json: state }));
  await page.route('**/api/memory/progress', route => route.fulfill({ json: { active: true, background: true, queued: 0, elapsed_ms: 2000, updated_at: Date.now(), work: { stage: 'indexing', completed: 30, total: 64, reused: 128, remaining_seconds: 3, parallelism: { workers: 2, threads: 6 } } } }));
  await page.goto('/');
  const progress = page.getByRole('region', { name: 'Automatic preparation', exact: true });
  const history = page.getByRole('region', { name: 'Sync history' });
  await expect(progress).toBeVisible(); await expect(progress).toContainText('Indexing searchable history');
  await expect(progress.getByRole('progressbar', { name: 'History indexing' })).toHaveAttribute('value', '30');
  await expect(progress).toContainText('30 / 64 new or changed passages ready');
  await expect(progress).toContainText('128 unchanged passages reused');
  await expect(progress).toContainText('64 source changes waiting for local indexing');
  await expect(progress.getByText('64 source changes waiting for local indexing.', { exact: false })).not.toBeVisible();
  await progress.getByLabel('Preparation details', { exact: true }).click();
  await expect(progress.getByText('64 source changes waiting for local indexing.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('New activity')).toContainText('64 new entries to prepare');
  await expect(page.getByLabel('Sync tracking')).not.toBeVisible();
  await page.getByLabel('About activity and preparation', { exact: true }).click();
  for (const width of [390, 1440]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  for (const entries of [64, 128, 131]) {
    state = { ...state, phase: 'waiting', pending_records: entries === 131 ? 3 : 0, pending_entries: entries, last_completed_at: new Date().toISOString() };
    await expect(page.getByLabel('New activity')).toContainText(`${entries} new entries to prepare`, { timeout: 8000 });
    await expect(progress).toContainText('Waiting for the next preparation batch', { timeout: 8000 });
    await expect(progress).toContainText('Last completed indexing batch:');
    await expect(page.getByLabel('Sync tracking')).toContainText(`${entries} available for a new sync`, { timeout: 8000 });
    await expect(progress.getByRole('link')).toHaveCount(0);
    await expect(progress.getByRole('progressbar')).toHaveCount(0);
    await expect(progress).not.toContainText('model calls');
    await expect(history.getByRole('link')).toHaveCount(home.syncs.length);
    expect(await history.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(home.syncs.map((sync: any) => `/syncs/${sync.id}`));
  }
  await expect(progress).toContainText('3 source changes waiting for local indexing');
  await expect(page.getByRole('link', { name: /Open prepared briefing|Open preparation/ })).toHaveCount(0);
  state = { ...state, phase: 'paused' };
  await expect(progress).toContainText('Paused for your conversation or foreground work', { timeout: 8000 });
  state = { ...state, phase: 'error', error: 'Local indexing could not finish. Completed embeddings are retained; retry in five minutes.' };
  await expect(progress.getByRole('alert')).toContainText('Completed embeddings are retained', { timeout: 8000 });
  await expect(progress).not.toContainText('entries available for your next sync');
  await page.getByRole('banner').getByRole('link', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(dialog.getByRole('switch', { name: /Automatically prepare history/ })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Retry failed operations' })).toBeVisible();
  await expect(dialog).toContainText('quota or API billing');
  await dialog.getByLabel('About automatic preparation', { exact: true }).click();
  await expect(dialog.getByText('Local search uses CPU, memory and disk', { exact: false })).toBeVisible();
  await expect(dialog.getByText('Preparation runs while Draken is idle.', { exact: false })).toBeVisible();
  await page.goBack();
  unavailable = true; await expect(page.getByRole('status').filter({ hasText: 'Automatic preparation status is temporarily unavailable' })).toBeVisible({ timeout: 8000 });
  expect(mutations).toBe(0); expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
});
