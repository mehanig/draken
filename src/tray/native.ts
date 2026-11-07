import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import type { TrayAction } from './controller';

export interface TrayHelper { ready: Promise<void>; exited: Promise<void>; close(): Promise<void> }

export function nativeCommand(platform: NodeJS.Platform, systemRoot: string) {
  const root = path.join(__dirname, '../../tray');
  if (platform === 'darwin') return { executable: '/usr/bin/osascript', args: ['-l', 'JavaScript', path.join(root, 'macos.js')] };
  if (platform !== 'win32') throw new Error('Unsupported tray platform');
  // PowerShell parses its command line differently from a conventional Windows
  // argv consumer. UTF-16LE encoding preserves the fixed program verbatim; it
  // does not change execution policy or interpolate presentation/user data.
  const program = Buffer.from(fs.readFileSync(path.join(root, 'windows.ps1'), 'utf8'), 'utf16le').toString('base64');
  return { executable: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', program] };
}

export function nativeTray(statePath: string, action: (action: TrayAction) => void): TrayHelper {
  const root = path.join(__dirname, '../../tray');
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'PATH']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  // Native UI receives no Draken/provider credentials, URLs, transcripts or
  // inherited preload hooks. Only a private, bounded presentation file.
  env.DRAKEN_TRAY_STATE = statePath;
  env.DRAKEN_TRAY_ASSETS = path.join(root, 'assets');
  const { executable, args } = nativeCommand(process.platform, env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows');
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  let resolveReady: () => void, rejectReady: (error: Error) => void, readySeen = false, finished = false, diagnostic = '', phase = 'launching';
  const failure = () => new Error(`Native tray could not start (${phase}). Check desktop availability and OS application-control policies.${diagnostic ? ' ' + diagnostic.slice(-800).trim() : ''}`);
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const fail = () => { rejectReady(failure()); child.kill(); };
  const timer = setTimeout(fail, 10_000);
  let pending = ''; const decoder = new StringDecoder('utf8');
  child.stdout!.on('data', (chunk: Buffer) => {
    pending += decoder.write(chunk);
    if (Buffer.byteLength(pending) > 8192) { fail(); return; }
    let split: number;
    while ((split = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, split); pending = pending.slice(split + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === 'ready' && !readySeen) { readySeen = true; clearTimeout(timer); resolveReady(); }
        else if (message.type === 'progress' && !readySeen && ['configuring-output', 'loading-frameworks', 'creating-menu', 'showing-icon'].includes(message.phase)) phase = message.phase;
        else if (message.type === 'action' && readySeen && ['open', 'start', 'stop', 'quit'].includes(message.action)) action(message.action);
        else { fail(); return; }
      } catch { fail(); return; }
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString('utf8')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(-4096); });
  const exited = new Promise<void>(resolve => {
    const finish = () => { if (finished) return; finished = true; clearTimeout(timer); rejectReady(failure()); resolve(); };
    child.once('error', finish); child.once('exit', finish);
  });
  return { ready, exited, async close() {
    if (finished) return;
    // Worker publishes quit first. Terminate only this UI helper if its loop is stuck.
    const timer = setTimeout(() => child.kill(), 1500);
    await exited; clearTimeout(timer);
  } };
}
