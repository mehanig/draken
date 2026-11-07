// Main native controller against local peers/API doubles. No provider or real microphone.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), ts = require('typescript');
const { chromium } = require('@playwright/test');
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
const modules = {
  '/client/src/voice/live-session.js': ts.transpileModule(fs.readFileSync(path.join(__dirname, '../client/src/voice/live-session.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText,
  '/client/src/voice/api': ts.transpileModule(fs.readFileSync(path.join(__dirname, '../client/src/voice/api.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText,
  '/voice/realtime/peer.mjs': fs.readFileSync(path.join(__dirname, '../voice/realtime/peer.mjs'), 'utf8'),
};
async function fixture({ denied = false, lateMic = false, slowOffer = false, slowText = false, holdPreparation = false, failPreparation = false } = {}) {
  let page, releasePreparation; const requests = [], errors = [], events = []; let active = true, preparationAborted = false;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (modules[url.pathname]) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(modules[url.pathname]); return; }
      if (url.pathname === '/') { res.end('<button id="start">Start test</button><script type="module">import {LiveVoiceSession} from "/client/src/voice/live-session.js";window.Controller=LiveVoiceSession;</script>'); return; }
      let raw = ''; for await (const chunk of req) raw += chunk; requests.push({ path: url.pathname, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      let value;
      if (url.pathname.endsWith('/calls')) {
        res.on('close', () => { if (!res.writableEnded) { preparationAborted = true; active = false; } });
        if (holdPreparation) await new Promise(resolve => releasePreparation = resolve);
        if (res.destroyed) return;
        if (failPreparation) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Synthetic history preparation failed' })); return; }
        value = { id: JSON.parse(raw).requestId, startedAt: Date.now() };
      }
      else if (url.pathname.endsWith('/connect')) {
        if (slowOffer) await new Promise(resolve => setTimeout(resolve, 400));
        value = { sdp: slowOffer ? 'v=0\r\nm=audio 9 invalid-late-answer' : await page.evaluate(sdp => window.answer(sdp), JSON.parse(raw).sdp) };
      } else if (url.pathname.endsWith('/events')) value = { active, events: events.filter(event => event.sequence > Number(url.searchParams.get('after') || 0)) };
      else if (url.pathname.endsWith('/text') && slowText) await new Promise(resolve => setTimeout(resolve, 600));
      else if (url.pathname.endsWith('/end')) active = false;
      if (res.destroyed) return;
      if (value) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
      else { res.writeHead(204); res.end(); }
    } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
  }).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const context = await browser.newContext(); page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.Controller);
  await page.evaluate(({ denied, lateMic }) => {
    localStorage.setItem('draken_token', 'synthetic-test-token');
    window.state = null; window.tracks = []; window.captureCalls = 0;
    document.querySelector('#start').onclick = async () => {
      const ctx = new AudioContext(); await ctx.resume(); const pc = new RTCPeerConnection(), output = ctx.createMediaStreamDestination();
      const volume = ctx.createGain(); volume.gain.value = 0; const tone = ctx.createOscillator(); tone.connect(volume); volume.connect(output); tone.start();
      pc.addTrack(output.stream.getAudioTracks()[0], output.stream); pc.ondatachannel = event => { window.channel = event.channel; };
      window.remote = { ctx, pc, volume, output };
      window.answer = async sdp => { await pc.setRemoteDescription({ type: 'offer', sdp }); await pc.setLocalDescription(await pc.createAnswer()); await new Promise(resolve => { if (pc.iceGatheringState === 'complete') resolve(); else pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); }; }); return pc.localDescription.sdp; };
      navigator.mediaDevices.getUserMedia = async () => {
        window.captureCalls++; if (denied) throw Error('Synthetic microphone denial');
        if (lateMic) await new Promise(resolve => window.releaseMic = resolve);
        const stream = ctx.createMediaStreamDestination().stream; window.tracks.push(...stream.getTracks()); return stream;
      };
      window.controller = new window.Controller({ onState: value => window.state = value, onLevel: () => {}, onTurn: () => {}, onPlayback: cue => window.cue = cue });
      void window.controller.start(1);
    };
  }, { denied, lateMic });
  return { page, requests, errors, releasePreparation: () => releasePreparation?.(), get preparationAborted() { return preparationAborted; },
    emit(event) { events.push({ ...event, sequence: events.length + 1 }); },
    async close() { await page.evaluate(async () => { await window.controller?.end(); if (window.remote) { window.remote.pc.close(); window.remote.output.stream.getTracks().forEach(track => track.stop()); await window.remote.ctx.close(); } }).catch(() => {}); releasePreparation?.(); await context.close(); await new Promise(resolve => server.close(resolve)); } };
}

test('native controller gates speakers, permits headphones, stops locally, and resumes typed replies within the same provider turn', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.page.click('#start'); await f.page.waitForFunction(() => window.state?.phase === 'listening');
    await f.page.evaluate(() => { window.channel.send(JSON.stringify({ type: 'turn.created', turn: { role: 'assistant' } })); window.remote.volume.gain.value = 0.15; });
    await f.page.waitForFunction(() => window.state.phase === 'speaking' && window.cue?.level() > 0.1);
    assert.equal(await f.page.evaluate(() => window.tracks[0].enabled), false);
    await f.page.evaluate(() => window.controller.setVoiceInterruption(true)); assert.equal(await f.page.evaluate(() => window.tracks[0].enabled), true);
    await f.page.evaluate(() => window.controller.interrupt()); assert.equal(await f.page.evaluate(() => window.cue.level()), 0);
    await f.page.evaluate(() => window.controller.sendText('Next question')); // No new turn.created.
    await f.page.waitForFunction(() => window.state.phase === 'speaking' && window.cue.level() > 0.1);
    await f.page.evaluate(() => window.controller.toggleMute()); assert.equal(await f.page.evaluate(() => window.tracks[0].readyState), 'ended');
    await f.page.evaluate(() => window.controller.toggleMute()); assert.equal(await f.page.evaluate(() => window.tracks[1].readyState), 'live');
    await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await f.page.waitForFunction(() => window.state.phase === 'ended' && window.cue === null);
    assert.equal(await f.page.evaluate(() => window.tracks.every(track => track.readyState === 'ended')), true);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.requests.filter(item => item.path.endsWith('/end')).length, 1);
    assert.ok(f.requests.every(item => item.authorization === 'Bearer synthetic-test-token'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('retrieval keeps the call thinking after an acknowledgement, then plays the automatic answer without another prompt', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.page.click('#start'); await f.page.waitForFunction(() => window.state?.phase === 'listening');
    f.emit({ type: 'message', id: 1, role: 'user', text: 'Check the export tests.', evidence: [], final: true });
    f.emit({ type: 'answer_pending', id: 1, pending: true });
    await f.page.waitForFunction(() => window.state.notice.includes('continue automatically'));
    await f.page.evaluate(() => { window.channel.send(JSON.stringify({ type: 'turn.created', turn: { role: 'assistant' } })); window.remote.volume.gain.value = 0.15; });
    await f.page.waitForFunction(() => window.state.phase === 'speaking');
    await f.page.evaluate(() => { window.remote.volume.gain.value = 0; window.channel.send(JSON.stringify({ type: 'turn.done', turn: { role: 'assistant' } })); });
    await f.page.waitForFunction(() => window.state.phase === 'thinking');
    assert.equal(await f.page.evaluate(() => window.tracks[0].enabled), true, 'user can interrupt while waiting for retrieval');
    await f.page.evaluate(() => { window.channel.send(JSON.stringify({ type: 'turn.created', turn: { role: 'assistant' } })); window.remote.volume.gain.value = 0.15; });
    await f.page.waitForFunction(() => window.state.phase === 'speaking');
    f.emit({ type: 'answer_pending', id: 1, pending: false });
    await f.page.evaluate(() => { window.remote.volume.gain.value = 0; window.channel.send(JSON.stringify({ type: 'turn.done', turn: { role: 'assistant' } })); });
    await f.page.waitForFunction(() => window.state.phase === 'listening' && !window.state.notice);
    assert.equal(f.requests.filter(x => x.path.endsWith('/text')).length, 0);
    f.emit({ type: 'answer_pending', id: 1, pending: true });
    await f.page.waitForFunction(() => window.state.phase === 'thinking');
    await f.page.evaluate(() => window.controller.interrupt());
    f.emit({ type: 'answer_pending', id: 1, pending: true });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(await f.page.evaluate(() => window.state.phase), 'listening');
    assert.match(await f.page.evaluate(() => window.state.notice), /muted locally/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('pending progress survives microphone notices and quiet acknowledgements without provider turn.done', { timeout: 15000 }, async () => {
  const f = await fixture({ denied: true });
  try {
    await f.page.click('#start'); await f.page.waitForFunction(() => window.state?.phase === 'listening');
    f.emit({ type: 'message', id: 1, role: 'user', text: 'Check the history.', evidence: [], final: true });
    f.emit({ type: 'answer_pending', id: 1, pending: true });
    f.emit({ type: 'message', id: 2, role: 'assistant', text: 'Let me check that.', evidence: [], final: true });
    await f.page.waitForFunction(() => window.state.replyPendingSince > 0);
    const since = await f.page.evaluate(() => window.state.replyPendingSince);
    assert.match(await f.page.evaluate(() => window.state.notice), /Microphone unavailable/);
    await f.page.evaluate(() => { window.channel.send(JSON.stringify({ type: 'turn.created', turn: { role: 'assistant' } })); window.remote.volume.gain.value = 0.15; });
    await f.page.waitForFunction(() => window.state.phase === 'speaking');
    f.emit({ type: 'answer_pending', id: 1, pending: true });
    await f.page.evaluate(() => { window.remote.volume.gain.value = 0; }); // Deliberately no provider turn.done.
    await f.page.waitForFunction(() => window.state.phase === 'thinking');
    assert.equal(await f.page.evaluate(() => window.state.replyPendingSince), since, 'repeated events do not restart the elapsed timer');
    assert.equal(await f.page.evaluate(() => window.state.answer), 'Let me check that.');
    await f.page.evaluate(() => { window.remote.volume.gain.value = 0.15; });
    await f.page.waitForFunction(() => window.state.phase === 'speaking');
    f.emit({ type: 'message', id: 3, role: 'assistant', text: 'The recorded tests passed. Deployment not checked.', evidence: [], final: true });
    f.emit({ type: 'answer_pending', id: 1, pending: false });
    await f.page.waitForFunction(() => !window.state.replyPendingSince);
    await f.page.evaluate(() => { window.channel.send(JSON.stringify({ type: 'output_transcript.added' })); window.remote.volume.gain.value = 0; });
    await f.page.waitForFunction(() => window.state.phase === 'listening');
    assert.equal(f.requests.filter(item => item.path.endsWith('/text')).length, 0); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a new question owns its waiting indicator; stale results, Stop, failure and End cannot leave it spinning', { timeout: 15000 }, async () => {
  const f = await fixture({ slowText: true });
  try {
    await f.page.click('#start'); await f.page.waitForFunction(() => window.state?.phase === 'listening');
    f.emit({ type: 'message', id: 1, role: 'user', text: 'Old question', evidence: [], final: true });
    f.emit({ type: 'answer_pending', id: 1, pending: true });
    await f.page.waitForFunction(() => window.state.replyPendingSince > 0);
    await f.page.evaluate(() => { window.pendingSend = window.controller.sendText('New question'); });
    const since = await f.page.evaluate(() => window.state.replyPendingSince);
    f.emit({ type: 'answer_pending', id: 1, pending: false, error: 'Stale error' });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await f.page.evaluate(() => window.state.replyPendingSince), since);
    assert.equal(await f.page.evaluate(() => window.state.error), '');
    f.emit({ type: 'message', id: 3, role: 'user', text: 'New question', evidence: [], final: true });
    f.emit({ type: 'answer_pending', id: 3, pending: true });
    await f.page.evaluate(() => window.pendingSend);
    f.emit({ type: 'answer_pending', id: 1, pending: false });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await f.page.evaluate(() => window.state.replyPendingSince), since);
    f.emit({ type: 'answer_pending', id: 3, pending: false, error: 'A completed voice answer was not confirmed.' });
    await f.page.waitForFunction(() => !window.state.replyPendingSince && window.state.error);
    await f.page.evaluate(() => window.controller.interrupt());
    await f.page.evaluate(() => { window.pendingSend = window.controller.sendText('Next question after Stop'); });
    f.emit({ type: 'message', id: 5, role: 'user', text: 'Next question after Stop', evidence: [], final: true });
    f.emit({ type: 'answer_pending', id: 5, pending: true });
    await f.page.waitForFunction(() => window.state.replyPendingSince > 0);
    await f.page.evaluate(() => window.controller.interrupt());
    f.emit({ type: 'answer_pending', id: 5, pending: true });
    await f.page.evaluate(() => window.pendingSend);
    assert.equal(await f.page.evaluate(() => window.state.replyPendingSince), 0);
    await f.page.evaluate(() => window.controller.end());
    assert.equal(await f.page.evaluate(() => window.state.replyPendingSince), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('server transcript completion owns waiting despite late or missing unkeyed WebRTC user events', { timeout: 15000 }, async () => {
 const f=await fixture();
 try {
  await f.page.click('#start');await f.page.waitForFunction(()=>window.state?.phase==='listening');
  f.emit({type:'message',id:1,role:'user',text:'Check the history.',evidence:[],final:true});
  await f.page.waitForFunction(()=>window.state.phase==='thinking'&&window.state.replyPendingSince>0);
  const since=await f.page.evaluate(()=>window.state.replyPendingSince);
  await f.page.evaluate(()=>{window.channel.send(JSON.stringify({type:'input_transcript.added'}));window.channel.send(JSON.stringify({type:'turn.done',turn:{role:'user'}}));});
  await new Promise(r=>setTimeout(r,350));assert.equal(await f.page.evaluate(()=>window.state.phase),'thinking');assert.equal(await f.page.evaluate(()=>window.state.replyPendingSince),since);
  f.emit({type:'answer_pending',id:1,pending:false});await f.page.waitForFunction(()=>window.state.phase==='listening'&&!window.state.replyPendingSince);
  await f.page.evaluate(()=>{window.channel.send(JSON.stringify({type:'input_transcript.added'}));window.channel.send(JSON.stringify({type:'turn.done',turn:{role:'user'}}));});
  f.emit({type:'message',id:1,role:'user',text:'Check the history.',evidence:[],final:true});await new Promise(r=>setTimeout(r,350));assert.equal(await f.page.evaluate(()=>window.state.replyPendingSince),0);
  f.emit({type:'message',id:3,role:'user',text:'New spoken question',evidence:[],final:false});await f.page.waitForFunction(()=>window.state.phase==='hearing');
  f.emit({type:'message',id:3,role:'user',text:'New spoken question',evidence:[],final:true});await f.page.waitForFunction(()=>window.state.phase==='thinking'&&window.state.replyPendingSince>0);
  await f.page.evaluate(()=>window.controller.interrupt());f.emit({type:'message',id:3,role:'user',text:'New spoken question',evidence:[],final:true});
  await new Promise(r=>setTimeout(r,350));assert.equal(await f.page.evaluate(()=>window.state.replyPendingSince),0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('a typed request finishing after Stop cannot unmute old output', { timeout: 15000 }, async () => {
  const f = await fixture({ slowText: true });
  try {
    await f.page.click('#start'); await f.page.waitForFunction(() => window.state?.phase === 'listening');
    await f.page.evaluate(() => { window.pendingSend = window.controller.sendText('Check the old question'); });
    while (!f.requests.some(x => x.path.endsWith('/text'))) await new Promise(resolve => setTimeout(resolve, 20));
    await f.page.evaluate(() => window.controller.interrupt());
    await f.page.evaluate(() => window.pendingSend);
    await f.page.evaluate(() => { window.remote.volume.gain.value = 0.15; });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(await f.page.evaluate(() => window.cue.level()), 0);
    assert.equal(await f.page.evaluate(() => window.state.phase), 'listening');
    assert.match(await f.page.evaluate(() => window.state.notice), /muted locally/);
    await f.page.evaluate(() => window.controller.sendText('A genuinely new question'));
    await f.page.waitForFunction(() => window.state.phase === 'speaking');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('history preparation finishes before microphone permission or voice negotiation starts', { timeout: 15000 }, async () => {
  const f = await fixture({ holdPreparation: true });
  try {
    await f.page.click('#start');
    for (let n = 0; n < 100 && !f.requests.some(item => item.path.endsWith('/calls')); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.requests.filter(item => item.path.endsWith('/calls')).length, 1);
    assert.equal(await f.page.evaluate(() => window.captureCalls), 0);
    assert.equal(await f.page.evaluate(() => window.tracks.length), 0);
    assert.match(await f.page.evaluate(() => window.state.notice), /Preparing history.*microphone.*off/);
    assert.equal(f.requests.some(item => item.path.endsWith('/connect')), false);
    f.releasePreparation(); await f.page.waitForFunction(() => window.state?.phase === 'listening');
    assert.equal(await f.page.evaluate(() => window.captureCalls), 1);
    assert.equal(await f.page.evaluate(() => window.state.notice), '');
    assert.equal(f.requests.filter(item => item.path.endsWith('/connect')).length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('failed history preparation never requests the microphone or connects voice', { timeout: 10000 }, async () => {
  const f = await fixture({ failPreparation: true });
  try {
    await f.page.click('#start'); await f.page.waitForFunction(() => window.state?.phase === 'ended');
    assert.match(await f.page.evaluate(() => window.state.error), /history preparation failed/);
    assert.equal(await f.page.evaluate(() => window.captureCalls), 0);
    assert.equal(f.requests.some(item => item.path.endsWith('/connect')), false); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('closing during indexing aborts preparation without microphone access or a late connection', { timeout: 10000 }, async () => {
  const f = await fixture({ holdPreparation: true });
  try {
    await f.page.click('#start');
    for (let n = 0; n < 100 && !f.requests.some(item => item.path.endsWith('/calls')); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.requests.filter(item => item.path.endsWith('/calls')).length, 1);
    await f.page.evaluate(() => window.controller.end());
    for (let n = 0; n < 100 && !f.preparationAborted; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.preparationAborted, true); f.releasePreparation();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await f.page.evaluate(() => window.state.phase), 'ended');
    assert.equal(await f.page.evaluate(() => window.captureCalls), 0);
    assert.equal(f.requests.some(item => item.path.endsWith('/connect')), false); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a tab hidden during indexing must be started again explicitly, without microphone capture', { timeout: 10000 }, async () => {
  const f = await fixture({ holdPreparation: true });
  try {
    await f.page.click('#start');
    for (let n = 0; n < 100 && !f.requests.some(item => item.path.endsWith('/calls')); n++) await new Promise(resolve => setTimeout(resolve, 10));
    await f.page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }));
    f.releasePreparation(); await f.page.waitForFunction(() => window.state?.phase === 'ended');
    assert.match(await f.page.evaluate(() => window.state.error), /Return to this page/);
    assert.equal(await f.page.evaluate(() => window.captureCalls), 0);
    for (let n = 0; n < 100 && !f.requests.some(item => item.path.endsWith('/end')); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.requests.filter(item => item.path.endsWith('/end')).length, 1);
    assert.equal(f.requests.some(item => item.path.endsWith('/connect')), false); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('hanging up during microphone permission closes the prepared reservation and stops the late track', { timeout: 10000 }, async () => {
  const f = await fixture({ lateMic: true });
  try {
    await f.page.click('#start'); await f.page.waitForFunction(() => window.releaseMic);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(f.requests.filter(item => item.path.endsWith('/events')).length >= 2, 'polling maintains the prepared-call lease during permission');
    await f.page.evaluate(() => window.controller.end()); await f.page.evaluate(() => window.releaseMic());
    await f.page.waitForFunction(() => window.tracks.length === 1 && window.tracks[0].readyState === 'ended');
    assert.equal(f.requests.filter(item => item.path.endsWith('/calls')).length, 1);
    assert.equal(f.requests.filter(item => item.path.endsWith('/end')).length, 1);
    assert.equal(f.requests.some(item => item.path.endsWith('/connect')), false); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('hang-up aborts negotiation, ignores late SDP, and never restarts microphone capture after reload', { timeout: 10000 }, async () => {
  const f = await fixture({ slowOffer: true });
  try {
    await f.page.click('#start');
    while (!f.requests.some(item => item.path.endsWith('/connect'))) await new Promise(resolve => setTimeout(resolve, 20));
    await f.page.evaluate(() => window.controller.end()); await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await f.page.evaluate(() => window.state.phase), 'ended'); assert.equal(await f.page.evaluate(() => window.tracks[0].readyState), 'ended');
    const calls = f.requests.filter(item => item.path.endsWith('/calls')).length;
    await f.page.reload(); await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.requests.filter(item => item.path.endsWith('/calls')).length, calls); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('microphone denial still permits typed live replies and complete output cleanup', { timeout: 15000 }, async () => {
  const f = await fixture({ denied: true });
  try {
    await f.page.click('#start'); await f.page.waitForFunction(() => window.state?.phase === 'listening');
    assert.equal(await f.page.evaluate(() => window.state.muted), true);
    await f.page.evaluate(() => window.controller.sendText('Typed question'));
    await f.page.evaluate(() => { window.remote.volume.gain.value = 0.15; });
    await f.page.waitForFunction(() => window.cue?.level() > 0.1);
    await f.page.evaluate(() => window.controller.end()); assert.equal(await f.page.evaluate(() => window.cue), null);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
