import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { getDataDir } from '../db/schema';
import { defaultModels } from '../sync/store';

export const PI_VERSION = '1.5.0';
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
export const isolatedFlags = ['--no-session', '--no-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline'];
import type { PiSetupStatus } from '../types';
export function piPaths() {
  const root = path.join(getDataDir(), 'pi');
  return { root, agent: path.join(root, 'agent'), home: path.join(root, 'home'), work: path.join(root, 'workspace'), selected: path.join(root, 'selected.json') };
}

// Managed children must not inherit unrelated provider keys, pi ownership, custom
// model URLs, preload hooks or the user's global pi configuration. A private HOME
// also prevents ambient cloud-credential lookup. This is not an OS sandbox.
export function managedEnvironment(): NodeJS.ProcessEnv {
  const paths = piPaths(), env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'TMPDIR', 'TMP', 'TEMP']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, HOME: paths.home, USERPROFILE: paths.home, APPDATA: path.join(paths.home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(paths.home, 'AppData', 'Local'),
    PI_CODING_AGENT_DIR: paths.agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
}

/** Refuse symlinked private subdirectories, without creating anything during GET/status. */
export function privateDirectory(directory: string, create = false): void {
  const base = getDataDir(), relative = path.relative(base, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid private pi directory');
  if (create) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { const stat = fs.lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Private pi directories must not be symlinks or files'); if (create) fs.chmodSync(current, 0o700); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (create) fs.mkdirSync(current, { mode: 0o700 }); else return; }
  }
}

export function executable(name: string): string | undefined {
  const candidates = name.includes('/') || name.includes('\\') ? [path.resolve(name)]
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(dir => process.platform === 'win32'
      ? ['', '.exe', '.cmd', '.bat'].map(ext => path.join(dir, name + ext)) : [path.join(dir, name)]);
  return candidates.find(file => { try { fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
}

export function selectedPi() {
  const paths = piPaths();
  if (!process.env.DRAKEN_PI_BIN && fs.existsSync(paths.selected)) {
    privateDirectory(paths.root); privateDirectory(paths.agent); privateDirectory(paths.home); privateDirectory(paths.work);
    for (const name of ['auth.json', 'settings.json', 'models.json', 'models-store.json', 'trust.json']) {
      try { if (fs.lstatSync(path.join(paths.agent, name)).isSymbolicLink()) throw new Error('Private pi configuration files must not be symlinks'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (fs.lstatSync(paths.selected).isSymbolicLink() || fs.statSync(paths.selected).size > 1024) throw new Error('Invalid private pi selection; run draken setup to repair it.');
    const selected = JSON.parse(fs.readFileSync(paths.selected, 'utf8'));
    if (selected.version !== 1 || typeof selected.runtime !== 'string' || !/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(selected.runtime)) throw new Error('Invalid private pi selection; run draken setup to repair it.');
    const runtime = path.join(paths.root, 'runtime', selected.runtime); privateDirectory(runtime);
    const cli = path.join(runtime, 'node_modules', PI_PACKAGE, 'dist', 'cli.js');
    if (!fs.existsSync(cli)) throw new Error('Private pi is incomplete. Run draken setup; credentials will be kept.');
    const relative = path.relative(fs.realpathSync(runtime), fs.realpathSync(cli));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Private pi executable is outside its runtime');
    return { source: 'managed' as const, binary: process.execPath, prefix: [cli], env: managedEnvironment(), agent: paths.agent };
  }
  const name = process.env.DRAKEN_PI_BIN || 'pi', binary = executable(name) || name;
  const env = { ...process.env }; delete env.PI_SESSION_ID; delete env.PI_SESSION_FILE;
  // npm's Windows command shims cannot be spawned without a shell. Resolve only
  // the known pi package next to the shim; never evaluate .cmd text.
  const candidate = /\.cmd$/i.test(binary) ? path.join(path.dirname(binary), 'node_modules', PI_PACKAGE, 'dist', 'cli.js') : '';
  return { source: 'external' as const, binary: candidate && fs.existsSync(candidate) ? process.execPath : binary,
    prefix: candidate && fs.existsSync(candidate) ? [candidate] : [], env,
    agent: process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent') };
}

const checks = new Set<ChildProcess>();
let checksStopping = false;
export async function stopPiChecks(): Promise<void> {
  checksStopping = true;
  await Promise.all([...checks].map(child => new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref();
    child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  })));
}

/** Bounded protocol-only subprocess. Never return raw stderr or credential output. */
async function inspect(args: string[]): Promise<{ code: number | null; text: string }> {
  if (checksStopping) throw new Error('Pi status checks are stopping');
  const pi = selectedPi();
  return new Promise((resolve, reject) => {
    const child = spawn(pi.binary, [...pi.prefix, ...args], { env: { ...pi.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
      cwd: fs.existsSync(getDataDir()) ? getDataDir() : os.tmpdir(), shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    checks.add(child);
    let text = '', failed = false, kill: NodeJS.Timeout | undefined;
    const terminate = () => { failed = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 1000); kill.unref(); };
    const timer = setTimeout(terminate, 8000); timer.unref();
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { if (failed) return; if (Buffer.byteLength(text) + Buffer.byteLength(chunk) > 8192) terminate(); else text += chunk; });
    child.once('error', error => { clearTimeout(timer); if (kill) clearTimeout(kill); reject(error); });
    child.once('close', code => { checks.delete(child); clearTimeout(timer); if (kill) clearTimeout(kill); if (failed) reject(new Error('Pi status check did not finish safely')); else resolve({ code, text }); });
  });
}

async function diagnose(): Promise<PiSetupStatus> {
  let selected: ReturnType<typeof selectedPi>;
  try { selected = selectedPi(); } catch { return { source: 'managed', state: 'error', version: null, agent_dir: piPaths().agent, models: [], message: 'Private pi is incomplete or its selection is invalid. Run draken setup to repair it; credentials are retained.' }; }
  const result: PiSetupStatus = { source: selected.source, state: 'missing', version: null, agent_dir: selected.agent, models: [], message: '' };
  try {
    const version = await inspect(['--version']), match = /^(\d+)\.(\d+)\.(\d+)\s*$/.exec(version.text.trim());
    if (version.code !== 0 || !match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 4)) {
      return { ...result, state: 'incompatible', message: 'Pi 1.4+ is required. Run draken setup for the pinned private runtime, or update your explicit DRAKEN_PI_BIN.' };
    }
    result.version = match[0].trim();
    const models = defaultModels();
    for (const model of [...new Set([models.summary, models.final])]) {
      const check = await inspect(['auth', 'check', '--model', model, '--json', '--no-refresh']);
      let state: PiSetupStatus['models'][number]['state'] = 'unavailable';
      try {
        const value = JSON.parse(check.text);
        if (check.code === 0 && value.status === 'ready') state = 'configured';
        else if (check.code === 1 && value.status === 'not_ready' && value.reason === 'credentials_not_configured') state = 'needs_login';
      } catch { /* Unsupported model/status protocol, not known-ready. */ }
      result.models.push({ model, state });
    }
    result.state = result.models.every(model => model.state === 'configured') ? 'configured' : result.models.some(model => model.state === 'unavailable') ? 'error' : 'needs_login';
    result.message = result.state === 'configured' ? 'Pi credentials are configured. Model access and billing are not verified by this local check.'
      : result.state === 'needs_login' ? 'Run draken login in a terminal on this server, then use /login in pi. Sign in to the provider used by the configured summary models.'
      : 'Pi could not resolve the configured models or credentials. Run draken doctor and check model configuration; no provider or model was substituted.';
  } catch (error) {
    result.state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error';
    result.message = result.state === 'missing' ? 'Summarization needs pi. Run draken setup to install a private copy, then draken login.' : 'Pi status could not be checked. Run draken doctor in a terminal on this server.';
  }
  return result;
}
let cached: { key: string; until: number; pending: boolean; value: Promise<PiSetupStatus> } | undefined;
export function piSetupStatus(fresh = false): Promise<PiSetupStatus> {
  const key = JSON.stringify([getDataDir(), process.env.DRAKEN_PI_BIN, process.env.PATH, process.env.PI_CODING_AGENT_DIR, defaultModels()]);
  if (cached?.key === key && (cached.pending || !fresh && cached.until > Date.now())) return cached.value;
  const value = diagnose();
  const entry = { key, until: Date.now() + 30_000, pending: true, value }; cached = entry;
  void value.then(() => { entry.pending = false; }, () => { entry.pending = false; });
  return value;
}
