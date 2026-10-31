import { Router, Request, Response, NextFunction, raw } from 'express';
import { HttpError } from '../sync/store';
import fs from 'fs';
import { X509Certificate } from 'crypto';
import { cleanText } from '../sync/normalize';
import { voiceStatus, startCall, heartbeat, transcribe, reply, interruptCall, endCall, getAudio, played, callHistory } from '../voice/calls';

const router = Router();
const route = (handler: (req: Request, res: Response) => unknown | Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { Promise.resolve().then(() => handler(req, res)).catch(error => {
    if (!res.headersSent) next(error);
    else if (!res.writableEnded && !res.destroyed) { res.write(JSON.stringify({ type: 'error', error: 'The call disconnected. Please try again.' }) + '\n'); res.end(); }
  }); };
function integer(value: unknown, allowZero = false): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) throw new HttpError(400, 'Invalid call resource ID');
  return number;
}
function callId(req: Request): string {
  const id = String(req.params.id);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, 'Invalid call ID');
  return id;
}
function connection(res: Response) {
  const controller = new AbortController();
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', close);
  return { signal: controller.signal, cleanup: () => res.off('close', close) };
}
router.get('/status', route((_req, res) => res.json({ ...voiceStatus(), certificateAvailable: Boolean(process.env.DRAKEN_TLS_CA && fs.existsSync(process.env.DRAKEN_TLS_CA)) })));
router.get('/certificate', route((_req, res) => {
  if (!process.env.DRAKEN_TLS_CA) throw new HttpError(404, 'No local certificate download is configured');
  // Re-encode only the public certificate; never serve a key or an arbitrary source file.
  const certificate = new X509Certificate(fs.readFileSync(process.env.DRAKEN_TLS_CA));
  res.set({ 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="draken-local-root.crt"', 'X-Content-Type-Options': 'nosniff' });
  res.send(certificate.raw);
}));
router.get('/syncs/:syncId/history', route((req, res) => res.json(callHistory(integer(req.params.syncId)))));
router.post('/calls', route(async (req, res) => {
  const client = connection(res);
  try { res.status(201).json(await startCall(integer(req.body?.syncId), client.signal)); }
  finally { client.cleanup(); }
}));
router.post('/calls/:id/heartbeat', route((req, res) => res.json(heartbeat(callId(req)))));
router.post('/calls/:id/interrupt', route((req, res) => { interruptCall(callId(req)); res.sendStatus(204); }));
router.post('/calls/:id/end', route((req, res) => { endCall(callId(req)); res.sendStatus(204); }));
router.post('/calls/:id/transcribe', raw({ type: 'audio/wav', limit: 1_500_000 }), route(async (req, res) => {
  const client = connection(res);
  try { res.json(await transcribe(callId(req), req.body, client.signal)); }
  finally { client.cleanup(); }
}));
router.post('/calls/:id/turns', route(async (req, res) => {
  const message = req.body?.message;
  const requestId = req.body?.requestId;
  if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw new HttpError(400, 'Question must be 1 to 4000 characters');
  if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) throw new HttpError(400, 'A unique request ID is required');
  const client = connection(res);
  try {
    await reply(callId(req), cleanText(message.trim(), 4000), requestId, client.signal, event => {
      if (!res.headersSent) res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      if (!res.destroyed) res.write(JSON.stringify(event) + '\n');
    });
    res.end();
  } finally { client.cleanup(); }
}));
router.get('/calls/:id/audio/:turn/:index', route((req, res) => {
  const audio = getAudio(callId(req), integer(req.params.turn, true), integer(req.params.index, true));
  res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(audio);
}));
router.post('/calls/:id/played', route((req, res) => {
  played(callId(req), integer(req.body?.turnId, true), integer(req.body?.index, true)); res.sendStatus(204);
}));
export default router;
