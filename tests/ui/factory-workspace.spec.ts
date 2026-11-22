import { test, expect } from '@playwright/test';
const enrichment = { status: 'ready', value: { guidance: { inputs: [{ name: 'version', label: 'Release version', description: 'Published version to verify', required: true }], steps: [{ step: 1, approach: 'Inspect published contents', checks: ['Verify package version'] }], review: ['Review release checks'], completion: ['Confirm published version'], risks: [] }, requirements: ['Do not publish'] } };
const proposal = { id: 'a'.repeat(64), enrichment, location: { kind: 'repository', key: 'repo', name: 'parser', path: '/parser' }, evidence: [], decision: { assessment: { workflow: { purpose: 'Verify a release', appliesWhen: 'After publication', method: ['Check version'] }, limitations: [] } } };
const state = () => ({ maxCalls: 16, available: true, agentAvailable: true, locationKey: 'repo', repository: '/parser', runs: [] as any[] });

test('workflow inputs replace the prompt box; refresh only reads saved results', async ({ page }) => {
  const data = state(); let posts = 0;
  await page.route('**/api/factory', route => route.fulfill({ json: { proposals: [proposal, { ...proposal, id: 'b'.repeat(64), location: { ...proposal.location, key: 'other' } }], nextCursor: null, learning: 'enabled' } }));
  await page.route('**/api/factory/workspaces', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: data });
    posts++; const body = route.request().postDataJSON(); expect(body.workflowId).toBe(proposal.id); expect(body.inputs).toEqual({ version: '0.10.1' }); expect(body.task).toBeUndefined();
    data.runs = [{ id: body.requestId, ref: body.ref, workflowId: proposal.id, inputs: body.inputs, commit: 'c'.repeat(40), status: 'completed', detail: 'Checks passed', createdAt: new Date().toISOString(), modelCalls: 6, sessionId: 'one-session', stages: [{ name: 'Checks', status: 'passed' }], patchBytes: 100 }];
    return route.fulfill({ status: 202, json: data.runs[0] });
  });
  await page.setViewportSize({ width: 390, height: 900 }); await page.goto('/factory');
  await page.locator('.factory-workflow-summary').first().click();
  const panel = page.getByRole('region', { name: 'Agent workflow execution', exact: true }); await expect(panel).toHaveCount(1);
  await expect(page.locator('textarea')).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Run workflow', exact: true })).toHaveCount(0); await expect(page.getByText(/Up to 16 execution calls/)).toHaveCount(0); expect(posts).toBe(0);
  await panel.getByLabel('Release version', { exact: true }).fill('0.10.1');
  await page.locator('.factory-workflow-summary').first().click();await page.locator('.factory-workflow-summary').first().click();
  await expect(panel.getByLabel('Release version', { exact: true })).toHaveValue('0.10.1');await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(panel.getByText('Release version: 0.10.1', { exact: true })).toBeVisible(); await panel.locator('summary').click(); await expect(panel.getByText('6 model calls · Session one-session')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.reload(); await page.locator('.factory-workflow-summary').first().click(); await expect(panel.getByText('Release version: 0.10.1', { exact: true })).toBeVisible(); expect(posts).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a consolidated workflow retains execution history from its original IDs without replaying it', async ({ page }) => {
  const data = state(), old = 'b'.repeat(64), writes: string[] = [];
  data.runs = [{ id: 'old-run', workflowId: old, ref: 'old-branch', status: 'failed', detail: 'Original failed attempt retained', createdAt: new Date().toISOString(), stages: [], modelCalls: 3, patchBytes: 0 }];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  await page.route('**/api/factory', route => route.fulfill({ json: { proposals: [{ ...proposal, aliases: [old] }], nextCursor: null, learning: 'enabled' } }));
  await page.route('**/api/factory/workspaces', route => route.fulfill({ json: data }));
  await page.route('**/api/factory/workspaces/old-run/log', route => route.fulfill({ json: { text: 'Original execution log' } }));
  await page.goto(`/factory#workflow-${old}`);
  await expect(page.getByText('Original failed attempt retained')).toBeVisible();await page.getByRole('button', { name: 'View log' }).click();await expect(page.getByText('Original execution log')).toBeVisible();
  expect(writes).toEqual([]);
});

