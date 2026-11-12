// Optional REAL pinned-helper compatibility checks. Unusable synthetic API auth,
// loopback-only backing endpoints, no user credentials or provider requests.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
(async () => {
  const { NativeRpc } = await import('../voice/realtime/rpc.mjs');
  const { createReadOnlyBackend } = await import('../voice/realtime/backend.mjs');
  const { defaultBinary, helperArguments, helperEnvironment, nativeStatus, stopNativeChecks } = await import('../voice/realtime/native.mjs');
  const controller = new AbortController(), { signal } = controller;
  const hold = setInterval(() => {}, 1000);
  const cleanupErrors = [];
  let rpc, checksClosing;
  const stopChecks = () => {
    if (!checksClosing) { checksClosing = Promise.resolve().then(() => stopNativeChecks()); checksClosing.catch(() => {}); }
    return checksClosing;
  };
  const onSignal = name => {
    if (signal.aborted) return;
    process.exitCode = name === 'SIGINT' ? 130 : 143;
    controller.abort();
    try { rpc?.close(); } catch (error) { cleanupErrors.push(error); }
    void stopChecks();
  };
  const active = () => { if (signal.aborted) throw new Error('Native helper compatibility check cancelled.'); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    for (const mode of ['deny', 'text']) {
      active();
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-native-compat-'));
      let server, backend, timer, unsubscribe;
      const requests = [], executed = []; let attempts = 0;
      try {
        const status = await nativeStatus({ home, signal });
        active();
        assert.ok(status.installed, 'Install the pinned helper to run this optional test.');
        fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'draken-synthetic-unusable-key' }), { mode: 0o600 });
        let url;
        if (mode === 'deny') {
          server = http.createServer((req, res) => {
            requests.push({ path: req.url, method: req.method }); req.resume();
            res.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close' });
            res.end(JSON.stringify({ error: { type: 'permission_error', code: 'draken_voice_read_only', message: 'No backing inference or execution allowed.' } }));
          });
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
          active();
          url = `http://127.0.0.1:${server.address().port}/v1`;
        } else {
          backend = await createReadOnlyBackend({ authorize: headers => headers.authorization === 'Bearer draken-synthetic-unusable-key', answer: async () => {
            active();
            attempts++;
            return JSON.stringify({ type: 'function_call', name: 'exec_command', arguments: { cmd: `touch ${path.join(home, 'must-not-exist')}` } });
          } });
          active();
          url = backend.url;
        }
        const args = helperArguments(url);
        // TEST ONLY: NativeVoice never permits API auth or this override.
        args[args.indexOf('forced_login_method="chatgpt"')] = 'forced_login_method="api"';
        active();
        rpc = new NativeRpc(defaultBinary, args, { cwd: home, env: helperEnvironment(home) });
        await rpc.request('initialize', { clientInfo: { name: 'draken', version: '0.1.0' }, capabilities: { experimentalApi: true } }, { signal });
        active();
        rpc.notify('initialized');
        const thread = await rpc.request('thread/start', { ephemeral: true, cwd: home, environments: [], dynamicTools: [], baseInstructions: 'Synthetic compatibility check. No tools or work.', model: 'gpt-5.4', modelProvider: 'draken_readonly', approvalPolicy: 'on-request', sandbox: 'read-only' }, { signal });
        active();
        assert.equal(thread.modelProvider, 'draken_readonly'); assert.equal(thread.sandbox.type, 'readOnly');
        const completed = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Native helper compatibility check timed out.')), 12000);
          unsubscribe = rpc.subscribe(event => {
            if (event.method === 'draken/closed') reject(new Error('Native helper compatibility connection closed.'));
            if (event.method === 'turn/completed') resolve(event.params.turn);
            if (event.method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(event.params?.item?.type)) executed.push(event.params.item.type);
          });
        });
        const [turn] = await Promise.all([completed, rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Synthetic hello. Do not use tools.' }] }, { signal })]);
        active();
        clearTimeout(timer);
        assert.equal(turn.status, mode === 'deny' ? 'failed' : 'completed'); assert.deepEqual(executed, []); assert.equal(fs.existsSync(path.join(home, 'must-not-exist')), false);
        if (mode === 'deny') { assert.equal(requests.length, 1); assert.deepEqual(requests[0], { method: 'POST', path: '/v1/responses' }); }
        else assert.equal(attempts, 1);
        console.log(JSON.stringify({ realHelper: true, realCredentialsUsed: false, pinnedConfigurationAccepted: true, backingEndpoint: mode === 'deny' ? 'loopback-deny-only' : 'loopback-text-only', backingAttempts: mode === 'deny' ? requests.length : attempts, executedTools: executed.length, turnStatus: turn.status }));
      } finally {
        clearTimeout(timer);
        const warning = setTimeout(() => console.error('Native compatibility cleanup is still pending. Keeping this terminal host alive.'), 10_000);
        const results = await Promise.allSettled([
          Promise.resolve().then(() => unsubscribe?.()),
          Promise.resolve().then(() => rpc?.close()),
          Promise.resolve().then(async () => { if (rpc) assert.ok(await rpc.waitForExit(), 'Native helper exit could not be confirmed.'); }),
          Promise.resolve().then(() => backend?.close()),
          Promise.resolve().then(async () => {
            if (!server) return;
            try { server.closeAllConnections(); }
            finally { await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())); }
          }),
        ]);
        clearTimeout(warning);
        for (const result of results) if (result.status === 'rejected') cleanupErrors.push(result.reason);
        try { fs.rmSync(home, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
        if (cleanupErrors.length) throw new Error('Native compatibility resource cleanup failed.');
        rpc = undefined;
      }
    }
  } catch (error) {
    console.error(signal.aborted ? 'Native helper compatibility check cancelled.' : error.message);
    if (!signal.aborted) process.exitCode = 1;
  } finally {
    const warning = setTimeout(() => console.error('Native compatibility cleanup is still pending. Keeping this terminal host alive.'), 10_000);
    try { await stopChecks(); } catch (error) { cleanupErrors.push(error); }
    clearTimeout(warning);
    if (cleanupErrors.length) {
      process.exitCode = 1;
      console.error('Native compatibility cleanup could not be confirmed. Keeping this terminal host alive; no further operation will start.');
      await new Promise(() => {});
    }
    clearInterval(hold);
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
