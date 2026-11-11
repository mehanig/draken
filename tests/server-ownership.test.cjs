const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), http = require('node:http'), https = require('node:https');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const repo = path.join(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => { const server = net.createServer().listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-owner-')), processes = [];
  const env = { ...process.env, HOME: root, DRAKEN_DATA_DIR: path.join(root, 'state'), DRAKEN_HOST: '127.0.0.1', DRAKEN_NO_AUTH: 'true',
    DRAKEN_HTTPS_PORT: '0', DRAKEN_PI_SESSIONS_DIR: path.join(root, 'sessions'), DRAKEN_CODEX_HOME: path.join(root, 'account'),
    DRAKEN_CODEX_BIN: path.join(__dirname, 'fixtures/fake-codex.cjs') };
  t.after(async () => {
    for (const item of processes) {
      if (item.child.exitCode !== null || item.child.signalCode !== null) continue;
      if (process.platform !== 'win32') item.child.kill('SIGCONT');
      for (const match of item.output().matchAll(/OWNED \w+ (\d+)/g)) { try { process.kill(Number(match[1]), 'SIGKILL'); } catch {} }
      await pause(100); item.child.kill('SIGKILL'); await item.closed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const launch = async (script = "require('./dist/server').startServer();", extra = {}) => {
    const configuration = { ...env, DRAKEN_PORT: String(await port()), ...extra };
    const child = spawn(process.execPath, ['-e', script], { cwd: repo, env: configuration, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
    const item = { child, env: configuration, closed: new Promise(resolve => child.once('close', resolve)), output: () => output,
      async waitFor(pattern) { for (let i = 0; i < 300; i++) { if (pattern.test(output)) return; if (child.exitCode !== null || child.signalCode !== null) break; await pause(20); } assert.match(output, pattern); } };
    processes.push(item); return item;
  };
  return { root, env, launch };
}

test('a suspended server cannot lose ownership to a stale clock; genuine process death permits recovery', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const f = await fixture(t), owner = await f.launch(); await owner.waitFor(/Draken sync running/);
  const record = path.join(f.env.DRAKEN_DATA_DIR, 'server-state.json'), before = fs.readFileSync(record);
  owner.child.kill('SIGSTOP');
  const contender = await f.launch("const now=Date.now;Date.now=()=>now()+60000;require('./dist/server').startServer();");
  assert.equal(await contender.closed, 1, contender.output()); assert.match(contender.output(), /owns this data directory/);
  assert.deepEqual(fs.readFileSync(record), before);
  assert.equal(owner.child.exitCode, null);
  owner.child.kill('SIGKILL'); await owner.closed;
  const replacement = await f.launch(); await replacement.waitFor(/Draken sync running/);
  assert.notEqual(fs.readFileSync(record, 'utf8'), before.toString());
  replacement.child.kill('SIGTERM'); assert.equal(await replacement.closed, 0, replacement.output());
});

test('server shutdown awaits history and model escalation before allowing another directory owner', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const worker = path.join(f.root, 'worker.cjs'), model = path.join(f.root, 'pi');
  fs.writeFileSync(worker, "process.on('SIGTERM',()=>{});process.send({syntheticReady:true});process.on('message',()=>{});setInterval(()=>{},1000);");
  fs.writeFileSync(model, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});process.stdout.write('SYNTHETIC_READY\\n');process.stdin.resume();setInterval(()=>{},1000);`); fs.chmodSync(model, 0o700);
  const owner = await f.launch(`
    const processes=require('node:child_process'),fork=processes.fork,spawn=processes.spawn;
    let released=false;const pending=[];
    process.on('message',message=>{if(message.releaseKills){released=true;for(const kill of pending.splice(0))kill();}});
    const hold=child=>{const kill=child.kill.bind(child);child.kill=signal=>{if(signal==='SIGKILL'&&!released){pending.push(()=>kill(signal));return true;}return kill(signal);};return child;};
    processes.fork=(file,args,options)=>{const child=hold(fork(${JSON.stringify(worker)},[],options));child.on('message',value=>{if(value.syntheticReady)console.log('OWNED history '+child.pid);});return child;};
    processes.spawn=(...args)=>{const child=hold(spawn(...args));child.stdout?.on('data',value=>{if(value.toString().includes('SYNTHETIC_READY'))console.log('OWNED model '+child.pid);});return child;};
    require('./dist/server').startServer();
    setTimeout(()=>{void require('./dist/memory/service').searchHistory({question:'Synthetic history'}).catch(()=>{});void require('./dist/sync/pi').invokePi('synthetic',{system:'synthetic',model:'test/only'}).catch(()=>{});},100);
  `, { DRAKEN_PI_BIN: model });
  await owner.waitFor(/OWNED history \d+/); await owner.waitFor(/OWNED model \d+/);
  owner.child.kill('SIGTERM');
  const contender = await f.launch(); assert.equal(await contender.closed, 1, contender.output());
  assert.match(contender.output(), /owns this data directory/);
  owner.child.send({ releaseKills: true });
  assert.equal(await owner.closed, 0, owner.output());
  for (const match of owner.output().matchAll(/OWNED \w+ (\d+)/g)) assert.throws(() => process.kill(Number(match[1]), 0), { code: 'ESRCH' });
  const replacement = await f.launch(); await replacement.waitFor(/Draken sync running/);
  replacement.child.kill('SIGTERM'); assert.equal(await replacement.closed, 0);
});

test('disconnected native status requests remain owned until version-helper exit is confirmed', { timeout: 15000 }, async t => {
  const f = await fixture(t), binary = path.join(f.root, 'native-version'), account = f.env.DRAKEN_CODEX_HOME;
  fs.mkdirSync(account);
  fs.writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');process.on('SIGTERM',()=>{});fs.writeFileSync(path.join(process.env.CODEX_HOME,'version.pid'),String(process.pid));setInterval(()=>{},1000);`);
  fs.chmodSync(binary, 0o700);
  const owner = await f.launch(`
    const live=require('./dist/voice/live'),stop=live.shutdownLiveVoice;
    let release;const gate=new Promise(resolve=>release=resolve);
    process.on('message',message=>{if(message.releaseChecks)release();});
    live.shutdownLiveVoice=async()=>{console.log('VERSION SHUTDOWN GATED');await gate;return stop();};
    require('./dist/server').startServer();
  `, { DRAKEN_CODEX_BIN: binary });
  await owner.waitFor(/Draken sync running/);
  const request = http.get(`http://127.0.0.1:${owner.env.DRAKEN_PORT}/api/voice/status`);
  request.on('error', () => {});
  const pidFile = path.join(account, 'version.pid');
  try {
    for (let i = 0; i < 250 && !fs.existsSync(pidFile); i++) await pause(20);
    assert.equal(fs.existsSync(pidFile), true, owner.output());
    const pid = Number(fs.readFileSync(pidFile, 'utf8')); process.kill(pid, 0);
    request.destroy(); owner.child.kill('SIGTERM'); await owner.waitFor(/VERSION SHUTDOWN GATED/);
    const contender = await f.launch(); assert.equal(await contender.closed, 1, contender.output());
    assert.match(contender.output(), /owns this data directory/);
    owner.child.send({ releaseChecks: true });
    assert.equal(await owner.closed, 0, owner.output());
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    const replacement = await f.launch(); await replacement.waitFor(/Draken sync running/);
    replacement.child.kill('SIGTERM'); assert.equal(await replacement.closed, 0);
  } finally {
    request.destroy();
    if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} }
  }
});

