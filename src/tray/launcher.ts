import path from 'path';
import { spawn } from 'child_process';
import { getDataDir } from '../db/schema';

export function assertTrayDesktop(platform = process.platform, env = process.env): void {
  if (platform !== 'darwin' && platform !== 'win32') throw new Error('The tray currently supports macOS and Windows desktops only. On this system use draken and draken status; no server was started.');
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SESSIONNAME?.toLowerCase() === 'services') throw new Error('Run draken tray in your local desktop session, not SSH or a Windows service.');
}

export async function launchTray(): Promise<void> {
  assertTrayDesktop();
  const child = spawn(process.execPath, [path.join(__dirname, '../cli.js'), '--tray-worker'], {
    env: { ...process.env, DRAKEN_DATA_DIR: path.resolve(getDataDir()) }, detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (child.connected) child.disconnect(); child.unref();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('Could not confirm desktop tray readiness. Check draken status and the tray/error.log file in your Draken data directory.')), 15_000);
    child.once('error', error => finish(error));
    child.once('exit', () => finish(new Error('The tray exited before it was ready. Check tray/error.log in your Draken data directory.')));
    child.on('message', (message: any) => {
      if (message?.type === 'tray-ready') finish();
      else if (message?.type === 'tray-error') finish(new Error(typeof message.message === 'string' ? message.message.slice(0, 500) : 'Could not start tray'));
    });
  });
  console.log('Draken tray is ready. You can close this terminal. Open its menu for server status and controls.\nAn existing server stays under its original launcher; Quit stops only a server owned by this tray.');
}
