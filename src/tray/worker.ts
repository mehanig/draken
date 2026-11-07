import fs from 'fs';
import path from 'path';
import { getDataDir } from '../db/schema';
import { configuredServerTarget, recordedServerTarget, serverTarget } from '../server-state';
import { probeServer } from '../server-status';
import { TrayController, TrayView } from './controller';
import { nativeTray, TrayHelper } from './native';
import { launchServer, openBrowser } from './processes';
import { assertTrayDesktop } from './launcher';

// This library supplies heartbeat locks and stale-lock recovery across both OSes.
const lockfile: { lock(file: string, options: { stale: number; update: number; retries: number; onCompromised(error: Error): void }): Promise<() => Promise<void>> } = require('proper-lockfile');

export async function runTrayWorker(helperFactory = nativeTray, checkDesktop = assertTrayDesktop): Promise<void> {
  checkDesktop();
  const directory = path.join(getDataDir(), 'tray');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) throw new Error('The private tray directory must not be a symlink.');
  fs.chmodSync(directory, 0o700);
  let helper: TrayHelper | undefined, controller: TrayController | undefined, release: (() => Promise<void>) | undefined;
  let heartbeat: NodeJS.Timeout | undefined, poll: NodeJS.Timeout | undefined;
  let run = '', ready = false, quitting: Promise<void> | undefined, finished = false, lostHelper = false;
  const errorLog = (message: string) => {
    let fd: number | undefined;
    try {
      const file = path.join(directory, 'error.log');
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) return;
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, message.slice(0, 2000) + '\n');
    } catch { /* Do not hide primary failure. */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  let view: TrayView = { phase: 'starting', title: 'Draken — Starting tray', detail: 'Checking the server', canOpen: false, canStart: false, canStop: false, owned: false };
  let quit = false;
  const publish = () => {
    if (!run) return;
    const temp = path.join(run, 'state.tmp');
    fs.writeFileSync(temp, JSON.stringify({ version: 1, updated: Date.now(), quit, ...view }), { mode: 0o600 });
    fs.renameSync(temp, path.join(run, 'state.json'));
  };
  const shutdown = () => {
    if (quitting) return quitting;
    quitting = (async () => {
      if (controller && !await controller.close()) { errorLog('Owned server shutdown was not confirmed. No replacement was started.'); return; }
      clearInterval(heartbeat); clearInterval(poll); quit = true;
      try { publish(); } catch { /* Helper also has a heartbeat timeout. */ }
      await helper?.close();
      try { await release?.(); } catch { errorLog('Tray lock release could not be confirmed; stale-lock recovery remains available.'); }
      release = undefined;
      if (run) fs.rmSync(run, { recursive: true, force: true });
      finished = true;
      process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal); process.removeListener('disconnect', onDisconnect);
      if (process.connected) process.disconnect();
    })().finally(() => { quitting = undefined; });
    return quitting;
  };
  const onSignal = () => { void shutdown(); };
  const onDisconnect = () => { if (!ready) void shutdown(); };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal); process.on('disconnect', onDisconnect);
  try {
    release = await lockfile.lock(directory, { stale: 30_000, update: 5000, retries: 0, onCompromised: () => { errorLog('Tray lock lost. Stopping only the server owned by this tray.'); void shutdown(); } });
    run = fs.mkdtempSync(path.join(directory, 'run-'));
    publish();
    helper = helperFactory(path.join(run, 'state.json'), action => {
      if (action === 'quit') void shutdown();
      else if (ready) void controller?.act(action).catch(() => { errorLog('Tray action failed. Check draken status.'); });
    });
    await helper.ready;
    if (!process.connected) throw new Error('Tray launch was cancelled before readiness');
    // A host/port override must not hide an existing instance in the same DB
    // directory and cause startup recovery under a second listener.
    controller = new TrayController({ target: () => recordedServerTarget() || serverTarget(), configured: configuredServerTarget, probe: probeServer,
      launch: () => launchServer(path.join(directory, 'server.log')), open: openBrowser,
      changed: value => { view = value; publish(); } });
    ready = true;
    process.send!({ type: 'tray-ready' }, error => { if (error) { ready = false; void shutdown(); } });
    heartbeat = setInterval(() => {
      if (lostHelper) { void shutdown(); return; }
      try { publish(); } catch { errorLog('Cannot retain tray status.'); void shutdown(); }
    }, 1000);
    void helper.exited.then(() => {
      lostHelper = true;
      if (!finished && !quitting) { errorLog('Native tray closed. Stopping its owned server.'); void shutdown(); }
    });
    await controller.initialize();
    if (!finished && !quitting) poll = setInterval(() => { void controller!.poll().catch(() => { errorLog('Cannot check server status.'); }); }, 2000);
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'ELOCKED'
      ? 'A tray already owns this data directory, or exited uncleanly. Close it or wait 30 seconds, then retry.'
      : error instanceof Error ? error.message : 'Tray startup failed';
    errorLog(message);
    if (process.connected) process.send!({ type: 'tray-error', message }, () => {});
    await shutdown();
  }
}