test('unconfirmed native shutdown retains the server process and excludes a replacement', { timeout: 15000 }, async t => {
  const f = await fixture(t), owner = await f.launch(`
    require('./dist/voice/live').shutdownLiveVoice=async()=>{throw Error('Synthetic unconfirmed native group');};
    require('./dist/server').startServer();
  `);
  await owner.waitFor(/Draken sync running/); owner.child.kill('SIGTERM');
  await owner.waitFor(/Shutdown is unconfirmed/);
  assert.equal(owner.child.exitCode, null);
  const contender = await f.launch(); assert.equal(await contender.closed, 1, contender.output());
  assert.match(contender.output(), /owns this data directory/);
});

test('invalid ownership storage fails closed before application database initialization', async t => {
  const f = await fixture(t); fs.mkdirSync(f.env.DRAKEN_DATA_DIR);
  fs.writeFileSync(path.join(f.env.DRAKEN_DATA_DIR, '.server-owner.sqlite'), 'not a SQLite ownership database');
  const owner = await f.launch(); assert.equal(await owner.closed, 1, owner.output());
  assert.match(owner.output(), /Cannot establish exclusive server ownership/);
  assert.equal(fs.existsSync(path.join(f.env.DRAKEN_DATA_DIR, 'draken.db')), false);
  assert.equal(fs.existsSync(path.join(f.env.DRAKEN_DATA_DIR, 'server-state.json')), false);
});

test('HTTPS requests drain before directory ownership is released', { skip: spawnSync('openssl', ['version']).status !== 0, timeout: 20000 }, async t => {
  const f = await fixture(t), tls = path.join(f.root, 'tls');
  execFileSync(process.execPath, ['voice/tls.mjs', '--host', '127.0.0.1'], { cwd: repo, env: { ...f.env, DRAKEN_TLS_DIR: tls }, stdio: 'ignore' });
  const securePort = await port();
  const owner = await f.launch(`
    require('./dist/memory/service').searchHistory=()=>new Promise(resolve=>{
      console.log('HELD HTTPS');process.once('message',()=>resolve({mode:'hybrid',results:[],limitations:'Synthetic drain'}));
    });require('./dist/server').startServer();
  `, { DRAKEN_HTTPS_PORT: String(securePort), DRAKEN_TLS_CERT: path.join(tls, 'draken-server.crt'), DRAKEN_TLS_KEY: path.join(tls, 'draken-server.key') });
  await owner.waitFor(/Draken sync running/);
  const response = new Promise((resolve, reject) => {
    const request = https.request({ hostname: '127.0.0.1', port: securePort, path: '/api/memory/search', method: 'POST',
      ca: fs.readFileSync(path.join(tls, 'draken-local-root.crt')), headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    request.on('error', reject); request.end(JSON.stringify({ question: 'Synthetic held source' }));
  });
  await owner.waitFor(/HELD HTTPS/); owner.child.kill('SIGTERM');
  const contender = await f.launch(); assert.equal(await contender.closed, 1, contender.output());
  assert.match(contender.output(), /owns this data directory/);
  assert.equal(owner.child.exitCode, null);
  owner.child.send({ release: true }); assert.equal(await response, 200);
  assert.equal(await owner.closed, 0, owner.output());
});
