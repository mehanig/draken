import fs from 'fs';
import path from 'path';
import { isIP } from 'net';
import { randomUUID } from 'crypto';
import { getDataDir } from './db/schema';

interface ServerState {
  version: 1;
  instance: string;
  pid: number;
  http_url: string;
  https_url: string | null;
  started_at: string;
}
const stateFile = () => path.join(getDataDir(), 'server-state.json');
const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

function endpoint(host: string, port: number, secure = false): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid status port');
  const local = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const address = local.includes(':') && !local.startsWith('[') ? `[${local}]` : local;
  const value = new URL(`${secure ? 'https' : 'http'}://${address}:${port}`);
  if (value.username || value.password || value.pathname !== '/' || value.search || value.hash) throw new Error('Invalid status address');
  return value.origin;
}

function readState(): ServerState | undefined {
  let fd: number | undefined;
  try {
    if (fs.lstatSync(stateFile()).isSymbolicLink()) throw new Error('Invalid server record');
    fd = fs.openSync(stateFile(), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid server record');
    const bytes = Buffer.alloc(4097), length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 4096) throw new Error('Invalid server record');
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (value.version !== 1 || typeof value.instance !== 'string' || !idPattern.test(value.instance) || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.started_at !== 'string' || !Number.isFinite(Date.parse(value.started_at))) throw new Error('Invalid server record');
    for (const [key, protocol] of [['http_url', 'http:'], ['https_url', 'https:']]) {
      if (key === 'https_url' && value[key] === null) continue;
      if (typeof value[key] !== 'string' || value[key].length > 256) throw new Error('Invalid server record');
      const url = new URL(value[key]);
      // Saved addresses come from the actual bound sockets, never arbitrary URLs
      // or dashboard input. Explicit operator overrides may still use DNS names.
      if (url.protocol !== protocol || url.port === '0' || !isIP(url.hostname.replace(/^\[|\]$/g, '')) || url.origin !== value[key]) throw new Error('Invalid server record');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('The saved server address is invalid. Check server-state.json in DRAKEN_DATA_DIR, or supply an explicit DRAKEN_HOST/DRAKEN_PORT override.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Last successful bind, not a claim that the process is still alive. Kept after
 * shutdown so status can check the same address; a live instance match is required. */
export function rememberServer(instance: string, http: { address: string; port: number }, https?: { address: string; port: number }) {
  const state: ServerState = { version: 1, instance, pid: process.pid, http_url: endpoint(http.address, http.port),
    https_url: https ? endpoint(https.address, https.port, true) : null, started_at: new Date().toISOString() };
  const temp = path.join(getDataDir(), `.server-state-${randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, stateFile()); }
  finally { fs.rmSync(temp, { force: true }); }
  return { url: state.http_url, open: state.https_url || state.http_url, instance };
}

/** Where a new server would bind with this process's environment, not saved state. */
export function configuredServerTarget() {
  const host = process.env.DRAKEN_HOST || '127.0.0.1';
  const url = endpoint(host, Number(process.env.DRAKEN_PORT || 40333));
  return { url, open: process.env.DRAKEN_HTTPS_PORT && process.env.DRAKEN_HTTPS_PORT !== '0'
    ? endpoint(host, Number(process.env.DRAKEN_HTTPS_PORT), true) : url, instance: undefined };
}

export function recordedServerTarget() {
  const saved = readState();
  return saved ? { url: saved.http_url, open: saved.https_url || saved.http_url, instance: saved.instance } : undefined;
}

export function serverTarget() {
  const explicit = Boolean(process.env.DRAKEN_HOST || process.env.DRAKEN_PORT);
  let saved: ServerState | undefined;
  try { saved = readState(); } catch (error) { if (!explicit) throw error; }
  if (explicit) {
    const last = saved && new URL(saved.http_url);
    const host = process.env.DRAKEN_HOST || last?.hostname || '127.0.0.1';
    const port = Number(process.env.DRAKEN_PORT || last?.port || (last ? '80' : '40333'));
    const url = endpoint(host, port), same = url === saved?.http_url;
    return { url, open: same ? saved!.https_url || url : url, instance: same ? saved!.instance : undefined };
  }
  if (saved) return { url: saved.http_url, open: saved.https_url || saved.http_url, instance: saved.instance };
  return { url: 'http://127.0.0.1:40333', open: 'http://127.0.0.1:40333', instance: undefined };
}
