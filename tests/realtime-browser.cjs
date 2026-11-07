// Actual browser-to-browser WebRTC audio; no microphone, account, model or database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
let browser, lab;
before(async () => {
  const { createProbeServer } = await import('../voice/realtime/probe-server.mjs');
  lab = await createProbeServer({ voiceFactory: () => { throw new Error('A browser-only test must not start a provider.'); } });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await lab?.close(); });
async function pageForTest() {
  const context = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${lab.token}` } });
  await context.route('**/*', route => new URL(route.request().url()).origin === lab.origin ? route.continue() : route.abort());
  const page = await context.newPage(); await page.goto(lab.origin); return { context, page };
}
test('persistent media peer receives real audio, mutes, replaces input and releases all tracks', { timeout: 25_000 }, async () => {
  const { context, page } = await pageForTest();
  try {
    await page.evaluate(() => { document.querySelector('#start').onclick = async () => {
      const { VoicePeer } = await import('/peer.mjs');
      const ctx = new AudioContext(), remote = new RTCPeerConnection();
      let peer; const report = window.mediaTest = { finished: false, errors: [], closeCount: 0 };
      const wait = async fn => { const end = performance.now() + 12_000; while (!fn()) { if (performance.now() > end) throw Error('Local media timed out'); await new Promise(r => setTimeout(r, 20)); } };
      const outgoing = ctx.createMediaStreamDestination(), incoming = ctx.createMediaStreamDestination();
      try {
        await ctx.resume();
        const tone = ctx.createOscillator(), gain = ctx.createGain(); gain.gain.value = 0.1; tone.connect(gain); gain.connect(incoming); tone.start();
        remote.addTrack(incoming.stream.getAudioTracks()[0], incoming.stream);
        remote.ondatachannel = event => { event.channel.onopen = () => event.channel.send(JSON.stringify({ type: 'synthetic.connected' })); };
        peer = new VoicePeer({ onClose: () => report.closeCount++, onEvent: event => report.eventType = event.type });
        await peer.open(outgoing.stream, async offer => {
          report.audioMLines = (offer.match(/^m=audio /gm) || []).length;
          await remote.setRemoteDescription({ type: 'offer', sdp: offer });
          await remote.setLocalDescription(await remote.createAnswer());
          report.stage = 'ice-gathering';
          await wait(() => remote.iceGatheringState === 'complete'); report.stage = 'connecting'; return remote.localDescription.sdp;
        });
        report.stage = 'first-audio'; await wait(() => peer.level > 0.1); report.receivedLevel = peer.level;
        peer.muteOutput(true); report.mutedLevel = peer.level;
        peer.muteOutput(false); report.stage = 'unmuted-audio'; await wait(() => peer.level > 0.1);
        const original = outgoing.stream.getAudioTracks()[0]; peer.stopInput();
        report.originalStopped = original.readyState === 'ended' && !peer.inputActive;
        const replacement = ctx.createMediaStreamDestination(); await peer.replaceInput(replacement.stream);
        report.replaced = peer.inputActive;
        peer.close(); peer.close(); report.closedLevel = peer.level;
        report.replacementStopped = replacement.stream.getAudioTracks()[0].readyState === 'ended';
        const late = ctx.createMediaStreamDestination(); try { await peer.replaceInput(late.stream); } catch {}
        report.lateInputStopped = late.stream.getAudioTracks()[0].readyState === 'ended';
      } catch (error) { report.errors.push(`${error.message}: ${report.stage}; source ${ctx.state}; remote ${remote.connectionState}/${remote.iceGatheringState}; level ${peer?.level}`); }
      finally { peer?.close(); remote.close(); incoming.stream.getTracks().forEach(track => track.stop()); outgoing.stream.getTracks().forEach(track => track.stop()); await ctx.close(); report.finished = true; }
    }; });
    await page.click('#start'); await page.waitForFunction(() => window.mediaTest?.finished, {}, { timeout: 20_000 });
    const report = await page.evaluate(() => window.mediaTest);
    assert.deepEqual(report.errors, []); assert.equal(report.audioMLines, 1); assert.equal(report.eventType, 'synthetic.connected');
    assert.ok(report.receivedLevel > 0.1); assert.equal(report.mutedLevel, 0); assert.equal(report.closedLevel, 0);
    assert.ok(report.originalStopped && report.replaced && report.replacementStopped && report.lateInputStopped); assert.equal(report.closeCount, 1);
  } finally { await context.close(); }
});
test('hang-up during SDP negotiation aborts the request and rejects a late answer without reopening audio', { timeout: 10_000 }, async () => {
  const { context, page } = await pageForTest();
  try {
    await page.evaluate(() => { document.querySelector('#start').onclick = async () => {
      const { VoicePeer } = await import('/peer.mjs'); const ctx = new AudioContext(); await ctx.resume();
      const input = ctx.createMediaStreamDestination(); const report = window.cancelTest = { finished: false, closeCount: 0 };
      const peer = new VoicePeer({ onClose: () => report.closeCount++ });
      const pending = peer.open(input.stream, async (_, signal) => {
        peer.close(); report.aborted = signal.aborted; await new Promise(r => setTimeout(r, 50)); return 'v=0\r\nm=audio 9 deliberately-not-valid';
      });
      try { await pending; report.error = 'Unexpected success'; } catch (error) { report.error = error.message; }
      report.trackEnded = input.stream.getAudioTracks()[0].readyState === 'ended'; report.closed = peer.closed; report.level = peer.level;
      await ctx.close(); report.finished = true;
    }; });
    await page.click('#start'); await page.waitForFunction(() => window.cancelTest?.finished);
    const report = await page.evaluate(() => window.cancelTest);
    assert.ok(report.aborted && report.trackEnded && report.closed); assert.equal(report.level, 0); assert.equal(report.closeCount, 1); assert.match(report.error, /cancelled/);
  } finally { await context.close(); }
});
test('invalid negotiation and failing observers cannot prevent media cleanup', { timeout: 10_000 }, async () => {
  const { context, page } = await pageForTest();
  try {
    await page.evaluate(() => { document.querySelector('#start').onclick = async () => {
      const { VoicePeer } = await import('/peer.mjs'); const ctx = new AudioContext(); await ctx.resume();
      const input = ctx.createMediaStreamDestination(); const report = window.failureTest = { finished: false };
      const peer = new VoicePeer({ onClose: () => { throw Error('Presentation failure'); } });
      try { await peer.open(input.stream, async () => 'not-sdp'); } catch (error) { report.error = error.message; }
      report.trackEnded = input.stream.getAudioTracks()[0].readyState === 'ended'; report.closed = peer.closed;
      await ctx.close(); report.finished = true;
    }; });
    await page.click('#start'); await page.waitForFunction(() => window.failureTest?.finished);
    const report = await page.evaluate(() => window.failureTest); assert.ok(report.trackEnded && report.closed); assert.match(report.error, /Invalid voice answer/);
  } finally { await context.close(); }
});

test('complete qualification page runs two audio turns and confirms cleanup with a local simulated service', { timeout: 25_000 }, async () => {
  const { createProbeServer } = await import('../voice/realtime/probe-server.mjs');
  let remotePage, emit, providerCloses = 0, opens = 0;
  const isolated = await createProbeServer({ voiceFactory: () => ({
    subscribe(listener) { emit = listener; },
    async open(offer) {
      opens++;
      return remotePage.evaluate(async sdp => {
        const r = window.remoteFixture; await r.pc.setRemoteDescription({ type: 'offer', sdp });
        await r.pc.setLocalDescription(await r.pc.createAnswer());
        await new Promise(resolve => { if (r.pc.iceGatheringState === 'complete') resolve(); else r.pc.onicegatheringstatechange = () => { if (r.pc.iceGatheringState === 'complete') resolve(); }; });
        return r.pc.localDescription.sdp;
      }, offer);
    },
    async close() {
      providerCloses++;
      await remotePage.evaluate(async () => { const r = window.remoteFixture; clearInterval(r.timer); r.pc.close(); r.output.stream.getTracks().forEach(t => t.stop()); await r.ctx.close(); });
      return { helperExited: true };
    },
  }) });
  const context = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${isolated.token}` } });
  await context.route('**/*', route => new URL(route.request().url()).origin === isolated.origin ? route.continue() : route.abort());
  try {
    remotePage = await context.newPage(); await remotePage.goto(isolated.origin);
    await remotePage.exposeFunction('syntheticTranscript', role => emit({ method: 'thread/realtime/transcript/done', params: { role, text: role === 'user' ? 'Did the export tests pass?' : 'The export tests passed; deployment is not verified.' } }));
    await remotePage.evaluate(() => { document.querySelector('#start').onclick = async () => {
      const ctx = new AudioContext(); await ctx.resume(); const pc = new RTCPeerConnection(), output = ctx.createMediaStreamDestination();
      const r = window.remoteFixture = { ctx, pc, output, ready: false, heardTurns: 0 };
      const tone = ctx.createOscillator(), volume = ctx.createGain(); volume.gain.value = 0; tone.connect(volume); volume.connect(output); tone.start(); pc.addTrack(output.stream.getAudioTracks()[0], output.stream);
      pc.ondatachannel = () => {};
      pc.ontrack = event => {
        const stream = new MediaStream([event.track]); r.decoder = new Audio(); r.decoder.muted = true; r.decoder.srcObject = stream; void r.decoder.play();
        const input = ctx.createMediaStreamSource(stream), meter = ctx.createAnalyser(), silent = ctx.createGain(); silent.gain.value = 0; input.connect(meter); meter.connect(silent); silent.connect(ctx.destination);
        const samples = new Float32Array(1024); meter.fftSize = samples.length; let talking = false, last = 0;
        r.timer = setInterval(() => {
          meter.getFloatTimeDomainData(samples); const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
          if (rms > 0.01) { talking = true; last = performance.now(); }
          else if (talking && performance.now() - last > 500) {
            talking = false; r.heardTurns++; void window.syntheticTranscript('user'); volume.gain.value = 0.12;
            setTimeout(() => { volume.gain.value = 0; void window.syntheticTranscript('assistant'); }, 450);
          }
        }, 20);
      };
      r.ready = true;
    }; });
    await remotePage.click('#start'); await remotePage.waitForFunction(() => window.remoteFixture?.ready);
    const page = await context.newPage(); await page.goto(isolated.origin); await page.click('#start');
    await page.waitForFunction(() => window.voiceResult?.completed, {}, { timeout: 20_000 });
    const report = await page.evaluate(() => window.voiceResult);
    assert.deepEqual(report.errors, []); assert.ok(report.success && report.localCleanup && report.helperCleanup);
    assert.equal(opens, 1); assert.equal(providerCloses, 1); assert.equal(report.questions.length, 2); assert.ok(report.audioFrames > 10);
    assert.ok(report.questions.every(question => Number.isFinite(question.firstAudioAfterFixtureMs)));
    assert.equal(await remotePage.evaluate(() => window.remoteFixture.heardTurns), 2);
  } finally { await isolated.close(); await context.close(); }
});
