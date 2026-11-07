import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { ServerTarget } from '../server-status';
import type { OwnedServer } from './controller';

export function launchServer(logPath: string): OwnedServer {
  const child = spawn(process.execPath, [path.join(__dirname, '../cli.js'), '--tray-server'], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let target: ServerTarget | undefined, done = false, stopped: Promise<boolean> | undefined;
  let readyResolve: (target: ServerTarget) => void, readyReject: (error: Error) => void;
  const ready = new Promise<ServerTarget>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Keep only a bounded private diagnostic tail, never stdout in the launch terminal.
  let tail = Buffer.alloc(0);
  const log = (part: Buffer) => {
    tail = Buffer.concat([tail, part]).subarray(-64 * 1024);
    let fd: number | undefined;
    try {
      if (fs.existsSync(logPath) && fs.lstatSync(logPath).isSymbolicLink()) return;
      fd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, tail);
    } catch { /* Status still reports process failure. */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  child.stdout!.on('data', log); child.stderr!.on('data', log);
  const timer = setTimeout(() => readyReject(new Error('Server startup timed out')), 15_000);
  child.on('message', (message: any) => {
    if (message?.type !== 'draken-ready' || target) return;
    const value = message.target;
    try {
      if (typeof value?.instance !== 'string' || !/^[a-f0-9-]{36}$/.test(value.instance)) throw new Error('Invalid instance');
      for (const key of ['url', 'open']) {
        const url = new URL(value[key]);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value[key]) throw new Error('Invalid address');
      }
      target = { url: value.url, open: value.open, instance: value.instance };
      clearTimeout(timer); readyResolve(target);
    } catch { readyReject(new Error('Invalid server readiness message')); }
  });
  const exited = new Promise<void>(resolve => {
    const finish = () => { if (done) return; done = true; clearTimeout(timer); readyReject(new Error('Server exited')); resolve(); };
    child.once('error', finish); child.once('exit', finish);
  });
  return { ready, exited, stop() {
    if (done) return Promise.resolve(true);
    if (stopped) return stopped;
    stopped = (async () => {
      // IPC is private to this child. Windows kill(SIGTERM) is not graceful.
      if (child.connected) child.send({ type: 'draken-shutdown', instance: target?.instance }, () => {});
      // Disconnect also requests shutdown, including a failed pre-ready launch.
      if (child.connected) child.disconnect();
      let deadline: NodeJS.Timeout | undefined;
      const result = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 10_000); })]);
      clearTimeout(deadline); return result;
    })().finally(() => { stopped = undefined; });
    return stopped;
  } };
}

/** Open a fixed, validated HTTP origin without shell interpolation. No tokens in URLs. */
export function openBrowser(url: string, platform = process.platform): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== url || /[\r\n"<>|]/.test(url)) return Promise.reject(new Error('Invalid browser URL'));
  const command = platform === 'darwin' ? '/usr/bin/open' : path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'rundll32.exe');
  const args = platform === 'darwin' ? [url] : ['url.dll,FileProtocolHandler', url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Browser launch timed out')); }, 5000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Could not open browser')); });
  });
}
