import { test, expect, type Page, type Route } from '@playwright/test';
import { isFreePreviewRequest } from './preparation-preview-fixture';

const empty = { phase: 'checking', needs_processing: null, cached: null, total: null, checked_at: null, error: '' };
const ready = { ...empty, phase: 'ready', needs_processing: 7, cached: 83, total: 90, checked_at: '2026-01-15T12:30:00.000Z' };
const home = { available: 25592, included_unreviewed: 19, covered: 619, busy: false, active_call: false, syncs: [], next_cursor: null };
const region = (page: Page) => page.getByRole('region', { name: 'Reusable summary work', exact: true });
async function fixture(page: Page) {
  await page.clock.install();
  // Fully synthetic: even unexpected API reads cannot reach a provider or a live server.
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ status: 503, json: { error: 'Unmocked synthetic endpoint' } }));
  await page.route('**/api/auth/status', route => route.fulfill({ json: { enabled: false } }));
  await page.route('**/api/home', route => route.fulfill({ json: home }));
  await page.route('**/api/setup*', route => route.fulfill({ json: { data_dir: '/synthetic', pi: { state: 'configured', source: 'managed', models: [], agent_dir: '/synthetic/pi', message: 'Synthetic setup' } } }));
  await page.route('**/api/voice/status', route => route.fulfill({ json: { installed: true, activeCall: null } }));
  await page.route('**/api/settings/auto-index', route => route.fulfill({ json: { enabled: false, phase: 'off' } }));
}
async function tick(page: Page) { await page.clock.runFor(4100); }

for (const [fresh, cached] of [[7, 83], [0, 90], [null, null]]) {
  test(`Home estimates use cache evidence, not review scope (${fresh}/${cached})`, async ({ page }) => {
    await fixture(page);
    const writes: string[] = [];
    page.on('request', request => { if (request.method() !== 'GET') { expect(isFreePreviewRequest(request)).toBe(true); writes.push(request.url()); } });
    await page.route('**/api/preparation-preview', route => route.fulfill({ json: { ...ready, needs_processing: fresh, cached } }));
    await page.goto('/');
    const preview = region(page);
    await expect(preview).toContainText(`Needs new summaries: ${fresh === null ? 'Unknown' : `${fresh} entries`}`);
    await expect(preview).toContainText(`Already cached: ${cached === null ? 'Unknown' : `${cached} entries`}`);
    await expect(preview).not.toContainText('25592'); await expect(preview).not.toContainText('619');
    await expect(preview).toContainText('Estimates for indexed inputs');
    await expect(preview.locator('time')).toHaveAttribute('datetime', ready.checked_at);
    await expect(preview).toContainText('may still require inference, even with zero new summaries');
    await expect(preview).toContainText('makes no provider requests');
    const details = page.locator('.home-scope-details');
    await expect(details).not.toHaveAttribute('open', '');
    await expect(page.getByLabel('Sync tracking')).not.toBeVisible();
    await details.locator('summary').click();
    await expect(details).toContainText('25592 available for a new sync');
    await expect(details).toContainText('19 reserved, not reviewed'); await expect(details).toContainText('619 reviewed');
    await expect(details).toContainText('not billable work');
    await expect(page.getByRole('button', { name: 'Sync with Draken', exact: true })).toBeEnabled();
    await tick(page); expect(writes).toHaveLength(1); // StrictMode + polling must not restart the check.
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('initial/checking stays nonblocking, slow requests serialize, and Start rejects a late ready result', async ({ page }) => {
  await fixture(page);
  let held: Route | undefined;
  const requests: string[] = [], mutations: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && !isFreePreviewRequest(request)) mutations.push(new URL(request.url()).pathname); });
  await page.route('**/api/preparation-preview', route => { requests.push(route.request().method()); held = route; });
  await page.route('**/api/syncs/start-chat', route => route.fulfill({ status: 503, json: { error: 'Synthetic start failure' } }));
  await page.goto('/'); await expect(region(page)).toContainText('Checking reusable work…');
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Sync with Draken', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Chat instead', exact: true })).toBeEnabled();
  await tick(page); await tick(page); expect(requests).toEqual(['POST']);
  await page.getByRole('button', { name: 'Chat instead', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic start failure');
  await held!.fulfill({ json: { ...ready, needs_processing: 999 } });
  await expect.poll(() => requests.length).toBe(2);
  await expect(region(page)).not.toContainText('999');
  await held!.fulfill({ status: 202, json: empty });
  await expect(region(page)).toContainText('Checking reusable work…');
  expect(mutations).toEqual(['/api/syncs/start-chat']);
});

