import { test, expect } from '@playwright/test';

test('repository checks start explicitly, preserve request identity and expose cancellation', async ({ page }) => {
  const state = { available: true, repository: '/projects/draken', runs: [] as any[] }; let posts = 0;
  await page.route('**/api/factory/workspaces', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: state }); return; }
    posts++; const body = route.request().postDataJSON(); expect(body.ref).toBe('HEAD'); expect(body.propose).toBe(false);
    state.runs = [{ id: body.requestId, ref: 'HEAD', commit: 'a'.repeat(40), status: 'running', detail: '', createdAt: new Date().toISOString(), modelCalls: 0, stages: [{ name: 'Build', status: 'running' }], patchBytes: 0 }];
    await route.fulfill({ status: 202, json: state.runs[0] });
  });
  await page.route('**/api/factory/workspaces/*/cancel', async route => { state.runs[0].status = 'cancelled'; state.runs[0].detail = 'Run cancelled'; await route.fulfill({ status: 204 }); });
  await page.setViewportSize({ width: 390, height: 900 }); await page.goto('/factory');
  const panel = page.getByRole('region', { name: 'Repository checks', exact: true });
  await expect(panel.getByLabel('Commit or branch')).toHaveValue('HEAD'); expect(posts).toBe(0);
  await panel.getByRole('button', { name: 'Run', exact: true }).click(); await expect(panel.getByRole('button', { name: 'Cancel run' })).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel run' }).click(); await expect(panel.getByText('Run cancelled', { exact: true })).toBeVisible();
  expect(posts).toBe(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload(); await expect(panel.getByText('Run cancelled', { exact: true })).toBeVisible(); expect(posts).toBe(1);
});
