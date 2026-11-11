import { Router } from 'express';
import { route } from './http';
import fs from 'fs';
import { X509Certificate } from 'crypto';
import { HttpError } from '../errors';
import { legacyCallHistory } from '../voice/legacy-history';
import { liveStatus, liveHistory } from '../voice/live';
import liveRouter from './live-voice';

const router = Router();

router.use('/live', liveRouter);
router.get('/status', route(async (_req, res) => res.json({
  ...await liveStatus(),
  certificateAvailable: Boolean(process.env.DRAKEN_TLS_CA && fs.existsSync(process.env.DRAKEN_TLS_CA)),
})));
router.get('/certificate', route((_req, res) => {
  if (!process.env.DRAKEN_TLS_CA) throw new HttpError(404, 'No local certificate download is configured');
  // Re-encode only the public certificate; never serve a key or an arbitrary source file.
  const certificate = new X509Certificate(fs.readFileSync(process.env.DRAKEN_TLS_CA));
  res.set({ 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="draken-local-root.crt"', 'X-Content-Type-Options': 'nosniff' });
  res.send(certificate.raw);
}));
router.get('/syncs/:syncId/history', route((req, res) => {
  const syncId = Number(req.params.syncId);
  if (!Number.isSafeInteger(syncId) || syncId < 1) throw new HttpError(400, 'Invalid sync ID');
  res.json([...legacyCallHistory(syncId), ...liveHistory(syncId)].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 10));
}));

export default router;
