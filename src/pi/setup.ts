import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { createInterface } from 'readline/promises';
import { getDataDir } from '../db/schema';
import { npmCli } from '../npm-cli';
import { executable, isolatedFlags, managedEnvironment, PI_PACKAGE, PI_VERSION, piPaths, piSetupStatus, privateDirectory, selectedPi } from './runtime';

/** Explicit terminal operations only. This module has no HTTP installation/login route. */
function run(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeout = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, cwd, shell: false, stdio: 'inherit' });
    let cancelled = false, kill: NodeJS.Timeout | undefined;
    const stop = () => { if (cancelled) return; cancelled = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 1500); kill.unref(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const timer = timeout ? setTimeout(stop, timeout) : undefined;
    const cleanup = () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); if (timer) clearTimeout(timer); if (kill) clearTimeout(kill); };
    child.once('error', () => { cleanup(); reject(new Error('Could not start the requested program. Check Node.js/npm and executable permissions.')); });
    child.once('close', code => { cleanup(); if (cancelled) reject(new Error('Operation cancelled or timed out. Existing credentials were retained.')); else if (code !== 0) reject(new Error(`The requested program exited with status ${code ?? 'signal'}.`)); else resolve(); });
  });
}

export async function installPi(yes: boolean): Promise<void> {
  if (process.env.DRAKEN_PI_BIN) throw new Error('DRAKEN_PI_BIN is explicitly configured. Keep using it, or unset it before selecting Draken’s private pi. No installation was changed.');
  const paths = piPaths(), bundle = path.resolve(__dirname, '../../runtime/pi');
  const lock = fs.readFileSync(path.join(bundle, 'package-lock.json')), manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'package.json'), 'utf8'));
  if (manifest.dependencies?.[PI_PACKAGE] !== PI_VERSION) throw new Error('The packaged pi manifest does not match this Draken version. Reinstall Draken.');
  const tag = `${PI_VERSION}-${createHash('sha256').update(lock).digest('hex').slice(0, 16)}`;
  const runtime = path.join(paths.root, 'runtime', tag);
  console.log(`Private pi ${PI_VERSION}: ${runtime}\nPi configuration/credentials: ${paths.agent}\nThis downloads pi and its locked dependencies from npm. It does not copy credentials or change global pi.`);
  if (!yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Installation needs confirmation. Run draken setup in a terminal, or explicitly use draken setup --yes.');
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try { if (!/^(y|yes)$/i.test((await terminal.question('Install and select this private runtime? [y/N] ')).trim())) { console.log('No changes made.'); return; } }
    finally { terminal.close(); }
  }
  const npm = npmCli();
  for (const dir of [paths.root, paths.home, paths.agent, paths.work, path.dirname(runtime)]) privateDirectory(dir, true);
  const lockPath = path.join(paths.root, 'setup.lock');
  let descriptor: number;
  try { descriptor = fs.openSync(lockPath, 'wx', 0o600); } catch { throw new Error(`Setup is already running or was interrupted. Check ${lockPath}; remove that lock only after confirming no setup process is running.`); }
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.closeSync(descriptor);
  const stage = path.join(paths.root, `.install-${randomUUID()}`), selection = path.join(paths.root, `.selected-${randomUUID()}.json`);
  try {
    privateDirectory(runtime);
    const packageFile = path.join(runtime, 'node_modules', PI_PACKAGE, 'package.json');
    const complete = fs.existsSync(packageFile) && JSON.parse(fs.readFileSync(packageFile, 'utf8')).version === PI_VERSION
      && fs.existsSync(path.join(runtime, 'node_modules', PI_PACKAGE, 'dist/cli.js'))
      && fs.existsSync(path.join(runtime, '.qualified-lock')) && fs.readFileSync(path.join(runtime, '.qualified-lock'), 'utf8') === createHash('sha256').update(lock).digest('hex');
    if (!complete) {
      if (fs.existsSync(runtime)) throw new Error(`An incomplete runtime exists at ${runtime}. Move that directory aside and retry; do not remove the agent/ credential directory.`);
      privateDirectory(stage, true);
      fs.copyFileSync(path.join(bundle, 'package.json'), path.join(stage, 'package.json')); fs.writeFileSync(path.join(stage, 'package-lock.json'), lock);
      for (const name of ['user.npmrc', 'global.npmrc']) fs.writeFileSync(path.join(stage, name), '', { mode: 0o600 });
      // npm's dependency tree and integrity hashes come from our shipped lockfile,
      // not mutable latest tags. No lifecycle scripts or user npm configuration.
      await run(process.execPath, [npm, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org',
        `--userconfig=${path.join(stage, 'user.npmrc')}`, `--globalconfig=${path.join(stage, 'global.npmrc')}`, `--cache=${path.join(paths.home, '.npm')}`], managedEnvironment(), stage, 10 * 60_000);
      const installed = JSON.parse(fs.readFileSync(path.join(stage, 'node_modules', PI_PACKAGE, 'package.json'), 'utf8'));
      if (installed.name !== PI_PACKAGE || installed.version !== PI_VERSION) throw new Error('Installed pi did not match the pinned package. No runtime was selected.');
      await run(process.execPath, [path.join(stage, 'node_modules', PI_PACKAGE, 'dist/cli.js'), '--version'], managedEnvironment(), paths.work, 15_000);
      fs.writeFileSync(path.join(stage, '.qualified-lock'), createHash('sha256').update(lock).digest('hex'), { mode: 0o600 });
      fs.renameSync(stage, runtime);
    }
    if (complete) await run(process.execPath, [path.join(runtime, 'node_modules', PI_PACKAGE, 'dist/cli.js'), '--version'], managedEnvironment(), paths.work, 15_000);
    fs.writeFileSync(selection, JSON.stringify({ version: 1, runtime: tag }) + '\n', { mode: 0o600 }); fs.renameSync(selection, paths.selected);
    console.log('\nPrivate pi selected. Next: draken login\nInside pi, type /login and sign in, then /quit. Draken never copies your global pi credentials.\nUse draken doctor to check configuration. The running server picks up this selection for subsequent requests.');
  } finally { fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(selection, { force: true }); fs.rmSync(lockPath, { force: true }); }
}

