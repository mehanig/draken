import { test, expect } from '@playwright/test';

test('selected workflow and task use one workspace run; refresh only reads saved session results', async ({ page }) => {
  const id = 'a'.repeat(64), state = { available: true, agentAvailable: true, locationKey: 'repo', repository: '/projects/parser', runs: [] as any[] };
  const proposal = { id, location: { kind: 'repository', key: 'repo', name: 'parser', path: '/projects/parser' }, model: 'fixture', createdAt: new Date().toISOString(), evidence: [], decision: { assessment: { workflow: { purpose: 'Repair a parser defect', appliesWhen: 'A reproducible parsing failure', method: ['Reproduce the failure', 'Repair and test'] }, limitations: [], reason: 'Shared method' } } };
  let posts = 0;
  await page.route('**/api/factory', route => route.fulfill({ json: { proposals: [proposal, { ...proposal, id: 'b'.repeat(64), location: { ...proposal.location, key: 'other', path: '/other' } }], nextCursor: null, unavailable: 0, learning: 'enabled' } }));
  await page.route('**/api/factory/workspaces', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: state }); return; }
    posts++; const body = route.request().postDataJSON(); expect(body.workflowId).toBe(id); expect(body.task).toBe('Reject malformed integers'); expect(body.ref).toBe('HEAD');
    state.runs = [{ id: body.requestId, ref: body.ref, workflowId: id, task: body.task, commit: 'c'.repeat(40), status: 'completed', detail: 'Workflow checks passed in a fresh workspace; patch retained for review', createdAt: new Date().toISOString(), modelCalls: 6, sessionId: 'one-persistent-session', stages: [{ name: 'Run workflow', status: 'passed' }], patchBytes: 100 }];
    await route.fulfill({ status: 202, json: state.runs[0] });
  });
  await page.setViewportSize({ width: 390, height: 900 }); await page.goto('/factory');
  const panel = page.getByRole('region', { name: 'Agent workflow execution', exact: true }); await expect(panel).toHaveCount(1); expect(posts).toBe(0);
  await panel.getByLabel('Task', { exact: true }).fill('Reject malformed integers'); await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(panel.getByText('Changes retained as a patch; not applied to your checkout.')).toBeVisible(); await panel.locator('summary').click(); await expect(panel.getByText(/^6 model calls · Session one-persistent-session$/)).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.reload(); await expect(panel.getByText('Reject malformed integers', { exact: true })).toBeVisible(); expect(posts).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('agent runs start explicitly, preserve request identity and expose cancellation', async ({ page }) => {
  const workflowId = 'a'.repeat(64), state = { available: true, agentAvailable: true, locationKey: 'repo', repository: '/projects/draken', runs: [] as any[] }; let posts = 0;
  await page.route('**/api/factory', route => route.fulfill({ json: { proposals: [{ id: workflowId, location: { kind: 'repository', key: 'repo', path: '/projects/draken', name: 'draken' }, evidence: [], decision: { assessment: { workflow: { purpose: 'Repair parser', method: ['Reproduce', 'Fix'], appliesWhen: 'A bug' }, limitations: [] } } }], nextCursor: null, learning: 'enabled' } }));
  await page.route('**/api/factory/workspaces', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: state }); return; }
    posts++; const body = route.request().postDataJSON(); expect(body.ref).toBe('HEAD'); expect(body.propose).toBeUndefined();
    state.runs = [{ id: body.requestId, workflowId, ref: 'HEAD', commit: 'a'.repeat(40), status: 'running', detail: '', createdAt: new Date().toISOString(), modelCalls: 0, stages: [{ name: 'Build', status: 'running' }], patchBytes: 0 }];
    await route.fulfill({ status: 202, json: state.runs[0] });
  });
  await page.route('**/api/factory/workspaces/*/cancel', async route => { state.runs[0].status = 'cancelled'; state.runs[0].detail = 'Run cancelled'; await route.fulfill({ status: 204 }); });
  await page.setViewportSize({ width: 390, height: 900 }); await page.goto('/factory');
  const panel = page.getByRole('region', { name: 'Agent workflow execution', exact: true });
  await expect(panel.getByLabel('Commit or branch')).toHaveValue('HEAD'); await expect(panel.getByRole('checkbox')).toHaveCount(0); expect(posts).toBe(0);
  await panel.getByLabel('Task', { exact: true }).fill('Fix parser');
  await panel.getByRole('button', { name: 'Run', exact: true }).click(); await expect(panel.getByRole('button', { name: 'Cancel run' })).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel run' }).click(); await expect(panel.getByText('Run cancelled', { exact: true })).toBeVisible();
  expect(posts).toBe(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload(); await expect(panel.getByText('Run cancelled', { exact: true })).toBeVisible(); expect(posts).toBe(1);
});