for (const networkFailure of [false, true]) test(`unavailable is honest and retries only explicitly (network=${networkFailure})`, async ({ page }) => {
  await fixture(page);
  let requests = 0;
  await page.route('**/api/preparation-preview', route => {
    requests++;
    if (requests > 1) return route.fulfill({ json: ready });
    return networkFailure ? route.fulfill({ status: 503, json: { error: 'Synthetic cache failure' } })
      : route.fulfill({ json: { ...empty, phase: 'unavailable', error: 'Synthetic cache failure' } });
  });
  await page.goto('/');
  await expect(region(page)).toContainText('Counts are unknown, not zero');
  await expect(region(page).getByRole('alert')).toHaveText('Synthetic cache failure');
  await tick(page); await tick(page); expect(requests).toBe(1);
  await region(page).getByRole('button', { name: 'Retry reusable-work check' }).click();
  await expect(region(page)).toContainText('Already cached: 83 entries'); expect(requests).toBe(2);
});

for (const busyField of ['busy', 'active_call']) test(`paused checks wait for ${busyField} to become idle without restart loops`, async ({ page }) => {
  await fixture(page);
  let busy = true, posts = 0;
  await page.route('**/api/home', route => route.fulfill({ json: { ...home, [busyField]: busy } }));
  await page.route('**/api/preparation-preview', route => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: { ...empty, phase: 'paused' } });
  });
  await page.goto('/'); await expect(region(page)).toContainText('paused for foreground work');
  await tick(page); expect(posts).toBe(0);
  busy = false; await tick(page); await expect.poll(() => posts).toBe(1);
  await expect(region(page)).toContainText('paused for foreground work');
  await tick(page); await expect.poll(() => posts).toBe(2); // One retry for a paused response while idle.
  await tick(page); await tick(page); expect(posts).toBe(2);
  await expect(page.getByRole('button', { name: 'Chat instead', exact: true })).toBeEnabled();
});

test('a server-paused response can retry once when Home is already idle', async ({ page }) => {
  await fixture(page);
  let posts = 0;
  await page.route('**/api/preparation-preview', route => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: posts > 1 ? ready : { ...empty, phase: 'paused' } });
  });
  await page.goto('/'); await expect(region(page)).toContainText('paused for foreground work');
  await tick(page); await expect(region(page)).toContainText('Already cached: 83 entries');
  await tick(page); expect(posts).toBe(2);
});

test('stale hides old counts, requests one refresh, and does not loop if still stale', async ({ page }) => {
  await fixture(page);
  let posts = 0;
  await page.route('**/api/preparation-preview', route => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: posts === 1 && route.request().method() === 'POST' ? ready : { ...ready, phase: 'stale' } });
  });
  await page.goto('/'); await expect(region(page)).toContainText('Already cached: 83 entries');
  await tick(page); await expect.poll(() => posts).toBe(2);
  await expect(region(page)).toContainText('estimate is stale');
  await expect(region(page)).not.toContainText('83 entries');
  await tick(page); await tick(page); expect(posts).toBe(2);
});