export async function loginPi(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Login needs an interactive terminal on the Draken server. Run draken login there as the server’s user, with the same DRAKEN_DATA_DIR and DRAKEN_PI_BIN environment.');
  const pi = selectedPi();
  if (pi.source === 'managed') for (const dir of [piPaths().agent, piPaths().home, piPaths().work]) privateDirectory(dir, true);
  else if (!executable(pi.binary)) throw new Error('Pi is missing. Run draken setup first.');
  const cwd = path.join(getDataDir(), 'pi', 'workspace'); privateDirectory(cwd, true);
  console.log(`Opening ${pi.source === 'managed' ? 'Draken’s private' : 'your existing'} pi login interface.\nCredential directory: ${pi.agent}\nType /login (or /login openai for the default models), follow pi’s prompts, then /quit.\nDo not pass /login as a model prompt. Tools, project resources and session persistence are disabled.\nThis is summarization authentication, not the separate ChatGPT voice login.`);
  await run(pi.binary, [...pi.prefix, ...isolatedFlags], pi.env, cwd);
  await doctor();
}

export async function doctor(): Promise<void> {
  const status = await piSetupStatus(true);
  console.log(`Summary runtime: ${status.source} · ${status.state}${status.version ? ` · pi ${status.version}` : ''}\nPi credential directory: ${status.agent_dir}\n${status.message}`);
  for (const model of status.models) console.log(`  ${model.model}: ${model.state}`);
  console.log('Credential checks do not generate text, verify provider access or measure billing.\nVoice is separate: draken voice setup → draken voice login\nHistory sources: Settings → Agents & sessions. Then Sync with Draken.');
  if (status.state !== 'configured') process.exitCode = 1;
}

export async function voiceSetup(action: string): Promise<void> {
  const flag = ({ setup: '--install', login: '--login', status: '--check' } as Record<string, string>)[action];
  if (!flag) throw new Error('Usage: draken voice setup | login | status');
  if (action === 'login' && !process.stdin.isTTY) throw new Error('Run draken voice login in an interactive terminal on the server.');
  await run(process.execPath, [path.resolve(__dirname, '../../voice/realtime/setup.mjs'), flag], process.env, process.cwd());
}
