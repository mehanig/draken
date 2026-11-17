import {test, expect, type Page} from '@playwright/test';
const empty={phase:'checking',needs_processing:null,cached:null,total:null,checked_at:null,error:''};
const ready={...empty,phase:'ready',needs_processing:2,cached:8,total:10,checked_at:'2026-01-01T00:00:00Z'};
const home={available:10,included_unreviewed:0,covered:0,busy:false,active_call:false,syncs:[],next_cursor:null};
const region=(page:Page)=>page.getByRole('region',{name:'Reusable summary work',exact:true});
async function fixture(page:Page){
 await page.clock.install();
 await page.route(url=>url.pathname.startsWith('/api/'),route=>route.fulfill({status:503,json:{error:'Unmocked API forbidden'}}));
 await page.route('**/api/auth/status',route=>route.fulfill({json:{enabled:false}}));
 await page.route('**/api/home',route=>route.fulfill({json:home}));
 await page.route('**/api/setup*',route=>route.fulfill({json:{data_dir:'/synthetic',pi:{state:'configured',source:'managed',models:[],agent_dir:'/synthetic/pi',message:'Synthetic setup'}}}));
 await page.route('**/api/voice/status',route=>route.fulfill({json:{installed:true,activeCall:null}}));
 await page.route('**/api/settings/auto-index',route=>route.fulfill({json:{enabled:false,phase:'off'}}));
}
async function tick(page:Page){await page.clock.runFor(4100);await page.waitForTimeout(50);}
test('REGRESSION: background work lasting more than one retry must eventually resume the check',async({page})=>{
 await fixture(page);let busy=true,posts=0,gets=0,state={...empty,phase:'paused'};
 await page.route('**/api/preparation-preview',route=>{
  if(route.request().method()==='POST'){posts++;state=busy?{...empty,phase:'paused'}:ready;}else {
   gets++;
   // Corrected backend metadata semantics; GET never runs verification itself.
   if(state.phase==='paused'&&!busy)state={...empty,phase:'stale'};
  }
  return route.fulfill({json:state});
 });
 await page.goto('/');await expect(region(page)).toContainText('check paused');
 await tick(page);await expect.poll(()=>posts).toBe(2);
 await tick(page);await tick(page);expect(posts).toBe(2);busy=false;
 for(let n=0;n<5;n++)await tick(page);
 console.log('Independent paused evidence:',JSON.stringify({posts,gets,backendBusy:busy,text:await region(page).innerText()}));
 await expect(region(page)).toContainText('Already cached: 8 entries',{timeout:1500});
 expect(posts).toBe(3);expect(gets).toBeGreaterThan(3);
});
test('REGRESSION: a completed source mutation must clear unavailable for the old input generation',async({page})=>{
 await fixture(page);let requests=0,posts=0,mutations=0;
 await page.route('**/api/preparation-preview',route=>{
  requests++;if(route.request().method()==='POST')posts++;
  return route.fulfill({json:mutations?ready:{...empty,phase:'unavailable',error:'Old source cannot be read'}});
 });
 const sources={agents:[{id:'pi',name:'pi',enabled:true,roots:[],available:true}],sessions:[],session_root:'/synthetic',stats:{}};
 await page.route('**/api/overview',route=>route.fulfill({json:sources}));
 await page.route('**/api/agents/pi',route=>{mutations++;return route.fulfill({json:{...sources,agents:[{...sources.agents[0],enabled:false}]}});});
 await page.goto('/');await expect(region(page)).toContainText('Old source cannot be read');
 await tick(page);await tick(page);expect(requests).toBe(1); // sticky for unchanged inputs
 await page.getByRole('banner').getByRole('button',{name:'Settings',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Settings',exact:true});
 await dialog.getByText('Agents & sessions',{exact:true}).click();
 await dialog.getByRole('switch',{name:'Enable pi history'}).uncheck();
 await expect.poll(()=>mutations).toBe(1);await page.keyboard.press('Escape');
 await tick(page);await tick(page);
 console.log('Independent generation evidence:',JSON.stringify({requests,posts,mutations,text:await region(page).innerText()}));
 await expect(region(page)).toContainText('Already cached: 8 entries',{timeout:1500});
 expect(posts).toBe(2);
});

test('integration: real metadata GET recovers after native background work outlasts the UI retry', async ({ page }) => {
 const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
 const cp = require('node:child_process'), { EventEmitter } = require('node:events');
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-preview-browser-'));
 fs.mkdirSync(root + '/sessions');
 const env = { ...process.env }, originalFork = cp.fork;
 Object.assign(process.env, { DRAKEN_DATA_DIR: root + '/state', DRAKEN_PI_SESSIONS_DIR: root + '/sessions',
  DRAKEN_PI_BIN: '/no-real-provider', DRAKEN_PI_SUMMARY_MODEL: 'synthetic/summary', DRAKEN_PI_FINAL_MODEL: 'synthetic/final', DRAKEN_NO_AUTH: 'true' });
 const rows = [{ type: 'session', version: 3, id: 'synthetic-browser', cwd: '/synthetic', timestamp: '2026-01-01T00:00:00Z' },
  ...Array.from({ length: 5 }, (_, n) => ({ type: 'message', id: 'm' + n, parentId: n ? 'm' + (n - 1) : null,
   timestamp: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), message: { role: n ? 'assistant' : 'user', content: [{ type: 'text', text: 'Synthetic work ' + n }] } }))];
 fs.writeFileSync(root + '/sessions/synthetic.jsonl', rows.map(JSON.stringify).join('\n') + '\n');
 let native: any, message: any, nativeCalls = 0;
 cp.fork = () => {
  native = new EventEmitter(); native.pid = 123; native.exitCode = null; native.signalCode = null;
  native.send = (value: any, cb: any) => { nativeCalls++; message = value; cb?.(); };
  native.kill = () => { setImmediate(() => { native.signalCode = 'SIGTERM'; native.emit('exit', null, 'SIGTERM'); }); return true; };
  return native;
 };
 const { activity } = require('../../dist/sync/activity'), memory = require('../../dist/memory/service');
 const store = require('../../dist/sync/store'), preview = require('../../dist/sync/preparation-preview');
 const { SummaryTree } = require('../../dist/sync/tree'), { closeDb } = require('../../dist/db/schema');
 const worker = require('../fixtures/preview-worker.cjs').install();
 const originalCall = SummaryTree.prototype.call, originalInput = store.previewSummaryInput;
 let reads = 0, providerCalls = 0, server: any, work: Promise<unknown> | undefined;
 SummaryTree.prototype.call = () => { providerCalls++; throw Error('Provider forbidden'); };
 store.previewSummaryInput = () => { reads++; return originalInput(); };
 try {
  await require('../../dist/sync/collector').scanSessions();
  work = memory.prepareHistory(new Date().toISOString(), new AbortController().signal, true).catch((error: unknown) => error);
  expect(memory.historyProgress().active).toBe(true);
  server = require('../../dist/server').createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/preparation-preview`;
  await fixture(page);
  let posts = 0, gets = 0;
  const phases: string[] = [];
  await page.route('**/api/preparation-preview', async route => {
   const method = route.request().method(); method === 'POST' ? posts++ : gets++;
   const response = await fetch(url, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) });
   const value = await response.json(); phases.push(method + ':' + value.phase);
   await route.fulfill({ status: response.status, json: value });
  });
  await page.goto('/'); await expect(region(page)).toContainText('check paused');
  await tick(page); await expect.poll(() => posts).toBe(2);
  for (let n = 0; n < 4; n++) await tick(page);
  expect(posts).toBe(2); expect(gets).toBeGreaterThanOrEqual(4); expect(reads).toBe(0);
  expect(memory.historyProgress().active).toBe(true); expect(activity.previewIdle).toBe(true);
  native.emit('message', { id: message.id, value: undefined }); expect(await work).toBeUndefined();
  expect(preview.preparationPreview().phase).toBe('stale'); expect(reads).toBe(0);
  await tick(page); await expect.poll(() => posts).toBe(3);
  await expect.poll(() => preview.preparationPreview().phase).toBe('ready');
  await tick(page); await expect(region(page)).toContainText('Needs new summaries: 5 entries');
  await expect(region(page)).toContainText('Already cached: 0 entries');
  for (let n = 0; n < 3; n++) await tick(page);
  expect(posts).toBe(3); expect(reads).toBe(0); expect(nativeCalls).toBe(1); expect(providerCalls).toBe(0);
  expect(worker.workers).toHaveLength(1);
  expect(worker.events.filter((event: any) => event.previewTest === 'input')).toHaveLength(1);
  expect(worker.events.filter((event: any) => event.previewTest === 'provider')).toHaveLength(0);
  expect(phases).toContain('GET:stale'); expect(phases).toContain('POST:checking');
  console.log('Actual backend/browser recovery:', JSON.stringify({ posts, gets, reads, nativeCalls, providerCalls, phases }));
 } finally {
  await page.unrouteAll({ behavior: 'wait' });
  await activity.drainPreview(); await memory.stopHistory(); await work?.catch(() => {});
  if (server) await new Promise<void>(resolve => server.close(resolve));
  worker.restore();
  cp.fork = originalFork; SummaryTree.prototype.call = originalCall; store.previewSummaryInput = originalInput;
  closeDb(); for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env);
  fs.rmSync(root, { recursive: true, force: true });
 }
});
