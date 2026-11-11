import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { randomUUID } from 'crypto';
import { rememberServer } from './server-state';
import { getDataDir } from './data-dir';
import { ownServerDirectory } from './server-ownership';
import { activity } from './sync/activity';
import { getDb, closeDb } from './db/schema';
import { authMiddleware, isLoopbackHost, isNoAuthMode, validateAuthConfig } from './auth/middleware';
import authRouter from './routes/auth';
import syncRouter from './routes/sync';
import memoryRouter from './routes/memory';
import { shutdownHistory } from './memory/service';
import { startBackgroundIndexing, stopBackgroundIndexing } from './sync/background';
import voiceRouter from './routes/voice';
import { recoverLegacyCalls } from './voice/legacy-history';
import { validateVoiceConfig, recoverLiveCalls, shutdownLiveVoice } from './voice/live';
import { recoverInterruptedRuns } from './sync/store';
import { HttpError } from './errors';
import { stopManagerProcesses } from './sync/pi';
import { stopPiChecks } from './pi/runtime';

export function createApp(options: { staticDir?: string; instanceId?: string } = {}) {
  const app = express();
  app.locals.drakenInstance = options.instanceId;
  const staticDir = options.staticDir || path.join(__dirname, '../public');
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    // This local application exposes private transcripts. No cross-origin API access.
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
      } catch { return res.status(403).json({ error: 'Invalid origin' }); }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site requests are not allowed' });
    if (isNoAuthMode()) {
      const hostname = (req.headers.host || '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return res.status(403).json({ error: 'Local mode requires a loopback host' });
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/auth', authRouter);
  app.use('/api/voice', authMiddleware, voiceRouter);
  app.use('/api/memory', authMiddleware, memoryRouter);
  app.use('/api', authMiddleware, syncRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof HttpError ? error.status : error.status === 400 || error.status === 413 ? error.status : 500;
    if (status === 500) console.error('Draken request failed:', error.message);
    res.status(status).json({ error: status === 500 ? 'Internal error. See the local server log.' : error.message });
  });
  return app;
}

export function startServer(trayOwned = false): void {
  if (trayOwned && (!process.send || !process.connected)) throw new Error('The tray launcher disconnected. No server was started.');
  validateAuthConfig();
  validateVoiceConfig();
  const host = process.env.DRAKEN_HOST || '127.0.0.1';
  const port = Number(process.env.DRAKEN_PORT || 40333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DRAKEN_PORT must be between 1 and 65535');
  if (isNoAuthMode() && !isLoopbackHost(host)) {
    throw new Error('No-auth mode may only bind to loopback. Configure authentication before exposing Draken.');
  }
  const httpsPort = Number(process.env.DRAKEN_HTTPS_PORT || 0);
  if (!Number.isInteger(httpsPort) || httpsPort < 0 || httpsPort > 65535 || (httpsPort !== 0 && httpsPort === port)) throw new Error('DRAKEN_HTTPS_PORT must be a different valid port');
  const tls = httpsPort ? { cert: fs.readFileSync(process.env.DRAKEN_TLS_CERT || ''), key: fs.readFileSync(process.env.DRAKEN_TLS_KEY || '') } : null;
  // Bind before recovery: a second launch on an occupied port must not mark the
  // actual server's active runs/calls interrupted or mutate its database.
  let ready = false, listening = 0, stopping = false;
  let releaseDirectory: (() => void) | undefined;
  const instanceId = randomUUID();
  const app = express();
  app.use((_req, res, next) => ready ? next() : res.status(503).json({ error: 'Draken is starting or stopping.' }));
  app.use(createApp({ instanceId }));
  const bound = () => {
    if (++listening !== (tls ? 2 : 1) || stopping) return;
    try {
      releaseDirectory = ownServerDirectory(getDataDir());
      getDb(); recoverInterruptedRuns(); recoverLegacyCalls(); recoverLiveCalls();
      const httpAddress = server.address(), secureAddress = secureServer?.address();
      if (!httpAddress || typeof httpAddress === 'string' || typeof secureAddress === 'string') throw new Error('Cannot record the listening address');
      const target = rememberServer(instanceId, httpAddress, secureAddress || undefined);
      ready = true;
      if (trayOwned) process.send!({ type: 'draken-ready', target }, error => { if (error) shutdown(1); });
      const display = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      console.log(`Draken sync running at http://${display}:${port}`);
      if (tls) console.log(`Draken voice page: https://${display}:${httpsPort}`);
      console.log((trayOwned ? 'Managed by Draken tray. Use its menu to stop the server; closing the browser does not.\n' : 'Keep this terminal open. Ctrl+C stops the server; closing the browser does not.\n') + 'First use / missing pi: draken setup → draken login (inside pi, type /login, then /quit).\nAlready have pi? Keep your configured installation; draken doctor checks summary setup.\nVoice: draken voice setup → draken voice login (separate ChatGPT sign-in).\nUse the same server user and environment for these commands. Select history in Settings → Agents & sessions, then Sync with Draken.\nCheck server connectivity with draken status. No startup login, model download, provider call or microphone capture is performed.');
      startBackgroundIndexing();
    } catch (error) { console.error(error instanceof Error ? error.message : 'Draken startup failed'); shutdown(1); }
  };
  const secureServer = tls ? https.createServer(tls, app).listen(httpsPort, host, bound) : null;
  const server = app.listen(port, host, bound);
  const shutdown = (code = 0) => {
    if (stopping) return; stopping = true; ready = false;
    const activityStopped = activity.shutdown();
    // SQLite ownership alone does not keep Node's event loop alive.
    const keepAlive = setInterval(() => {}, 60_000);
    let reported = false;
    const unconfirmed = () => {
      if (!reported) console.error('Shutdown is unconfirmed. This process retains data-directory ownership; no replacement server may start. Inspect the owned resources before forcing termination.');
      reported = true; process.exitCode = 1;
    };
    const deadline = setTimeout(unconfirmed, 6500);
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    const secureClosed = new Promise<void>(resolve => secureServer ? secureServer.close(() => resolve()) : resolve());
    void Promise.allSettled([closed, secureClosed, activityStopped, stopBackgroundIndexing(),
      stopManagerProcesses(), shutdownHistory(), shutdownLiveVoice(), stopPiChecks()]).then(results => {
      if (results.some(result => result.status === 'rejected')) { unconfirmed(); return; }
      try { closeDb(); releaseDirectory?.(); }
      catch { unconfirmed(); return; }
      clearTimeout(deadline); clearInterval(keepAlive); process.exit(code);
    });
  };
  const failed = (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'EADDRINUSE' ? 'Draken could not bind: a configured port is already in use. Run draken status; do not start a second server.' : `Draken could not listen (${error.code || 'unknown error'}). Check the bind address, ports and server log.`);
    shutdown(1);
  };
  server.once('error', failed); secureServer?.once('error', failed);
  if (trayOwned) {
    // Only the owning child-process IPC channel can request this. There is no
    // HTTP shutdown endpoint, PID-file kill, or Windows forced termination.
    process.on('message', (message: any) => {
      if (message?.type === 'draken-shutdown' && message.instance === instanceId) shutdown();
    });
    process.once('disconnect', () => shutdown());
  }
  process.once('SIGINT', () => shutdown());
  process.once('SIGTERM', () => shutdown());
}

if (require.main === module) {
  try { startServer(); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
