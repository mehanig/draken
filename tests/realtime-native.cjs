// Optional REAL pinned-helper compatibility checks. Unusable synthetic API auth,
// loopback-only backing endpoints, no user credentials or provider requests.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
(async () => {
  const { NativeRpc } = await import('../voice/realtime/rpc.mjs');
  const { createReadOnlyBackend } = await import('../voice/realtime/backend.mjs');
  const { defaultBinary, helperArguments, helperEnvironment, nativeStatus } = await import('../voice/realtime/native.mjs');
  for (const mode of ['deny', 'text']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-native-compat-')); let rpc, server, backend, timer;
    const requests = [], executed = []; let attempts = 0;
    try {
      assert.ok((await nativeStatus({ home })).installed, 'Install the pinned helper to run this optional test.');
      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'draken-synthetic-unusable-key' }), { mode: 0o600 });
      let url;
      if (mode === 'deny') {
        server = http.createServer((req, res) => {
          requests.push({ path: req.url, method: req.method }); req.resume();
          res.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ error: { type: 'permission_error', code: 'draken_voice_read_only', message: 'No backing inference or execution allowed.' } }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${server.address().port}/v1`;
      } else {
        backend = await createReadOnlyBackend({ authorize: headers => headers.authorization === 'Bearer draken-synthetic-unusable-key', answer: async () => {
          attempts++;
          return JSON.stringify({ type: 'function_call', name: 'exec_command', arguments: { cmd: `touch ${path.join(home, 'must-not-exist')}` } });
        } }); url = backend.url;
      }
      const args = helperArguments(url);
      // TEST ONLY: NativeVoice never permits API auth or this override.
      args[args.indexOf('forced_login_method="chatgpt"')] = 'forced_login_method="api"';
      rpc = new NativeRpc(defaultBinary, args, { cwd: home, env: helperEnvironment(home) });
      await rpc.request('initialize', { clientInfo: { name: 'draken', version: '0.1.0' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
      const thread = await rpc.request('thread/start', { ephemeral: true, cwd: home, environments: [], dynamicTools: [], baseInstructions: 'Synthetic compatibility check. No tools or work.', model: 'gpt-5.4', modelProvider: 'draken_readonly', approvalPolicy: 'on-request', sandbox: 'read-only' });
      assert.equal(thread.modelProvider, 'draken_readonly'); assert.equal(thread.sandbox.type, 'readOnly');
      const completed = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Native helper compatibility check timed out.')), 12000);
        rpc.subscribe(event => {
          if (event.method === 'turn/completed') resolve(event.params.turn);
          if (event.method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(event.params?.item?.type)) executed.push(event.params.item.type);
        });
      });
      await rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Synthetic hello. Do not use tools.' }] });
      const turn = await completed; clearTimeout(timer);
      assert.equal(turn.status, mode === 'deny' ? 'failed' : 'completed'); assert.deepEqual(executed, []); assert.equal(fs.existsSync(path.join(home, 'must-not-exist')), false);
      if (mode === 'deny') { assert.equal(requests.length, 1); assert.deepEqual(requests[0], { method: 'POST', path: '/v1/responses' }); }
      else assert.equal(attempts, 1);
      console.log(JSON.stringify({ realHelper: true, realCredentialsUsed: false, pinnedConfigurationAccepted: true, backingEndpoint: mode === 'deny' ? 'loopback-deny-only' : 'loopback-text-only', backingAttempts: mode === 'deny' ? requests.length : attempts, executedTools: executed.length, turnStatus: turn.status }));
    } finally {
      clearTimeout(timer); rpc?.close(); if (rpc) assert.ok(await rpc.waitForExit(), 'Native helper must exit');
      await backend?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
