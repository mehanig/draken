import { test, expect } from '@playwright/test';

const empty = { proposals: [], nextCursor: null, unavailable: 0, learning: 'enabled', failedExtractions: 0 };
const proposal = {
  location: { kind: 'repository', key: 'repo-a', path: '/projects/backup', name: 'backup' },
  id: 'proposal-1', model: 'test/model', createdAt: '2026-01-01T00:00:00.000Z',
  decision: { sameWorkflow: true, relation: 'same_workflow_candidate', coverage: [], assessment: {
    relation: 'same_workflow_candidate', workflow: { purpose: 'Verify a database backup', method: ['Restore into an isolated target', 'Compare restored rows with the manifest'], appliesWhen: 'A backup needs a recovery rehearsal; do not change production.' },
    stagePairs: [{ left: 'S1', right: 'S1' }], reason: 'Same purpose and method.', limitations: ['One result is reported, not independently observed.'],
  } },
  evidence: [{ goal: 'Rehearse recovery', context: 'Isolated target', complete: false, gaps: ['Initiating request missing'], stages: [], secondary: [], facts: [{ id: 'S1.C1', description: '<script>window.factoryInjected=true</script>', basis: 'reported', role: 'main', stage: 'S1', refs: ['R1'] }] }],
};

test('Factory is read-only, direct-linkable and available in shared navigation', async ({ page }) => {
  const mutations: string[] = [];
  page.on('request', r => { if (!['GET', 'HEAD'].includes(r.method())) mutations.push(r.url()); });
  await page.route('**/api/factory', route => route.fulfill({ json: empty }));
  await page.goto('/factory');
  await expect(page.getByRole('heading', { name: 'Factory', exact: true })).toBeVisible();
  await expect(page.getByText('No workflows yet')).toBeVisible();
  await expect(page.locator('.factory-page .info-disclosure')).toHaveCount(0);
  await expect(page.getByText('Background learning enabled', { exact: true })).toHaveCount(0);
  await expect(page.getByText('New summaries retain process records.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('banner').getByRole('link', { name: 'Factory', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('No workflows yet')).toBeVisible();
  await page.reload(); await expect(page.getByRole('main', { name: 'Factory' })).toBeVisible();
  expect(mutations).toEqual([]);
});

test('Factory groups repositories and non-Git folders, including older pages', async ({ page }) => {
  const folder = { ...proposal, id: 'folder-proposal', location: { kind: 'folder', key: 'folder', path: '/notes/backup', name: 'backup' } };
  const older = { ...proposal, id: 'older-proposal' };
  await page.route('**/api/factory*', route => route.fulfill({ json: new URL(route.request().url()).searchParams.has('before')
    ? { ...empty, proposals: [older] } : { ...empty, proposals: [proposal, folder], nextCursor: 7 } }));
  await page.goto('/factory');
  await expect(page.getByRole('region', { name: '/projects/backup', exact: true })).toContainText('Git repository');
  await expect(page.getByRole('region', { name: '/notes/backup', exact: true })).toContainText('Not a Git repository');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.locator('.factory-group')).toHaveCount(2);
  await expect(page.getByRole('region', { name: '/projects/backup', exact: true }).locator('article')).toHaveCount(2);
  await expect(page.getByRole('region', { name: '/notes/backup', exact: true }).locator('article')).toHaveCount(1);
  await expect(page.getByText('Location comes from the session', { exact: false })).toHaveCount(0);
});

test('Factory shows qualifications and source labels without executing model text; mobile layout fits', async ({ page }) => {
  await page.route('**/api/factory', route => route.fulfill({ json: { ...empty, proposals: [proposal] } }));
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/factory');
    await expect(page.getByRole('heading', { name: 'Verify a database backup' })).toBeVisible();
    await expect(page.getByText('One result is reported, not independently observed.')).toBeVisible();
    await page.getByText('Evidence', { exact: true }).click();
    await expect(page.getByText('Initiating request missing')).toBeVisible();
    await expect(page.getByText('<script>window.factoryInjected=true</script>', { exact: false })).toBeVisible();
    expect(await page.evaluate(() => 'factoryInjected' in window)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('.factory-page .info-disclosure')).toHaveCount(0);
  }
});

test('Factory explains paused learning and preparation errors without starting work', async ({ page }) => {
  let learning = 'paused'; const mutations: string[] = [];
  page.on('request', r => { if (!['GET', 'HEAD'].includes(r.method())) mutations.push(r.url()); });
  await page.route('**/api/factory', route => route.fulfill({ json: { ...empty, learning, proposals: [proposal], failedExtractions: learning === 'error' ? 1 : 0 } }));
  await page.goto('/factory');
  await expect(page.getByText('Learning paused', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Verify a database backup' })).toBeVisible();
  learning = 'error'; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Learning stopped.');
  await expect(page.getByRole('link', { name: 'Retry in Settings' })).toHaveAttribute('href', '/settings');
  await expect(page.getByText('1 failed attempt', { exact: true })).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test('refresh removes old proposal content when sources become unavailable or the request fails', async ({ page }) => {
  let phase = 0;
  await page.route('**/api/factory', route => phase === 2
    ? route.fulfill({ status: 503, json: { error: 'Source verification unavailable' } })
    : route.fulfill({ json: phase === 0 ? { ...empty, proposals: [proposal] } : { ...empty, unavailable: 1 } }));
  await page.goto('/factory'); await expect(page.getByText('Verify a database backup', { exact: true })).toBeVisible();
  phase = 1; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Verify a database backup', { exact: true })).toHaveCount(0);
  await expect(page.getByText('1 saved result unavailable', { exact: true })).toBeVisible();
  phase = 2; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Source verification unavailable');
  await expect(page.getByText('Verify a database backup', { exact: true })).toHaveCount(0);
});
