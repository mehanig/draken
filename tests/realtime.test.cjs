const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function rpcFixture() {
  const { NativeRpc } = await import('../voice/realtime/rpc.mjs');
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.writes = []; child.kills = [];
  child.stdin = new Writable({ write(data, _, done) { child.writes.push(JSON.parse(data.toString())); done(); } });
  child.exitCode = null; child.signalCode = null;
  child.kill = signal => { child.kills.push(signal); child.signalCode = signal; setImmediate(() => child.emit('close')); };
  const rpc = new NativeRpc('fake-native', [], { spawnProcess: (_, __, options) => { assert.equal(options.shell, false); return child; } });
  return { rpc, child, send: event => child.stdout.write(JSON.stringify(event) + '\n') };
}
test('native RPC handles interleaved notifications, split Unicode and correlated responses', async () => {
  const f = await rpcFixture(), events = []; f.rpc.subscribe(event => events.push(event));
  const one = f.rpc.request('initialize'), two = f.rpc.request('account/read');
  const event = Buffer.from(JSON.stringify({ method: 'test', params: { text: '日\u2028本' } }) + '\n');
  for (const byte of event) f.child.stdout.write(Buffer.from([byte]));
  f.send({ id: 2, result: { second: true } }); f.send({ id: 1, result: { first: true } });
  assert.deepEqual(await one, { first: true }); assert.deepEqual(await two, { second: true });
  assert.equal(events[0].params.text, '日\u2028本'); f.rpc.close();
});
test('native RPC never forwards rejected payloads or stderr into errors', async () => {
  const f = await rpcFixture(), pending = f.rpc.request('test');
  f.child.stderr.write('private-token-and-question');
  f.send({ id: 1, error: { message: 'private-token-and-question' } });
  await assert.rejects(pending, error => /rejected/.test(error.message) && !/private/.test(error.message)); f.rpc.close();
});
test('native RPC denies server-initiated execution and approvals and closes all pending work', async () => {
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/call', 'unknown/request']) {
    const f = await rpcFixture(), pending = f.rpc.request('waiting');
    f.send({ id: 'server-request', method, params: { command: 'never execute me' } });
    await assert.rejects(pending, /unsupported operation/);
    assert.equal(f.rpc.closed, true); assert.equal(f.child.writes.at(-1).error.code, -32601);
    assert.deepEqual(f.child.kills, ['SIGTERM']);
  }
});
test('native RPC abort, timeout, malformed framing and size limits fail closed', async () => {
  for (const kind of ['abort', 'timeout', 'malformed', 'oversized', 'exit']) {
    const f = await rpcFixture(), abort = new AbortController();
    const pending = f.rpc.request('test', {}, { signal: abort.signal, timeoutMs: kind === 'timeout' ? 15 : 1000 });
    if (kind === 'abort') abort.abort();
    if (kind === 'malformed') f.child.stdout.write('{not json}\n');
    if (kind === 'oversized') f.child.stdout.write('x'.repeat(1_000_001));
    if (kind === 'exit') { f.child.exitCode = 1; f.child.emit('close'); }
    await assert.rejects(pending); assert.equal(f.rpc.closed, true); f.rpc.close();
  }
});
test('native RPC bounds concurrent requests and rejects late responses after shutdown', async () => {
  const f = await rpcFixture(); const requests = Array.from({ length: 16 }, () => f.rpc.request('test'));
  const all = Promise.allSettled(requests); await assert.rejects(f.rpc.request('seventeenth'), /Too many/);
  f.rpc.close(); f.send({ id: 1, result: 'late' });
  assert.ok((await all).every(result => result.status === 'rejected')); await assert.rejects(f.rpc.request('after-close'));
});
test('native helper environment has no inherited key, provider, proxy or pi ownership fallback', async () => {
  const { helperEnvironment, helperArguments } = await import('../voice/realtime/native.mjs');
  const env = helperEnvironment('/isolated', { PATH: '/bin', LANG: 'en', OPENAI_API_KEY: 'not-a-key', CODEX_API_KEY: 'not-a-key', PI_SESSION_ID: 'private', HTTPS_PROXY: 'http://bad', NODE_OPTIONS: '--bad', HOME: '/private' });
  assert.deepEqual(env, { HOME: '/isolated', USERPROFILE: '/isolated', APPDATA: path.join('/isolated', 'AppData', 'Roaming'), LOCALAPPDATA: path.join('/isolated', 'AppData', 'Local'), CODEX_HOME: '/isolated', RUST_LOG: 'off', PATH: '/bin', LANG: 'en' });
  const args = helperArguments('http://127.0.0.1:9/v1');
  assert.ok(args.includes('forced_login_method="chatgpt"')); assert.ok(args.includes('model_provider="draken_readonly"'));
  assert.ok(args.includes('model_providers.draken_readonly.base_url="http://127.0.0.1:9/v1"'));
  assert.ok(args.includes('features.shell_tool=false')); assert.ok(args.includes('features.code_mode=false'));
  assert.ok(args.includes('experimental_realtime_webrtc_call_base_url="https://chatgpt.com/backend-api/codex"'));
  assert.ok(!args.some(arg => /api_key=|--dangerously|--yolo/.test(arg)));
});
test('native login check does not mistake pi direct tokens or API keys for native sign-in', async () => {
  const { hasNativeLogin, NativeVoice } = await import('../voice/realtime/native.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-native-auth-test-'));
  try {
    for (const value of [{}, { openai: { type: 'oauth', access: 'synthetic' } }, { auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic' }, { tokens: { access_token: 'synthetic' } }]) {
      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(value)); assert.equal(hasNativeLogin(home), false);
    }
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic', refresh_token: 'synthetic', id_token: 'synthetic' } }));
    assert.equal(hasNativeLogin(home), true);
    // Validate input before touching an installed helper or any credentials.
    for (const sdp of ['not-sdp', 'v=0\r\nm=audio 9 x\r\nm=audio 9 x', 'v=0\r\nm=audio 9 x\r\nm=video 9 x']) {
      const voice = new NativeVoice({ home, binary: '/no-helper' }); await assert.rejects(voice.open(sdp), /One audio track/); await voice.close();
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

async function labFixture(options = {}) {
  const { createProbeServer } = await import('../voice/realtime/probe-server.mjs');
  const state = { opens: 0, closes: 0, texts: [] };
  const fake = { subscribe(fn) { state.emit = fn; }, async open(sdp) { state.opens++; state.sdp = sdp; return 'v=0\r\nm=audio 9 test'; }, async text(text) { state.texts.push(text); }, async close() { state.closes++; } };
  const lab = await createProbeServer({ voiceFactory: () => { state.constructed = true; return fake; }, ...options });
  const request = (url, options = {}) => fetch(lab.origin + url, { ...options, headers: { Authorization: `Bearer ${lab.token}`, ...options.headers } });
  return { lab, request, state };
}
test('private probe requires header authentication, expected Host and same origin; assets never expose keys', async () => {
  const { lab, request, state } = await labFixture();
  try {
    assert.equal((await fetch(lab.origin + '/?token=' + lab.token)).status, 401);
    assert.equal((await request('/call', { method: 'POST', headers: { Origin: 'https://other.example' }, body: 'v=0' })).status, 403);
    const wrongHost = await new Promise(resolve => {
      http.get(lab.origin, { headers: { Authorization: `Bearer ${lab.token}`, Host: 'other.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    });
    assert.equal(wrongHost, 403);
    assert.equal(state.opens, 0);
    const html = await (await request('/')).text(); assert.match(html, /Synthetic audio only/); assert.ok(!html.includes(lab.token));
    const wav = Buffer.from(await (await request('/question.wav')).arrayBuffer()); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal((await request('/../auth.json')).status, 404);
  } finally { await lab.close(); }
});
test('probe retains only bounded synthetic transcripts and never forwards SDP or native diagnostics', async () => {
  const { lab, request, state } = await labFixture();
  try {
    assert.equal((await request('/call', { method: 'POST', body: 'v=0' })).status, 200);
    assert.equal((await request('/call', { method: 'POST', body: 'v=0' })).status, 409);
    state.emit({ method: 'thread/realtime/sdp', params: { sdp: 'private-sdp' } });
    state.emit({ method: 'thread/realtime/transcript/done', params: { role: 'assistant', text: 'synthetic response', private: 'not-forwarded' } });
    const text = JSON.stringify(await (await request('/events')).json()); assert.match(text, /synthetic response/); assert.doesNotMatch(text, /private/);
    await request('/text', { method: 'POST', body: JSON.stringify({ question: 'Unicode 日\u2028本' }) }); assert.equal(state.texts[0], 'Unicode 日\u2028本');
    state.emit({ method: 'thread/realtime/error', params: { message: 'private-token' } });
    await delay(10); assert.equal(state.closes, 1);
    assert.doesNotMatch(JSON.stringify(await (await request('/events')).json()), /private-token/);
    await request('/end', { method: 'POST' }); assert.equal(state.closes, 1);
  } finally { await lab.close(); }
});
test('hang-up while an offer body is arriving cannot start a late call', async () => {
  const { lab, request, state } = await labFixture();
  try {
    const pending = new Promise(resolve => {
      const req = http.request(lab.origin + '/call', { method: 'POST', headers: { Authorization: `Bearer ${lab.token}`, 'Content-Length': 6 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.write('v=');
      setTimeout(async () => { await request('/end', { method: 'POST' }); req.end('0\r\n!'); }, 20);
    });
    assert.equal(await pending, 502); assert.equal(state.constructed, undefined); assert.equal(state.opens, 0);
  } finally { await lab.close(); }
});
test('probe disconnect lease and absolute lifetime stop helper resources', async () => {
  for (const options of [{ leaseMs: 25, lifetimeMs: 1000 }, { leaseMs: 1000, lifetimeMs: 25 }]) {
    const { lab, request, state } = await labFixture(options);
    try { await request('/call', { method: 'POST', body: 'v=0' }); await delay(85); assert.equal(state.closes, 1); }
    finally { await lab.close(); }
  }
});

test('native adapter preserves ordering, rejects API auth/provider drift, and tears down on handoff or abort', async () => {
  const { NativeVoice } = await import('../voice/realtime/native.mjs');
  for (const scenario of ['normal', 'api-key', 'provider-drift', 'reject', 'handoff', 'slow']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-native-fixture-'));
    fs.writeFileSync(path.join(home, 'scenario.txt'), scenario);
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic', id_token: 'synthetic', refresh_token: 'synthetic' } }));
    const voice = new NativeVoice({ home, binary: path.join(__dirname, 'fixtures/fake-codex.cjs') });
    const controller = new AbortController(); const events = []; voice.subscribe(event => events.push(event));
    let timer;
    try {
      const pending = voice.open('v=0\r\nm=audio 9 test', { signal: controller.signal,
        onReady: () => {
          if (scenario !== 'slow') return;
          // Wait for the synthetic pending request, not a 30ms process-start
          // guess that can abort before the fixture creates its files under load.
          const deadline = Date.now() + 5000;
          const abortPending = () => {
            let pendingRequest = false;
            try { pendingRequest = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').includes('"method":"thread/realtime/start"'); } catch {}
            if (pendingRequest || Date.now() >= deadline) controller.abort();
            else timer = setTimeout(abortPending, 10);
          };
          timer = setTimeout(abortPending, 10);
        } });
      if (scenario === 'normal') {
        assert.match(await pending, /^v=0/); await voice.text('Synthetic question');
        await voice.context('日'.repeat(2300));
        await assert.rejects(voice.context('日'.repeat(2731)), /Cannot supply/);
        await voice.continueAnswer('日'.repeat(2000));
        await assert.rejects(voice.continueAnswer('x'.repeat(2001)), /Cannot continue/);
        const wire = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        const continuation = wire.find(x => x.method === 'thread/realtime/appendSpeech');
        assert.ok(Buffer.byteLength(continuation.params.text) <= 4096);
        assert.equal(continuation.params.role, undefined, 'continuation is not a fabricated user turn');
        await assert.rejects(voice.open('v=0\r\nm=audio 9 test'), /only once/);
      } else await assert.rejects(pending, error => !error.message.includes('do-not-leak'));
      await voice.close();
      await assert.rejects(voice.continueAnswer('Late question'), /Cannot continue/);
      const requests = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.ok(!requests.some(request => /approval|exec|turn\/start/.test(request.method)));
      if (scenario === 'slow') assert.ok(requests.some(request => request.method === 'thread/realtime/start'), 'abort exercises a pending native request');
      if (['api-key', 'provider-drift'].includes(scenario)) assert.ok(!requests.some(request => request.method === 'thread/realtime/start'));
      if (scenario === 'handoff') assert.ok(events.some(event => event.method === 'draken/blocked'));
      assert.ok(events.some(event => event.method === 'draken/closed' && event.params.helperExited === true));
      const pid = Number(fs.readFileSync(path.join(home, 'pid'))); assert.throws(() => process.kill(pid, 0), /ESRCH/);
    } finally { clearTimeout(timer); await voice.close(); fs.rmSync(home, { recursive: true, force: true }); }
  }
});
