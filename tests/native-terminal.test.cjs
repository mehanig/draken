const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { CODEX_VERSION } = require('../voice/realtime/native.mjs');

const root = path.join(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
async function bounded(promise, message, ms = 12000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
function environment(home) {
  const env = { HOME: home, USERPROFILE: home, DRAKEN_DATA_DIR: path.join(home, 'data'), PATH: path.dirname(process.execPath) };
  for (const name of ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  return env;
}

async function cancelExecutable(args, signal, mode = 'preflight') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-terminal-'));
  const account = path.join(home, '.draken', 'realtime', 'account');
  const binary = path.join(home, '.draken', 'realtime', 'runtime', 'node_modules', '.bin', 'codex');
  const ready = path.join(account, 'ready.pid'), calls = path.join(account, 'calls.jsonl');
  fs.mkdirSync(account, { recursive: true }); fs.mkdirSync(path.dirname(binary), { recursive: true });
  // No real credentials, provider, npm installation, or network. The helper is
  // found through the production default path, not DRAKEN_CODEX_BIN overrides.
  fs.writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
// Qualification supplies its own CODEX_HOME; markers belong to this fixture.
const account = ${JSON.stringify(account)}, args = process.argv.slice(2);
fs.appendFileSync(path.join(account, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (${JSON.stringify(mode)} === 'login-command' && args[0] === '--version') {
  process.stdout.write(${JSON.stringify(`codex-cli ${CODEX_VERSION}\n`)});
} else {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(path.join(account, 'ready.tmp'), String(process.pid));
  fs.renameSync(path.join(account, 'ready.tmp'), path.join(account, 'ready.pid'));
  setInterval(() => {}, 1000);
}
`, { mode: 0o700 });
  const child = spawn(process.execPath, args, { cwd: root, env: environment(home), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', pid, aliveAtHostExit, exitSeen = false;
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.once('exit', () => { exitSeen = true; aliveAtHostExit = pid ? exists(pid) : undefined; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, killedBy) => resolve({ code, killedBy }));
  });
  try {
    await bounded((async () => {
      while (!fs.existsSync(ready)) {
        assert.equal(exitSeen, false, `host exited before fixture readiness: ${output}`);
        await delay(20);
      }
    })(), 'default-path helper never announced readiness');
    pid = Number(fs.readFileSync(ready, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 1);
    assert.equal(exists(pid), true);
    assert.equal(child.kill(signal), true);
    const result = await bounded(completion, `host never completed cleanup: ${args.join(' ')}`);
    assert.equal(result.killedBy, null, output);
    assert.equal(result.code, signal === 'SIGINT' ? 130 : 143, output);
    assert.equal(aliveAtHostExit, false, `helper ${pid} survived host exit: ${output}`);
    assert.equal(exists(pid), false);
    const invocations = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (mode === 'login-command') {
      assert.equal(invocations.length, 2, 'cancelled login must not start another status check');
      assert.deepEqual(invocations[0], ['--version']);
      assert.ok(invocations[1].includes('login'));
    } else {
      assert.deepEqual(invocations, [['--version']], 'cancellation must not launch login, provider, or another check');
    }
    assert.equal(fs.existsSync(path.join(home, '.draken', 'realtime', 'reports')), false);
  } finally {
    // Failure cleanup is independent of the assertion under test.
    if (!pid && fs.existsSync(ready)) pid = Number(fs.readFileSync(ready, 'utf8'));
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    if (!exitSeen) child.kill('SIGKILL');
    await bounded(completion, 'test host failed to reap').catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const [label, args, signal] of [
  ['probe check', ['voice/realtime/probe.mjs', '--check'], 'SIGINT'],
  ['setup check', ['voice/realtime/setup.mjs', '--check'], 'SIGTERM'],
  ['CLI voice status', ['dist/cli.js', 'voice', 'status'], 'SIGTERM'],
  ['login preflight', ['voice/realtime/setup.mjs', '--login'], 'SIGINT'],
  ['provider preflight', ['voice/realtime/probe.mjs', '--allow-provider'], 'SIGTERM'],
  ['native compatibility preflight (interrupt)', ['tests/realtime-native.cjs'], 'SIGINT'],
  ['native compatibility preflight (terminate)', ['tests/realtime-native.cjs'], 'SIGTERM'],
]) {
  test(`${label} drains an ignoring default-path version helper before host completion`, { skip: process.platform === 'win32', timeout: 20000 }, async () => {
    await cancelExecutable(args, signal);
  });
}

test('explicit inherited-stdio login is owned until confirmed exit', { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  await cancelExecutable(['voice/realtime/setup.mjs', '--login'], 'SIGTERM', 'login-command');
});

test('CLI voice login still requires an interactive terminal before starting native checks', { timeout: 15000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-terminal-tty-'));
  try {
    const child = spawn(process.execPath, ['dist/cli.js', 'voice', 'login'], { cwd: root, env: environment(home), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    try {
      assert.equal(await bounded(completion, 'CLI login did not complete'), 1);
      assert.match(output, /Run draken voice login in an interactive terminal/);
      assert.equal(fs.existsSync(path.join(home, '.draken', 'realtime')), false);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await completion; }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Fixture modules expose explicit async creation gates. Production entry points
// still execute, but these tests cannot launch a provider, browser, or installer.
async function terminalFixture(entry, mode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-terminal-gates-'));
  const preload = path.join(home, 'preload.mjs');
  const native = `
    const f = globalThis.terminalFixture;
    export const CODEX_VERSION = 'synthetic', realtimeRoot = f.home, defaultHome = f.home, defaultBinary = 'never-launch';
    export const helperEnvironment = () => ({});
    export async function nativeStatus({ signal }) {
      if (!signal) throw new Error('Missing native check cancellation signal');
      signal.addEventListener('abort', () => f.mark('cancelled'), { once: true });
      if (f.mode === 'status') await f.gate('status');
      return { installed: true, readyForProbe: true };
    }
    export async function stopNativeChecks() {
      f.mark('checks-stopped');
      if (f.mode === 'unconfirmed') throw new Error('Synthetic unconfirmed helper');
    }
  `;
  const lab = `
    const f = globalThis.terminalFixture;
    export async function createProbeServer() {
      if (f.mode === 'lab') await f.gate('lab');
      f.mark('lab-created');
      return { token: 'synthetic', origin: 'http://127.0.0.1:1', close: async () => { f.mark('lab-closed'); } };
    }
  `;
  const browser = `
    const f = globalThis.terminalFixture;
    f.mark('browser-imported');
    export const chromium = { launch: async () => {
      f.mark('browser-launch');
      await f.gate('browser');
      return { close: async () => { f.mark('browser-closed'); }, newContext: async () => { f.mark('context-created'); throw new Error('Unexpected context creation'); } };
    } };
  `;
  const helper = `export class NativeHelperProcess { constructor() { globalThis.terminalFixture.mark('terminal-command'); throw new Error('Unexpected terminal command'); } }`;
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import path from 'node:path';
    import { registerHooks } from 'node:module';
    const home = process.env.HOME;
    const mark = name => fs.writeFileSync(path.join(home, name), 'complete');
    globalThis.terminalFixture = { home, mode: ${JSON.stringify(mode)}, mark,
      gate: async name => { mark(name + '-ready'); while (!fs.existsSync(path.join(home, name + '-release'))) await new Promise(resolve => setTimeout(resolve, 10)); },
    };
    process.on('message', message => { if (message === 'ping') process.send('HOST_RETAINED'); });
    process.channel.unref();
    const fixtures = ${JSON.stringify({ './native.mjs': native, './probe-server.mjs': lab, '@playwright/test': browser, './helper-process.mjs': helper })};
    registerHooks({ resolve(specifier, context, next) {
      if (/\\/(setup|probe)\\.mjs$/.test(context.parentURL || '') && Object.hasOwn(fixtures, specifier)) {
        return { url: 'data:text/javascript,' + encodeURIComponent(fixtures[specifier]), shortCircuit: true };
      }
      return next(specifier, context);
    } });
  `);
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, ...entry], {
    cwd: root, env: environment(home), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '', exited = false;
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.once('exit', () => { exited = true; });
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const wait = name => bounded((async () => {
    while (!fs.existsSync(path.join(home, name))) {
      assert.equal(exited, false, `fixture exited before ${name}: ${output}`);
      await delay(10);
    }
  })(), `fixture did not complete ${name}`);
  try {
    if (mode === 'unconfirmed') {
      await wait('checks-stopped');
      await bounded((async () => {
        while (!output.includes('Keeping this terminal host alive')) {
          assert.equal(exited, false, output); await delay(10);
        }
      })(), 'unconfirmed cleanup did not report failure');
      const retained = new Promise(resolve => child.once('message', resolve));
      child.send('ping');
      assert.equal(await bounded(retained, 'failed host did not retain ownership'), 'HOST_RETAINED');
      assert.equal(exited, false);
    } else {
      await wait(`${mode}-ready`);
      child.kill('SIGTERM');
      await wait('checks-stopped');
      fs.writeFileSync(path.join(home, `${mode}-release`), 'release');
      assert.deepEqual(await bounded(completion, 'cancelled fixture never completed'), { code: 143, signal: null }, output);
      assert.equal(fs.existsSync(path.join(home, 'terminal-command')), false, 'no login/install after cancellation');
      assert.equal(fs.existsSync(path.join(home, 'context-created')), false, 'no provider page after cancellation');
      if (mode === 'status') {
        assert.equal(fs.existsSync(path.join(home, 'cancelled')), true);
        assert.equal(fs.existsSync(path.join(home, 'browser-imported')), false);
        assert.equal(fs.existsSync(path.join(home, 'lab-created')), false);
      } else {
        assert.equal(fs.existsSync(path.join(home, 'lab-closed')), true, 'late/existing lab must close');
        assert.equal(fs.existsSync(path.join(home, mode === 'browser' ? 'browser-closed' : 'browser-launch')), mode === 'browser');
      }
    }
  } finally {
    if (!exited) child.kill('SIGKILL');
    await bounded(completion, 'fixture host failed to reap').catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const [label, entry, mode] of [
  ['login rejects a successful late preflight', ['voice/realtime/setup.mjs', '--login'], 'status'],
  ['provider rejects a successful late preflight', ['voice/realtime/probe.mjs', '--allow-provider'], 'status'],
  ['probe closes a late lab', ['voice/realtime/probe.mjs', '--allow-provider'], 'lab'],
  ['probe closes a late browser', ['voice/realtime/probe.mjs', '--allow-provider'], 'browser'],
  ['setup retains unconfirmed cleanup', ['voice/realtime/setup.mjs', '--check'], 'unconfirmed'],
  ['probe retains unconfirmed cleanup', ['voice/realtime/probe.mjs', '--check'], 'unconfirmed'],
]) {
  test(label, { skip: process.platform === 'win32' && mode !== 'unconfirmed', timeout: 20000 }, async () => { await terminalFixture(entry, mode); });
}

test('probe server propagates unconfirmed helper cleanup after closing its listener', { timeout: 10000 }, async () => {
  const { createProbeServer } = await import('../voice/realtime/probe-server.mjs');
  let closed = 0;
  const lab = await createProbeServer({ voiceFactory: () => ({
    subscribe() {}, open: async () => 'synthetic answer',
    close: async () => { closed++; return { helperExited: false }; },
  }) });
  try {
    const response = await fetch(`${lab.origin}/call`, { method: 'POST', headers: { Authorization: `Bearer ${lab.token}` }, body: 'synthetic offer' });
    assert.equal(response.status, 200); await response.text();
    await assert.rejects(lab.close(), /helper exit could not be confirmed/);
    await assert.rejects(fetch(lab.origin));
    await assert.rejects(lab.close(), /helper exit could not be confirmed/);
    assert.equal(closed, 1);
  } finally { await lab.close().catch(() => {}); }
});
