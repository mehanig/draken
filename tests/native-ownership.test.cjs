const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
after(async () => { const { stopNativeChecks } = await import('../voice/realtime/native.mjs'); await stopNativeChecks(); });

test('Unix launcher exit does not confirm surviving descendants or cancel escalation', { skip: process.platform === 'win32', timeout: 12000 }, async () => {
  const { NativeRpc } = await import('../voice/realtime/rpc.mjs');
  const descendant = "process.on('SIGTERM',()=>{});process.send('ready');process.disconnect();setInterval(()=>{},1000);";
  const launcher = `const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>process.exit(0));
    const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',()=>process.stdout.write(JSON.stringify({method:'ready',params:{pid:child.pid}})+'\\n'));`;
  let child, timer;
  const rpc = new NativeRpc(process.execPath, ['-e', launcher], { spawnProcess: (...args) => (child = spawn(...args)) });
  const closed = new Promise(resolve => child.once('close', resolve));
  const exists = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  try {
    const pid = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('Synthetic descendant did not start')), 5000);
      rpc.subscribe(event => { if (event.method === 'ready') { clearTimeout(timer); resolve(event.params.pid); } });
    });
    rpc.close(); await closed;
    assert.equal(exists(pid), true, 'descendant outlives the launcher with independent stdio');
    assert.equal(await rpc.waitForExit(200), false, 'launcher closure alone cannot release ownership');
    const confirmed = await rpc.waitForExit(4000);
    // Some container init processes retain orphan zombies. They cannot run, but
    // an extant process group must still produce an unconfirmed result.
    if (exists(pid)) {
      assert.equal(process.platform, 'linux');
      assert.match(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), /^\d+ \(.+\) Z /, 'SIGKILL escalation must stop the descendant');
    }
    assert.equal(confirmed, !exists(-child.pid), 'confirmation describes the group, not launcher stdio');
  } finally {
    clearTimeout(timer); rpc.close();
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await closed;
  }
});

test('closing or aborting native preflight waits for its ignoring version process, and terminal shutdown closes check admission', { timeout: 15000 }, async () => {
  const { NativeVoice } = await import('../voice/realtime/native.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-native-preflight-'));
  const binary = path.join(root, 'native-version'), pidFile = path.join(root, 'version.pid');
  fs.writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');process.on('SIGTERM',()=>{});fs.writeFileSync(path.join(process.env.CODEX_HOME,'version.pid'),String(process.pid));setInterval(()=>{},1000);`);
  fs.chmodSync(binary, 0o700);
  try {
    for (const mode of ['close', 'abort']) {
      const voice = new NativeVoice({ binary, home: root }), controller = new AbortController();
      const opening = voice.open('v=0\r\nm=audio 9 test', { signal: controller.signal }).then(() => null, error => error);
      let pid;
      try {
        for (let i = 0; i < 250 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(fs.existsSync(pidFile), true); pid = Number(fs.readFileSync(pidFile, 'utf8'));
        process.kill(pid, 0);
        if (mode === 'abort') controller.abort();
        let finished = false;
        const closing = voice.close().then(value => { finished = true; return value; });
        await Promise.resolve(); assert.equal(finished, false, 'preflight is an owned resource, not an absent RPC helper');
        assert.deepEqual(await closing, { helperExited: true });
        assert.match((await opening)?.message || '', /setup cancelled/);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      } finally {
        await voice.close(); await opening;
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        fs.rmSync(pidFile, { force: true });
      }
    }
    const child = spawnSync(process.execPath, ['-e', `
      (async()=>{
        const assert=require('node:assert/strict'),fs=require('node:fs');
        const {nativeStatus,stopNativeChecks}=await import('./voice/realtime/native.mjs');
        await stopNativeChecks();
        assert.equal((await nativeStatus({binary:${JSON.stringify(binary)},home:${JSON.stringify(root)}})).installed,false);
        assert.equal(fs.existsSync(${JSON.stringify(pidFile)}),false,'terminal shutdown must not launch another check');
        console.log('CHECKS_STOPPED');
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), 'CHECKS_STOPPED');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unconfirmed native cleanup retains the call lease and refuses replacement calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-unconfirmed-'));
  try {
    const result = spawnSync(process.execPath, ['-e', `
      const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
      require('./tests/fixtures/fake-memory.cjs');
      const {getDb,closeDb}=require('./dist/db/schema');
      const {activity}=require('./dist/sync/activity');
      const live=require('./dist/voice/live');
      (async()=>{
        fs.mkdirSync(process.env.DRAKEN_CODEX_HOME);
        fs.writeFileSync(path.join(process.env.DRAKEN_CODEX_HOME,'scenario.txt'),'conversation');
        fs.writeFileSync(path.join(process.env.DRAKEN_CODEX_HOME,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic',refresh_token:'synthetic',id_token:'synthetic'}}));
        const at=new Date().toISOString();
        const id=Number(getDb().prepare("INSERT INTO syncs(created_at,snapshot_at,snapshot_version,briefing,compression_complete) VALUES(?,?,2,'Synthetic ready briefing',1)").run(at,at).lastInsertRowid);
        const call=await live.createLiveCall(id,new AbortController().signal);
        await live.connectLiveCall(call.id,'v=0\\r\\nm=audio 9 test',new AbortController().signal);
        const {NativeVoice}=await import('./voice/realtime/native.mjs');
        const close=NativeVoice.prototype.close;
        NativeVoice.prototype.close=async function(){await close.call(this);return {helperExited:false};};
        await assert.rejects(live.endLiveCall(call.id),/exit could not be confirmed/);
        assert.equal(activity.callActive,true);
        await assert.rejects(live.createLiveCall(id,new AbortController().signal),/End the existing call/);
        assert.equal((await live.liveStatus()).state,'cleanup_pending');
        await assert.rejects(live.stopLiveCalls(),/cleanup remains unconfirmed/);
        assert.equal(activity.callActive,true,'server-wide shutdown must not discard an unconfirmed lease');
      })().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await live.stopLiveCalls().catch(()=>{});closeDb();}).then(()=>{if(!process.exitCode)console.log('UNCONFIRMED_OWNERSHIP_CHECKED');});
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, DRAKEN_DATA_DIR: root, DRAKEN_CODEX_HOME: path.join(root, 'account'),
      DRAKEN_CODEX_BIN: path.join(__dirname, 'fixtures/fake-codex.cjs'), DRAKEN_VOICE_MODE: 'native' }, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'UNCONFIRMED_OWNERSHIP_CHECKED', 'all assertions and awaited cleanup must finish');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