test('a stale refresh cancelled by work can recover on a later idle metadata transition', async ({ page }) => {
  await fixture(page);
  let posts = 0, phase = 'stale';
  await page.route('**/api/preparation-preview', route => {
    if (route.request().method() === 'POST') {
      posts++;
      if (posts === 1) return route.fulfill({ json: ready });
      if (posts === 4) return route.fulfill({ json: { ...ready, cached: 12 } });
      phase = 'paused';
    }
    return route.fulfill({ json: { ...empty, phase } });
  });
  await page.goto('/'); await expect(region(page)).toContainText('Already cached: 83 entries');
  await tick(page); await expect.poll(() => posts).toBe(2);
  await tick(page); await expect.poll(() => posts).toBe(3);
  await tick(page); await tick(page); expect(posts).toBe(3);
  phase = 'stale'; // background/foreground retirement finished, metadata admits again
  await tick(page); await expect(region(page)).toContainText('Already cached: 12 entries');
  expect(posts).toBe(4);
});

test('source selection invalidates an in-flight ready estimate and rechecks only after the mutation', async ({ page }) => {
  await fixture(page);
  let held: Route | undefined, sourceWrite: Route | undefined, posts = 0;
  await page.route('**/api/preparation-preview', route => { posts++; held = route; });
  const sources = { agents: [{ id: 'pi', name: 'pi', enabled: true, roots: [], available: true }], sessions: [], session_root: '/synthetic', stats: {} };
  await page.route('**/api/overview', route => route.fulfill({ json: sources }));
  await page.route('**/api/agents/pi', route => { sourceWrite = route; });
  await page.goto('/'); await expect.poll(() => posts).toBe(1);
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByText('Agents & sessions', { exact: true }).click();
  await dialog.getByRole('switch', { name: 'Enable pi history' }).uncheck();
  await expect.poll(() => Boolean(sourceWrite)).toBe(true);
  await held!.fulfill({ json: { ...ready, cached: 999 } });
  await tick(page); expect(posts).toBe(1);
  await sourceWrite!.fulfill({ json: { ...sources, agents: [{ ...sources.agents[0], enabled: false }] } });
  await expect.poll(() => posts).toBe(2);
  await page.keyboard.press('Escape');
  await expect(region(page)).not.toContainText('999');
  await held!.fulfill({ json: { ...ready, cached: 12 } });
  await expect(region(page)).toContainText('Already cached: 12 entries');
});

test('slow GET polls coalesce and foreground work invalidates their late ready response', async ({ page }) => {
  await fixture(page);
  let busy = false, posts = 0, gets = 0, held: Route | undefined;
  await page.route('**/api/home', route => route.fulfill({ json: { ...home, busy } }));
  await page.route('**/api/preparation-preview', route => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ json: posts === 1 ? ready : { ...ready, cached: 12 } }); }
    gets++; held = route;
  });
  await page.goto('/'); await expect(region(page)).toContainText('Already cached: 83 entries');
  await tick(page); await expect.poll(() => gets).toBe(1);
  await tick(page); await tick(page); expect(gets).toBe(1);
  busy = true; await tick(page);
  await expect(region(page)).toContainText('paused for foreground work');
  await expect(region(page)).not.toContainText('83 entries');
  await held!.fulfill({ json: { ...ready, cached: 999 } });
  await expect(region(page)).not.toContainText('999');
  busy = false; await tick(page);
  await expect(region(page)).toContainText('Already cached: 12 entries'); expect(posts).toBe(2);
});

test('leaving Home stops polling and late results cannot overwrite a remounted preview', async ({ page }) => {
  await fixture(page);
  const held: Route[] = [];
  await page.route('**/api/preparation-preview', route => { held.push(route); });
  await page.goto('/'); await expect.poll(() => held.length).toBe(1);
  await page.getByRole('link', { name: 'Search history', exact: true }).click();
  await expect(region(page)).toHaveCount(0);
  await tick(page); expect(held).toHaveLength(1);
  await page.goBack(); await expect.poll(() => held.length).toBe(2);
  await held[1].fulfill({ json: { ...ready, cached: 12 } });
  await expect(region(page)).toContainText('Already cached: 12 entries');
  await held[0].fulfill({ json: { ...ready, cached: 999 } });
  await expect(region(page)).not.toContainText('999');
  await expect(region(page)).toContainText('Already cached: 12 entries');
});
