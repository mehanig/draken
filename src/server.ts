import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { getDb, closeDb } from './db/schema';
import { authMiddleware, isLoopbackHost, isNoAuthMode, validateAuthConfig } from './auth/middleware';
import authRouter from './routes/auth';
import syncRouter from './routes/sync';
import { HttpError, recoverInterruptedRuns } from './sync/store';
import { stopManagerProcesses } from './sync/manager';

export function createApp(options: { staticDir?: string } = {}) {
  const app = express();
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

export function startServer(): void {
  validateAuthConfig();
  const host = process.env.DRAKEN_HOST || '127.0.0.1';
  const port = Number(process.env.DRAKEN_PORT || 40333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DRAKEN_PORT must be between 1 and 65535');
  if (isNoAuthMode() && !isLoopbackHost(host)) {
    throw new Error('No-auth mode may only bind to loopback. Configure authentication before exposing Draken.');
  }
  getDb();
  recoverInterruptedRuns();
  const server = createApp().listen(port, host, () => {
    console.log(`Draken sync running at http://${host}:${port}`);
    console.log('Session indexing is local. Model requests happen only when you ask for a briefing or reply.');
  });
  const shutdown = () => {
    stopManagerProcesses();
    server.close(() => { closeDb(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  try { startServer(); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
