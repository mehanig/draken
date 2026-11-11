import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativePeer } from './native-fixture';
import { delayedSources, sourceRefs } from './history-fixture';

async function prepare(page: Page) {
  const status = await (await page.request.get('/api/voice/status')).json();
  expect(status.mode).toBe('native');
  if (status.activeCall) await page.request.post(`/api/voice/live/calls/${status.activeCall.id}/end`, { data: {} });
  const overview = await (await page.request.get('/api/overview')).json();
  const root = path.dirname(overview.session_root);
  expect(path.basename(root)).toMatch(/^draken-browser-/);
  for (const item of overview.syncs.filter((item: any) => item.status === 'open')) {
    await expect.poll(async () => (await (await page.request.get(`/api/syncs/${item.id}/progress`)).json()).busy).toBe(false);
    await page.request.post(`/api/syncs/${item.id}/discard`);
  }
  fs.writeFileSync(path.join(overview.session_root, 'fake-control.json'), JSON.stringify({ delay: 20 }));
  fs.writeFileSync(path.join(root, 'account/scenario.txt'), 'conversation');
  const id = randomUUID(), timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(overview.session_root, `${id}.jsonl`), [
    { type: 'session', version: 3, id, cwd: '/demo/voice-export', timestamp },
    { type: 'message', id: 'q', parentId: null, timestamp, message: { role: 'user', content: 'Fix export timeouts' } },
    { type: 'message', id: 't', parentId: 'q', timestamp, message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'Export tests: 5 passed, 0 failed. Deployment not checked.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const result = await (await page.request.post('/api/syncs', { data: {} })).json();
  const syncId = result.sync.id;
  expect((await page.request.post(`/api/syncs/${syncId}/briefing`)).status()).toBe(202);
  await expect.poll(async () => (await (await page.request.get(`/api/syncs/${syncId}/progress`)).json()).complete).toBe(true);
  const sync = await (await page.request.get(`/api/syncs/${syncId}`)).json();
  const testRef = sync.items.find((item: any) => item.cwd === '/demo/voice-export' && item.role === 'toolResult').ref;
  return { syncId, root, testRef, piLog: () => fs.readFileSync(path.join(root, 'pi-calls.jsonl'), 'utf8') };
}
async function pendingHistory(page: Page, root: string) {
  const id=randomUUID(),timestamp=new Date().toISOString();
  fs.writeFileSync(path.join(root,'sessions',`${id}.jsonl`),[
    {type:'session',version:3,id,cwd:'/demo/call-ready',timestamp},
    {type:'message',id:'new',parentId:null,timestamp,message:{role:'assistant',content:'New history for the next call.'}},
  ].map(JSON.stringify).join('\n')+'\n');
  expect((await page.request.post('/api/scan',{data:{}})).ok()).toBe(true);
}
const dialog = (page: Page) => page.getByRole('dialog', { name: /Sync #/ });
async function openCall(page: Page, id: number, muted = false) {
  await page.goto(`/syncs/${id}`);
  await page.getByRole('button', { name: 'Call Draken', exact: true }).click();
  await expect(dialog(page).getByRole('status', { name: 'Call state' })).toHaveText(muted ? 'Microphone muted' : 'Your turn', { timeout: 15000 });
  await expect(page.locator('.voice-conversation')).not.toHaveAttribute('open');
  await expect(page.locator('.voice-call-details')).not.toBeVisible();
}
async function typeQuestion(page: Page, text = 'Did the export tests pass?') {
  if (!await page.getByRole('textbox', { name: 'Type a question for this call' }).isVisible())
    await page.getByRole('button', { name: 'Type a question', exact: true }).click();
  await page.getByRole('textbox', { name: 'Type a question for this call' }).fill(text);
  await page.getByRole('button', { name: 'Send voice-call question' }).click();
}
const tracksStopped = (page: Page) => page.evaluate(() => (window as any).__tracks.every((track: MediaStreamTrack) => track.readyState === 'ended'));
async function end(page: Page) {
  await page.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  expect(await tracksStopped(page)).toBe(true);
}

test('ChatGPT-only call: local test peer audio, dragon, controls, sources, history and mobile layout', async ({ page }) => {
  const { syncId, piLog, testRef } = await prepare(page);
  const before = piLog(), errors: string[] = [], writes: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/notes$|\/complete$/.test(request.url()) && request.method() !== 'GET') writes.push(request.url());
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== 'http://127.0.0.1:41889') external.push(request.url());
  });
  await nativePeer(page); await openCall(page, syncId);
  await expect(page.locator('.dp-stage')).toHaveAttribute('data-renderer', 'webgl');
  await expect(page.locator('.dp-stage button, .dp-stage figcaption')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mute', exact: true }).click(); expect(await tracksStopped(page)).toBe(true);
  await page.getByRole('button', { name: 'Unmute', exact: true }).click(); expect(await tracksStopped(page)).toBe(false);
  await typeQuestion(page, `What does source ${testRef} report about the export tests?`);
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  await expect(page.locator('.voice-answer')).toContainText('Deployment remains unverified');
  await page.waitForFunction(() => Number(document.querySelector('.dp-canvas')?.getAttribute('data-mouth')) > 3);
  await expect.poll(() => page.evaluate(() => (window as any).__tracks.at(-1).enabled)).toBe(false);
  await page.getByRole('button', { name: 'Headphone mode', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__tracks.at(-1).enabled)).toBe(true);
  await page.getByText('Conversation & details', { exact: true }).click();
  await page.getByText(/^Sources supplied \(/).click();
  await page.getByRole('button', { name: `Source ${testRef}`, exact: true }).click();
  await expect(page.locator('.voice-source pre')).toContainText(/tests/i);
  await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
  await expect(dialog(page).getByRole('status')).toHaveText('Your turn');
  await typeQuestion(page, 'What remains unverified?');
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  await expect(dialog(page).getByRole('status')).toHaveText('Your turn');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await dialog(page).screenshot({ path: '.test-artifacts/voice-native-mobile.png' });
  expect(piLog(), 'Native turns must not invoke pi; only the later recap may do so').toBe(before);
  await end(page);
  const history = await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json();
  expect(history[0].mode).toBe('native'); expect(history[0].status).toBe('ended');
  expect(history[0].turns).toHaveLength(4);
  expect(history[0].turns.every((turn: any) => turn.heard_text === '')).toBe(true);
  expect((await (await page.request.get(`/api/syncs/${syncId}`)).json()).status).toBe('open');
  expect(writes).toEqual([]); expect(errors).toEqual([]); expect(external).toEqual([]);
});

test('call sources reset pagination by identity and cancel reads on switching, source close and call close', async ({ page }) => {
  const { syncId } = await prepare(page), fixture = await delayedSources(page);
  await nativePeer(page);
  let supplied = false, endRequested = false, finishEnd!: () => void;
  const ending = new Promise<void>(resolve => { finishEnd = resolve; });
  await page.route('**/api/voice/live/calls/*/end', async route => {
    endRequested = true;
    const response = await route.fetch();
    await page.evaluate(() => (window as any).__disposeNative?.());
    await ending;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.route('**/api/voice/live/calls/*/events*', async route => {
    const response = await route.fetch(), value = await response.json();
    if (!supplied) { supplied = true; value.events.push({ sequence: 1, type: 'sources', evidence: sourceRefs }); }
    await route.fulfill({ response, json: value });
  });
  const select = async (ref: string) => {
    await page.getByText(/^Sources supplied \(/).click();
    await page.getByRole('button', { name: `History ${ref.slice(-6)}`, exact: true }).click();
  };
  try {
    await openCall(page, syncId);
    await page.getByText('Conversation & details', { exact: true }).click();
    await select(sourceRefs[0]);
    await expect(page.getByRole('heading', { name: 'Source A', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Later text', exact: true }).click();
    await expect.poll(() => fixture.reads.length).toBe(2);
    await select(sourceRefs[1]);
    await expect(page.getByRole('heading', { name: 'Source B', exact: true })).toBeVisible();
    await expect.poll(() => fixture.reads[1].aborted).toBe(true);
    expect(fixture.reads.map(({ ref, offset }) => [ref, offset])).toEqual([[sourceRefs[0], 0], [sourceRefs[0], 4000], [sourceRefs[1], 0]]);
    fixture.release();
    await expect(page.getByRole('region', { name: 'Historical source' })).toContainText('Retained source at offset 0');
    await page.getByRole('button', { name: 'Later text', exact: true }).click();
    await expect.poll(() => fixture.reads.length).toBe(4);
    await page.getByRole('button', { name: 'Close historical source', exact: true }).click();
    await expect.poll(() => fixture.reads[3].aborted).toBe(true);
    fixture.release();
    await select(sourceRefs[1]);
    await expect(page.getByRole('heading', { name: 'Source B', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Later text', exact: true }).click();
    await expect.poll(() => fixture.reads.length).toBe(6);
    await page.getByRole('button', { name: 'End call', exact: true }).click();
    await expect.poll(() => endRequested).toBe(true);
    await expect.poll(() => fixture.reads[5].aborted).toBe(true);
    await expect(dialog(page)).toBeVisible();
    await select(sourceRefs[0]);
    await expect(page.getByRole('heading', { name: 'Source A', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Later text', exact: true }).click();
    await expect.poll(() => fixture.reads.length).toBe(8);
    finishEnd();
    await expect(dialog(page)).not.toBeVisible();
    await expect.poll(() => fixture.reads[7].aborted).toBe(true);
    await expect(page.getByRole('region', { name: 'Historical source' })).toHaveCount(0);
    expect(await tracksStopped(page)).toBe(true);
  } finally { finishEnd(); fixture.release(); }
});

test('history preparation finishes outside the call before Call Draken can be enabled', async ({ page }) => {
 const {syncId,root,piLog}=await prepare(page); await nativePeer(page);
 await expect.poll(async()=>(await(await page.request.get(`/api/syncs/${syncId}/call-readiness`)).json()).ready).toBe(true);
 const control=path.join(root,'sessions/fake-control.json');await pendingHistory(page,root);
 const before=piLog();let reservations=0;
 page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/voice/live/calls'))reservations++;});
 fs.writeFileSync(control,JSON.stringify({delay:20,historyDelay:4000}));
 await page.route('**/api/memory/progress',route=>route.fulfill({json:{active:true,background:false,queued:0,elapsed_ms:1500,updated_at:Date.now(),work:{stage:'indexing',completed:3,total:10,reused:100,remaining_seconds:10,downloaded_bytes:0,download_total_bytes:0}}}));
 try {
  await page.goto(`/syncs/${syncId}`);
  await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Prepare history',exact:true}).click();
  await expect(page.getByRole('region',{name:'Local history progress'})).toContainText('3 / 10 new or changed passages ready');
  await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeDisabled();
  await expect(dialog(page)).not.toBeVisible(); await expect(page.locator('.voice-scene, .dp-stage, .voice-captions')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__captures)).toBe(0); expect(reservations).toBe(0);
  expect((await(await page.request.get('/api/voice/status')).json()).activeCall).toBeNull();
  await page.setViewportSize({width:320,height:700});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeEnabled({timeout:15000});
  expect(piLog()).toBe(before);expect(reservations).toBe(0);expect(await page.evaluate(()=>(window as any).__captures)).toBe(0);
 } finally {fs.writeFileSync(control,JSON.stringify({delay:20}));await page.unroute('**/api/memory/progress');}
 await page.getByRole('button',{name:'Call Draken',exact:true}).click();
 await expect(dialog(page).getByRole('status',{name:'Call state'})).toHaveText('Your turn',{timeout:15000});
 await expect(dialog(page)).not.toContainText('Preparing history');expect(reservations).toBe(1);await end(page);
});

test('cancelled history preparation can be retried without a call, provider summary or microphone',async({page})=>{
 const {syncId,root,piLog}=await prepare(page);await nativePeer(page);
 await expect.poll(async()=>(await(await page.request.get(`/api/syncs/${syncId}/call-readiness`)).json()).ready).toBe(true);
 await pendingHistory(page,root);
 const control=path.join(root,'sessions/fake-control.json'),before=piLog();fs.writeFileSync(control,JSON.stringify({delay:20,historyDelay:60000}));
 try{
  await page.goto(`/syncs/${syncId}`);await page.getByRole('button',{name:'Prepare history',exact:true}).click();
  await page.getByRole('button',{name:'Cancel preparation',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('History preparation stopped');
  await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeDisabled();
  await expect.poll(async()=>(await(await page.request.get(`/api/syncs/${syncId}/progress`)).json()).busy).toBe(false);
  await page.reload();await expect(dialog(page)).not.toBeVisible();expect(await page.evaluate(()=>(window as any).__captures)).toBe(0);
  fs.writeFileSync(control,JSON.stringify({delay:20}));await page.getByRole('button',{name:'Prepare history',exact:true}).click();
  await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeEnabled({timeout:15000});
  expect(piLog()).toBe(before);expect(await page.evaluate(()=>(window as any).__captures)).toBe(0);await expect(dialog(page)).not.toBeVisible();
  expect((await(await page.request.get(`/api/syncs/${syncId}`)).json()).status).toBe('open');
 }finally{fs.writeFileSync(control,JSON.stringify({delay:20}));}
});

test('ready history can be explicitly refreshed without a new summary, call or capture',async({page})=>{
 const {syncId,root,piLog}=await prepare(page);await nativePeer(page);await page.goto(`/syncs/${syncId}`);
 await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeEnabled();
 const before=piLog(),control=path.join(root,'sessions/fake-control.json');
 fs.writeFileSync(control,JSON.stringify({delay:20,historyDelay:1500}));
 try{
  await page.getByRole('button',{name:'Refresh history',exact:true}).click();
  await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeEnabled({timeout:15000});
  expect(piLog()).toBe(before);expect(await page.evaluate(()=>(window as any).__captures)).toBe(0);
  await expect(dialog(page)).not.toBeVisible();expect((await(await page.request.get('/api/voice/status')).json()).activeCall).toBeNull();
 }finally{fs.writeFileSync(control,JSON.stringify({delay:20}));}
});

test('a readiness change at click time stays outside the call without capture or a reservation',async({page})=>{
 const {syncId}=await prepare(page);await nativePeer(page);await page.goto(`/syncs/${syncId}`);
 await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeEnabled();let reservations=0;
 page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/voice/live/calls'))reservations++;});
 await page.route(`**/api/syncs/${syncId}/call-readiness`,route=>route.fulfill({json:{ready:false,briefingReady:true,historyReady:false,preparing:false,before:null,error:''}}));
 await page.getByRole('button',{name:'Call Draken',exact:true}).click();
 await expect(page.getByRole('button',{name:'Prepare history',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Call Draken',exact:true})).toBeDisabled();await expect(dialog(page)).not.toBeVisible();
 expect(reservations).toBe(0);expect(await page.evaluate(()=>(window as any).__captures)).toBe(0);
});

test('microphone denial still allows typed ChatGPT voice, without a local speech fallback', async ({ page }) => {
  const { syncId } = await prepare(page);
  await nativePeer(page, true); await openCall(page, syncId, true);
  await expect(page.getByRole('textbox', { name: 'Type a question for this call' })).toBeVisible();
  await typeQuestion(page);
  await expect(dialog(page).getByRole('status')).toHaveText('Draken is speaking');
  await expect(dialog(page).getByRole('status')).toHaveText('Microphone muted');
  await end(page);
});

test('scene captions replace the banner; transcript stays collapsed and waiting phrases follow real activity', async ({ page }) => {
  test.setTimeout(45000);
  const { syncId, piLog } = await prepare(page); const before = piLog(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const events: any[] = []; let lookup = false;
  const emit = (event: any) => events.push({ ...event, sequence: events.length + 1 });
  await nativePeer(page, true); await page.clock.install();
  // Controlled events and metadata in this isolated fixture; no provider question.
  await page.route('**/api/voice/live/calls/*/events?*', route => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') || 0);
    return route.fulfill({ json: { active: true, events: events.filter(event => event.sequence > after) } });
  });
  await page.route('**/api/memory/progress', async route => route.fulfill({ json: {
    active: lookup, queued: 0, elapsed_ms: 100, updated_at: await page.evaluate(() => Date.now()),
    work: lookup ? { stage: 'searching', completed: 0, total: 0, reused: 0, remaining_seconds: null, downloaded_bytes: 0, download_total_bytes: 0 } : null,
  } }));
  await openCall(page, syncId, true);
  const captions = page.locator('.voice-scene').getByRole('region', { name: 'Live captions' });
  await expect(captions).toHaveText('[Microphone off]');
  await expect(page.locator('.voice-reply-status, .voice-wait-clock')).toHaveCount(0);
  emit({ type: 'message', id: 101, role: 'user', text: 'Check the export', evidence: [], final: false });
  await expect(captions).toHaveText('YouCheck the export');
  emit({ type: 'message', id: 101, role: 'user', text: 'Check the export history.', evidence: [], final: true });
  emit({ type: 'answer_pending', id: 101, pending: true });
  await expect(captions).toHaveText('[Thinking...]');
  await page.evaluate(() => { const channel = (window as any).__remote.channel; channel.send(JSON.stringify({type:'input_transcript.added'})); channel.send(JSON.stringify({type:'turn.done',turn:{role:'user'}})); });
  await page.waitForTimeout(350); await expect(captions).toHaveText('[Thinking...]');
  emit({ type: 'message', id: 102, role: 'assistant', text: 'Let me check that.', evidence: [], final: true });
  await page.evaluate(() => { const w = window as any; w.__speakNative(); clearTimeout(w.__remote.timer); });
  await expect(captions).toHaveText('DrakenLet me check that.');
  await page.evaluate(() => { (window as any).__remote.volume.gain.value = 0; }); // No turn.done.
  await expect(captions).toHaveText('[Thinking...]');
  await page.clock.fastForward(5000); await expect(captions).toHaveText('[Hmmm...]');
  await page.clock.fastForward(5000); await expect(captions).toHaveText('[Hmmmmmm...]');
  lookup = true; await expect(captions).toHaveText('[Checking...]');
  await page.clock.fastForward(5000); await expect(captions).toHaveText('[Looking that up...]');
  lookup = false; await expect(captions).toHaveText('[Thinking...]');
  await expect(page.locator('.voice-call-details')).not.toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const scene = (await page.locator('.voice-scene').boundingBox())!, box = (await captions.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(scene.x); expect(box.x + box.width).toBeLessThanOrEqual(scene.x + scene.width);
    expect(box.y).toBeGreaterThanOrEqual(scene.y); expect(box.y + box.height).toBeLessThanOrEqual(scene.y + scene.height);
    await dialog(page).screenshot({ path: `.test-artifacts/voice-captions-${width}.png` });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await captions.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  emit({ type: 'answer_pending', id: 101, pending: false, error: 'A completed voice answer was not confirmed.' });
  await expect(captions).toHaveText('[Reply unavailable]');
  await expect(dialog(page).getByRole('alert')).toBeVisible(); // Never hidden in the disclosure.
  emit({ type: 'message', id: 103, role: 'user', text: 'A new question.', evidence: [], final: true });
  emit({ type: 'answer_pending', id: 103, pending: true });
  await expect(captions).toHaveText('[Thinking...]');
  const longReply = 'Earlier context 👋 '.repeat(30) + 'Последняя запись: tests passed. Deployment NOT checked. <img src=x onerror=alert(1)>';
  emit({ type: 'message', id: 104, role: 'assistant', text: longReply, evidence: [], final: true });
  await page.evaluate(() => { const w = window as any; w.__speakNative(); clearTimeout(w.__remote.timer); });
  await expect(captions).toContainText('Deployment NOT checked.');
  expect(Array.from(await captions.innerText()).length).toBeLessThan(155);
  await expect(captions.locator('img')).toHaveCount(0);
  expect(await captions.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByText('Conversation & details', { exact: true }).click();
  await expect(page.locator('.voice-answer')).toHaveText(longReply); await expect(page.locator('.voice-answer')).toBeVisible();
  await page.getByText('Conversation & details', { exact: true }).click();
  await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
  await expect(captions).toHaveText('[Reply stopped]');
  emit({ type: 'answer_pending', id: 103, pending: true });
  await page.waitForTimeout(400); await expect(captions).toHaveText('[Reply stopped]');
  expect(piLog()).toBe(before); expect(errors).toEqual([]); await end(page);
  events.length = 0;
  await page.getByRole('button', { name: 'Call Draken', exact: true }).click();
  await expect(dialog(page).getByRole('status', { name: 'Call state' })).toHaveText('Microphone muted', { timeout: 15000 });
  await expect(page.locator('.voice-conversation')).not.toHaveAttribute('open');
  await end(page);
});

test('drawing failure does not break the native call', async ({ page }) => {
  const { syncId } = await prepare(page); await nativePeer(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: any[]) {
      return String(args[0]).startsWith('webgl') ? null : (original as any).apply(this, args);
    } as typeof original;
  });
  await openCall(page, syncId);
  await expect(page.locator('.dp-stage')).toHaveAttribute('data-renderer', 'fallback');
  expect(await page.locator('.dp-poster').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await typeQuestion(page); await expect(page.locator('.voice-captions')).toContainText('Deployment remains unverified');
  await end(page);
});

test('failed native setup stops capture instead of trying another voice engine', async ({ page }) => {
  const { syncId, piLog } = await prepare(page); const before = piLog();
  await nativePeer(page);
  await page.route('**/api/voice/live/calls/*/connect', route => route.fulfill({ status: 503, json: { error: 'Synthetic native setup failure' } }));
  const retired: string[] = [];
  page.on('request', request => { if (/\/api\/voice\/calls/.test(request.url())) retired.push(request.url()); });
  await page.goto(`/syncs/${syncId}`);
  // Bound cleanup from the injected failure, not from unrelated history/ICE setup.
  const rejected = page.waitForResponse(response => response.url().includes('/api/voice/live/calls/') && response.url().endsWith('/connect'), { timeout: 15000 });
  await page.getByRole('button', { name: 'Call Draken', exact: true }).click();
  expect((await rejected).status()).toBe(503);
  await expect(dialog(page).getByRole('status')).toHaveText('Call ended');
  await expect(dialog(page).getByRole('alert')).toContainText('Voice connection failed or cancelled.');
  expect(await tracksStopped(page)).toBe(true); expect(retired).toEqual([]); expect(piLog()).toBe(before);
  await expect.poll(async () => (await (await page.request.get('/api/voice/status')).json()).activeCall).toBeNull();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
});

test('a failed text delivery can be retried explicitly on the same call', async ({ page }) => {
  const { syncId } = await prepare(page); await nativePeer(page); await openCall(page, syncId);
  let first = true;
  await page.route('**/api/voice/live/calls/*/text', async route => {
    if (first) { first = false; await route.fulfill({ status: 503, json: { error: 'Synthetic network interruption' } }); }
    else await route.fallback();
  });
  await typeQuestion(page);
  await expect(dialog(page).getByRole('alert')).toContainText('Synthetic network interruption');
  await page.getByRole('button', { name: 'Retry question', exact: true }).click();
  await expect(page.locator('.voice-answer')).toContainText('Deployment remains unverified');
  await expect(dialog(page).getByRole('alert')).not.toBeVisible();
  await end(page);
  expect((await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json())[0].turns).toHaveLength(2);
});

test('legacy call records remain readable alongside native messages', async ({ page }) => {
  const { syncId, root } = await prepare(page);
  const Database = require('better-sqlite3'), db = new Database(path.join(root, 'state/draken.db'));
  try {
    db.prepare("INSERT INTO voice_calls(id,sync_id,status,started_at,model,end_reason) VALUES ('legacy-ui',?,'ended',?,'retired','Ended by user')").run(syncId, '2020-01-01T00:00:00.000Z');
    db.prepare("INSERT INTO voice_turns(call_id,request_id,question,answer,heard_text,status,started_at,messages_saved) VALUES ('legacy-ui','old-question','Old question','Historical answer','Historical answer','completed',?,1)").run('2020-01-01T00:00:00.000Z');
  } finally { db.close(); }
  await nativePeer(page); await openCall(page, syncId); await typeQuestion(page);
  await expect(page.locator('.voice-answer')).toContainText('Deployment remains unverified'); await end(page);
  await page.getByText('Call history', { exact: true }).click();
  const old = page.locator('.voice-history-call').filter({ hasText: '1 turns' });
  await old.locator('summary').click();
  await expect(old).toContainText('retired local speech engine'); await expect(old).toContainText('Historical answer');
  const history = await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json();
  expect(history.map((call: any) => call.mode)).toEqual(['native', 'legacy']);
});

test('reload retains interrupted native output but never resumes microphone capture', async ({ page }) => {
  const { syncId, root } = await prepare(page); fs.writeFileSync(path.join(root, 'account/scenario.txt'), 'partial');
  await nativePeer(page); await openCall(page, syncId); await typeQuestion(page);
  await expect(page.locator('.voice-answer')).toContainText('targeted export tests passed');
  await page.reload(); await expect(dialog(page)).not.toBeVisible();
  await expect.poll(async () => (await (await page.request.get('/api/voice/status')).json()).activeCall).toBeNull();
  expect(await page.evaluate(() => (window as any).__captures)).toBe(0);
  const history = await (await page.request.get(`/api/voice/syncs/${syncId}/history`)).json();
  expect(history[0].turns.at(-1).status).toBe('interrupted');
  expect(history[0].turns.at(-1).heard_text).toBe('');
});