test('prepare once, then reuse defined inputs for multiple runs without enrichment calls', async ({ page }) => {
  const item: any = { ...proposal, enrichment: { status: 'pending' } }, data = state(); let preparations = 0, runs = 0;
  await page.route('**/api/factory', route => route.fulfill({ json: { proposals: [item], nextCursor: null, learning: 'enabled' } }));
  await page.route(`**/api/factory/${proposal.id}/enrichment`, route => { preparations++; expect(route.request().postDataJSON().retry).toBe(false); item.enrichment = enrichment; return route.fulfill({ json: enrichment.value }); });
  await page.route('**/api/factory/workspaces', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: data });
    runs++; const body = route.request().postDataJSON(); data.runs = [{ id: body.requestId, workflowId: proposal.id, inputs: body.inputs, status: 'completed', stages: [], modelCalls: 2, createdAt: new Date().toISOString() }]; return route.fulfill({ status: 202, json: data.runs[0] });
  });
  await page.goto('/factory'); await page.locator('.factory-workflow-summary').click(); await expect(page.getByText('Awaiting enrichment — not ready to run.')).toBeVisible(); await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); expect(preparations).toBe(0);
  await page.getByRole('button', { name: 'Enrich workflow', exact: true }).click(); await expect(page.getByText('Review release checks')).toBeVisible();
  for (const version of ['0.10.1', '0.10.2']) {
    await page.reload(); await page.locator('.factory-workflow-summary').click(); await page.getByLabel('Release version', { exact: true }).fill(version); await page.getByRole('button', { name: 'Run', exact: true }).click(); await expect(page.getByText(`Release version: ${version}`, { exact: true })).toBeVisible();
  }
  expect(runs).toBe(2); expect(preparations).toBe(1);
});

test('a workflow with no additional inputs runs directly and preserves cancellation', async ({ page }) => {
  const data = state(), item = { ...proposal, enrichment: { ...enrichment, value: { ...enrichment.value, guidance: { ...enrichment.value.guidance, inputs: [] } } } }; let posts = 0;
  await page.route('**/api/factory', route => route.fulfill({ json: { proposals: [item], nextCursor: null, learning: 'enabled' } }));
  await page.route('**/api/factory/workspaces', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: data });
    posts++; const body = route.request().postDataJSON(); expect(body.inputs).toEqual({}); expect(body.task).toBeUndefined();
    data.runs = [{ id: body.requestId, workflowId: proposal.id, ref: 'HEAD', status: 'running', detail: '', createdAt: new Date().toISOString(), modelCalls: 0, stages: [], patchBytes: 0 }]; return route.fulfill({ status: 202, json: data.runs[0] });
  });
  await page.route('**/api/factory/workspaces/*/cancel', route => { data.runs[0].status = 'cancelled'; data.runs[0].detail = 'Run cancelled'; return route.fulfill({ status: 204 }); });
  await page.goto('/factory'); await page.locator('.factory-workflow-summary').click(); const panel = page.getByRole('region', { name: 'Agent workflow execution', exact: true });
  await expect(panel.getByRole('textbox')).toHaveCount(1); await expect(panel.getByLabel('Commit or branch')).toHaveValue('HEAD');
  await panel.getByRole('button', { name: 'Run', exact: true }).click(); await panel.getByRole('button', { name: 'Cancel run' }).click();
  await expect(panel.getByText('Run cancelled', { exact: true })).toBeVisible(); await page.reload(); await page.locator('.factory-workflow-summary').click(); await expect(panel.getByText('Run cancelled', { exact: true })).toBeVisible(); expect(posts).toBe(1);
});

test('call limit is saved once in execution settings, not repeated under workflows', async ({ page }) => {
  const data = state(); let saves = 0;
  await page.route('**/api/factory', route => route.fulfill({ json: { proposals: [proposal], nextCursor: null, learning: 'enabled' } }));
  await page.route('**/api/factory/workspaces', route => route.fulfill({ json: data }));
  await page.route('**/api/factory/workspaces/settings', route => { saves++; data.maxCalls = route.request().postDataJSON().maxCalls; return route.fulfill({ status: 204 }); });
  await page.goto('/factory'); await page.getByText('Execution settings', { exact: true }).click(); await page.getByLabel('Model call limit per run').fill('32'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled(); await page.reload(); await page.getByText('Execution settings', { exact: true }).click(); await expect(page.getByLabel('Model call limit per run')).toHaveValue('32'); expect(saves).toBe(1);
});
