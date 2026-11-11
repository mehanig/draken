import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { npmCli } from '../../dist/npm-cli.js';
import { NativeHelperProcess } from './helper-process.mjs';
import { CODEX_VERSION, realtimeRoot, defaultBinary, defaultHome, helperEnvironment, nativeStatus, stopNativeChecks } from './native.mjs';

/** One terminal workflow owns both preflight and explicit install/login children. */
export async function voiceSetup(action) {
  if (!['setup', 'login', 'status'].includes(action)) throw new Error('Usage: draken voice setup | login | status');
  process.umask(0o077);
  const controller = new AbortController();
  const { signal } = controller;
  let command, checksClosing;
  // A pending cleanup promise alone does not keep Node alive.
  const hold = setInterval(() => {}, 1000);
  const stopChecks = () => {
    if (!checksClosing) { checksClosing = stopNativeChecks(); checksClosing.catch(() => {}); }
    return checksClosing;
  };
  const onSignal = name => {
    if (signal.aborted) return;
    process.exitCode = name === 'SIGINT' ? 130 : 143;
    controller.abort(); command?.close(); void stopChecks();
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const active = () => { if (signal.aborted) throw new Error('Native voice operation cancelled.'); };
  const run = async (binary, args, env) => {
    active();
    command = new NativeHelperProcess(binary, args, { env, stdio: 'inherit' });
    const helper = command;
    await new Promise(resolve => {
      const done = () => {
        helper.child.removeListener('close', done); helper.child.removeListener('error', done);
        signal.removeEventListener('abort', done); resolve();
      };
      helper.child.once('close', done); helper.child.once('error', done);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
    if (signal.aborted) helper.close();
    if (!(await helper.waitForExit())) throw new Error('Native terminal helper exit could not be confirmed.');
    command = undefined;
    active();
    if (helper.child.exitCode !== 0) throw new Error('The requested helper did not complete.');
  };
  try {
    active();
    if (action === 'setup') {
      fs.mkdirSync(realtimeRoot, { recursive: true, mode: 0o700 });
      await run(process.execPath, [npmCli(), 'install', '--prefix', path.join(realtimeRoot, 'runtime'), '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `@openai/codex@${CODEX_VERSION}`], helperEnvironment(defaultHome));
    }
    if (action === 'login') {
      const status = await nativeStatus({ signal });
      active();
      if (!status.installed) throw new Error('Run npm run voice:realtime:setup first.');
      fs.mkdirSync(defaultHome, { recursive: true, mode: 0o700 });
      if (fs.existsSync(path.join(defaultHome, 'config.toml'))) throw new Error('The dedicated voice account directory must not contain a custom config.toml.');
      // Explicit native ChatGPT sign-in, not API-key login or pi token conversion.
      await run(defaultBinary, ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', 'login', '--device-auth'], helperEnvironment(defaultHome));
    }
    active();
    const status = await nativeStatus({ signal });
    active();
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    console.error(error.message);
    if (!signal.aborted) process.exitCode = 1;
  } finally {
    command?.close();
    const warning = setTimeout(() => console.error('Native voice cleanup is still pending. Keeping this terminal host alive.'), 10_000);
    const results = await Promise.allSettled([stopChecks(), command ? command.waitForExit().then(exited => {
      if (!exited) throw new Error('Native terminal helper exit could not be confirmed.');
    }) : Promise.resolve()]);
    clearTimeout(warning);
    if (results.some(result => result.status === 'rejected')) {
      process.exitCode = 1;
      console.error('Native voice cleanup could not be confirmed. Keeping this terminal host alive; no further operation will start.');
      // Keep signal handlers and the host alive rather than abandon owned children.
      await new Promise(() => {});
    }
    clearInterval(hold);
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flags = process.argv.slice(2);
  const action = ({ '--install': 'setup', '--login': 'login', '--check': 'status' })[flags[0]];
  if (flags.length !== 1 || !action) {
    console.error('Usage: node voice/realtime/setup.mjs --install | --login | --check'); process.exitCode = 2;
  } else {
    void voiceSetup(action).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
