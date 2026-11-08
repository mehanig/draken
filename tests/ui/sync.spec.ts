import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativePeer } from './native-fixture';

async function fixtures(page: Page) {
  const overview = await (await page.request.get('/api/overview')).json();
  const root = path.dirname(overview.session_root);
  expect(path.basename(root)).toMatch(/^draken-browser-/);
  return { root, sessions: overview.session_root, control: path.join(overview.session_root, 'fake-control.json') };
}
const microphone = nativePeer;
function addActivity(sessions: string) {
  const id = randomUUID(), timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(sessions, id + '.jsonl'), [
    { type: 'session', version: 3, id, timestamp, cwd: '/demo/new-work' },
    { type: 'message', id, parentId: null, timestamp, message: { role: 'toolResult', content: [{ type: 'text', text: 'New isolated test result ' + id + ': deployment not checked.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
}
async function end(page: Page) {
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Call Draken', exact: true })).toBeVisible();
}

test.afterEach(async ({ page }) => {
  await fixtures(page); // Assert this is the isolated synthetic server before cleanup.
  const status = await (await page.request.get('/api/voice/status')).json();
  if (status.activeCall) await page.request.post(`/api/voice/live/calls/${status.activeCall.id}/end`, { data: {} });
  await page.evaluate(() => (window as any).__disposeNative?.()).catch(() => {});
});

test('one click scans, freezes, prepares and calls; compact cards and independent URLs retain summaries', async ({ page }) => {
  await microphone(page); const { sessions, control } = await fixtures(page); fs.writeFileSync(control, JSON.stringify({ delay: 50 }));
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Sync with Draken', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
  await expect(page.locator('textarea, .tree-card, .session-source')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sync with Draken', exact: true }).click();
  await expect(page).toHaveURL(/\/syncs\/\d+$/); const firstId = Number(new URL(page.url()).pathname.split('/').pop());
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('dialog').getByRole('status', { name: 'Call state' })).toHaveText('Your turn', { timeout: 15000 });
  expect(await page.evaluate(() => (window as any).__captures)).toBe(1);
  const first = await (await page.request.get(`/api/syncs/${firstId}`)).json(); expect(first.items.length).toBeGreaterThan(50);
  await end(page);
  expect(first.aggregation_cost.complete).toBe(true); expect(first.aggregation_cost.usd).toBeGreaterThan(0);
  await expect(page.locator('.page-heading .sync-cost')).toContainText('Est. cost: $');
  expect((await (await page.request.get(`/api/syncs/${firstId}`)).json()).aggregation_cost).toEqual(first.aggregation_cost);
  expect(await page.evaluate(() => (window as any).__tracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('.recap-card')).toContainText('deployment remains unverified');
  await page.getByRole('link', { name: 'All syncs', exact: true }).click();
  await expect(page).toHaveURL(/\/$/); await expect(page.locator('.sync-tile').first()).toBeVisible();
  const card = page.locator('.sync-tile').first(); await expect(card).toHaveAttribute('href', `/syncs/${firstId}`);
  await expect(card.locator('.sync-cost')).toContainText('Est. cost: $');
  await expect(card.locator('.sync-cost')).toHaveAttribute('title', /not a subscription charge or invoice/);
  expect(await card.locator('.sync-tile-preview').evaluate(element => element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) * 3 + 1)).toBe(true);
  const tracked = await (await page.request.get('/api/home')).json(); expect(tracked.covered).toBe(0); expect(tracked.included_unreviewed).toBe(first.items.length);
  await page.screenshot({ path: '.test-artifacts/sync-home-desktop.png', fullPage: true });

  addActivity(sessions);
  await page.getByRole('button', { name: 'Sync with Draken', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30000 }); const secondId = Number(new URL(page.url()).pathname.split('/').pop());
  expect(secondId).not.toBe(firstId); const second = await (await page.request.get(`/api/syncs/${secondId}`)).json();
  expect(second.items).toHaveLength(1); expect(second.memory[0].sync_id).toBe(firstId); expect(second.memory[0].recap).toContain('deployment remains unverified');
  expect((await (await page.request.get(`/api/syncs/${firstId}`)).json()).status).toBe('open');
  await end(page);
  await page.reload(); await expect(page.getByRole('button', { name: 'Call Draken', exact: true })).toBeVisible(); expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
  await page.getByText('Previous sync recaps', { exact: true }).click(); await expect(page.locator('.memory-recap')).toContainText('not marked reviewed');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await expect(page.locator('.page-heading .status')).toHaveText('reviewed');
  expect((await (await page.request.get('/api/home')).json()).covered).toBe(1);
  await page.getByRole('link', { name: 'All syncs', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: '.test-artifacts/sync-home-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator(`.sync-tile[href="/syncs/${firstId}"]`).click(); await expect(page).toHaveURL(new RegExp(`/syncs/${firstId}$`));
  expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
  await page.goBack(); await expect(page).toHaveURL(/\/$/); await page.goForward(); await expect(page).toHaveURL(new RegExp(`/syncs/${firstId}$`));
});

test('failed or cancelled preparation preserves its snapshot and never captures on reload', async ({ page }) => {
  await microphone(page); const { sessions, control } = await fixtures(page); addActivity(sessions);
  fs.writeFileSync(control, JSON.stringify({ delay: 100, failStage: 'chunk' }));
  await page.goto('/'); await page.getByRole('button', { name: 'Sync with Draken', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry preparation & call', exact: true })).toBeVisible({ timeout: 30000 });
  const id = Number(new URL(page.url()).pathname.split('/').pop());
  expect(await page.evaluate(() => (window as any).__captures)).toBe(0); await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toBeDisabled();
  await page.reload(); expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
  fs.writeFileSync(control, JSON.stringify({ delay: 2000 }));
  await page.getByRole('button', { name: 'Retry preparation & call', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry preparation & call', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
  fs.writeFileSync(control, JSON.stringify({ delay: 50 }));
  await page.getByRole('button', { name: 'Retry preparation & call', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30000 }); await end(page);
  expect((await (await page.request.get(`/api/syncs/${id}`)).json()).status).toBe('open');
});

test('missing pi originals remain inspectable as unavailable; notes survive and restore needs no new call', async ({ page }) => {
  await microphone(page);const { sessions,control }=await fixtures(page);addActivity(sessions);fs.writeFileSync(control,JSON.stringify({delay:20}));
  const {sync}=await(await page.request.post('/api/syncs/start-call',{data:{request_id:randomUUID()}})).json();
  await expect.poll(async()=>(await(await page.request.get(`/api/syncs/${sync.id}/progress`)).json()).run?.status,{timeout:30000}).toBe('completed');
  const original=await(await page.request.get(`/api/syncs/${sync.id}`)).json(),file=original.items[0].source_path;
  expect(path.dirname(file)).toBe(sessions);fs.renameSync(file,file+'.hidden');
  try {
    await page.goto(`/syncs/${sync.id}`);await expect(page.getByRole('alert')).toContainText('Original session evidence unavailable');
    await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Mark reviewed',exact:true})).toBeDisabled();
    await page.getByText('Evidence & preparation details',{exact:true}).click();await page.getByText('Original session source unavailable',{exact:true}).first().click();
    await expect(page.locator('.evidence-body').filter({hasText:'Draken does not keep a text copy'})).toBeVisible();
    await page.getByText('Decisions & carry-forward',{exact:true}).click();await page.getByLabel('Decisions',{exact:true}).fill('Explicit note while source is offline.');await page.getByRole('button',{name:'Save notes',exact:true}).click();
    await expect.poll(async()=>(await(await page.request.get(`/api/syncs/${sync.id}`)).json()).decisions).toBe('Explicit note while source is offline.');
    expect((await page.request.post(`/api/syncs/${sync.id}/briefing`)).status()).toBe(409);
    expect((await page.request.post('/api/voice/live/calls',{data:{syncId:sync.id}})).status()).toBe(409);
    expect(await page.evaluate(()=>(window as any).__captures)).toBe(0);
  } finally { fs.renameSync(file+'.hidden',file); }
  await page.reload();
  // The exact captured file was restored, not replaced or rewritten. Its
  // verified receipt can be reused without another preparation or capture.
  await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeEnabled({timeout:15000});await expect(page.getByRole('alert')).not.toBeVisible();
  expect(await page.evaluate(()=>(window as any).__captures)).toBe(0);expect((await(await page.request.get(`/api/syncs/${sync.id}`)).json()).items).toEqual(original.items);
});

test('settings persist opt-in automatic indexing without creating a sync, calling models or capturing audio', async ({ page }) => {
 await microphone(page);await fixtures(page);await page.request.patch('/api/settings/auto-index',{data:{enabled:false}});
 const before=await(await page.request.get('/api/home')).json();let settingsReads=0,settingsWrites=0;
 page.on('request',request=>{if(new URL(request.url()).pathname==='/api/settings/auto-index'){if(request.method()==='GET')settingsReads++;else settingsWrites++;}});
 await page.goto('/');const button=page.getByRole('banner').getByRole('button',{name:'Settings',exact:true});await expect(button).toBeVisible();
 await expect(page.getByText('LOCAL PROTOTYPE',{exact:true})).toHaveCount(0);await expect(page.locator('main .index-toggle')).toHaveCount(0);expect(settingsReads).toBe(0);
 await button.click();const dialog=page.getByRole('dialog',{name:'Settings',exact:true}),close=dialog.getByRole('button',{name:'Close settings'});
 const toggle=dialog.getByRole('switch',{name:/Automatically index history/});await expect(toggle).toBeEnabled();await expect(toggle).not.toBeChecked();
 await expect(close).toBeFocused();await page.keyboard.press('Tab');await expect(toggle).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(close).toBeFocused();
 await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(button).toBeFocused();expect(settingsWrites).toBe(0);
 await page.keyboard.press('Enter');await expect(dialog).toBeVisible();
 try {
  await toggle.check();await expect.poll(async()=>(await(await page.request.get('/api/settings/auto-index')).json()).enabled).toBe(true);
  await page.reload();await button.click();await expect(toggle).toBeChecked();
  await expect(dialog).toContainText('at least 64 changed source records');
  await expect(dialog).toContainText('there is no timed flush');
  await expect(dialog).not.toContainText('after five minutes');
  await expect(dialog).toContainText('does not create or change frozen syncs');
  await page.setViewportSize({width:320,height:700});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await close.click();await expect(button).toBeVisible();await page.getByRole('link',{name:'Search history',exact:true}).click();await expect(page).toHaveURL(/\/history$/);
  await button.click();await expect(toggle).toBeChecked();await close.click();await expect(button).toBeFocused();
  expect(await page.evaluate(()=>(window as any).__captures)).toBe(0);expect((await(await page.request.get('/api/home')).json()).syncs.map((s:any)=>s.id)).toEqual(before.syncs.map((s:any)=>s.id));
  await button.click();await toggle.uncheck();await expect.poll(async()=>(await(await page.request.get('/api/settings/auto-index')).json()).enabled).toBe(false);
 }finally{await page.request.patch('/api/settings/auto-index',{data:{enabled:false}});}
});

test('sync cost distinguishes unknown, partial and tiny estimates without mobile overflow', async ({ page }) => {
  await microphone(page); const { control } = await fixtures(page); fs.writeFileSync(control, JSON.stringify({ delay: 20 }));
  const { sync } = await (await page.request.post('/api/syncs/start-call', { data: { request_id: randomUUID() } })).json();
  await expect.poll(async () => (await (await page.request.get(`/api/syncs/${sync.id}/progress`)).json()).run?.status, { timeout: 30000 }).toBe('completed');
  let cost: { usd: number | null; complete: boolean } = { usd: null, complete: false };
  await page.route(`**/api/syncs/${sync.id}`, async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), aggregation_cost: cost } }); });
  await page.setViewportSize({ width: 320, height: 700 }); await page.goto(`/syncs/${sync.id}`);
  await page.getByRole('banner').getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Settings',exact:true})).toBeVisible();await page.getByRole('button',{name:'Close settings'}).click();
  await expect(page.locator('.sync-cost')).toHaveText('Est. cost: unavailable');
  cost = { usd: 0.123, complete: false }; await page.reload(); await expect(page.locator('.sync-cost')).toHaveText('Est. cost: $0.12 (partial)');
  await expect(page.locator('.sync-cost')).toHaveAttribute('title', /some preparation usage\/pricing is missing/);
  cost = { usd: 0.0000001, complete: true }; await page.reload(); await expect(page.locator('.sync-cost')).toHaveText('Est. cost: <$0.000001');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
});

test('Luna batch preparation exposes qualified timing without starting a call or reviewing evidence', async ({ page }) => {
  await microphone(page); const { sessions, control } = await fixtures(page); fs.writeFileSync(control, JSON.stringify({ delay: 20 }));
  const sessionId = randomUUID(), timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(sessions, sessionId + '.jsonl'), [
    { type: 'session', version: 3, id: sessionId, timestamp, cwd: '/synthetic/batch-ui' },
    ...Array.from({ length: 600 }, (_, index) => ({ type: 'message', id: `batch-${index}`, parentId: index ? `batch-${index - 1}` : null, timestamp,
      message: { role: 'assistant', content: [{ type: 'text', text: index === 599 ? 'LATEST: implementation reported; deployment NOT checked.' : `Earlier plan ${index}. ${'x'.repeat(900)}` }] } })),
  ].map(JSON.stringify).join('\n') + '\n');
  const { sync } = await (await page.request.post('/api/syncs/start-call', { data: { request_id: randomUUID() } })).json();
  expect(sync.items.filter((item: { session_id: string }) => item.session_id === sessionId)).toHaveLength(600);
  await expect.poll(async () => (await (await page.request.get(`/api/syncs/${sync.id}/progress`)).json()).run?.status, { timeout: 30000 }).toBe('completed');
  expect((await page.request.patch(`/api/syncs/${sync.id}/models`, { data: { summary: 'openai/gpt-6-luna', final: 'openai/gpt-6-astra', max_invocations: 120 } })).ok()).toBe(true);
  expect((await page.request.post(`/api/syncs/${sync.id}/briefing`)).status()).toBe(202);
  await expect.poll(async () => (await (await page.request.get(`/api/syncs/${sync.id}/progress`)).json()).run?.status, { timeout: 15000 }).toBe('completed');
  const ready = await (await page.request.get(`/api/syncs/${sync.id}`)).json();
  expect(ready.tree.run.processed_entries).toBe(ready.items.length); expect(ready.tree.run.metrics.length).toBeGreaterThan(1);
  await page.goto(`/syncs/${sync.id}`); await page.getByText('Evidence & preparation details', { exact: true }).click();
  await page.getByText('Model request timing', { exact: true }).click();
  await expect(page.locator('.tree-card')).toContainText('not billed usage');
  await expect(page.locator('.tree-card')).toContainText(`${ready.items.length} / ${ready.items.length} entries processed`);
  expect(await page.evaluate(() => (window as any).__captures)).toBe(0); await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const after = await (await page.request.get(`/api/syncs/${sync.id}`)).json(); expect(after.status).toBe('open'); expect(after.decisions).toBe('');
  expect(after.tree.run.invocations).toBe(ready.tree.run.invocations);
});
