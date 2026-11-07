import { Router, Request, Response, NextFunction } from 'express';
import { HttpError } from '../sync/store';
import { createLiveCall, connectLiveCall, liveEvents, sendLiveText, interruptLiveCall, endLiveCall, observeLiveAudio } from '../voice/live';
const router = Router();
const route = (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve().then(() => fn(req, res)).catch(next); };
const id = (value: unknown) => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new HttpError(400, 'Invalid call identifier'); return value; };
const number = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, 'Invalid live call resource'); return n; };
async function connected(res: Response, fn: (signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController(); const close = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', close);
  if (res.destroyed) controller.abort();
  try { return await fn(controller.signal); } finally { res.off('close', close); }
}
router.post('/calls', route(async (req, res) => {
  if (Object.keys(req.body || {}).some(key => !['syncId', 'requestId'].includes(key))) throw new HttpError(400, 'Unknown call option. Refresh the page.');
  const requestId = req.body?.requestId === undefined ? undefined : id(req.body.requestId);
  const result = await connected(res, signal => createLiveCall(number(req.body?.syncId, 1), signal, requestId)); res.status(201).json(result);
}));
router.post('/calls/:id/connect', route(async (req, res) => {
  if (typeof req.body?.sdp !== 'string' || req.body.sdp.length > 28000) throw new HttpError(400, 'Invalid audio offer');
  res.json(await connected(res, signal => connectLiveCall(id(req.params.id), req.body.sdp, signal)));
}));
router.get('/calls/:id/events', route((req, res) => res.json(liveEvents(id(req.params.id), number(req.query.after || 0)))));
router.post('/calls/:id/text', route(async (req, res) => {
  if (typeof req.body?.question !== 'string' || !req.body.question.trim() || req.body.question.length > 2000) throw new HttpError(400, 'Question must be 1 to 2000 characters');
  await sendLiveText(id(req.params.id), req.body.question, id(req.body.requestId)); res.sendStatus(204);
}));
router.post('/calls/:id/interrupt', route(async (req, res) => { await interruptLiveCall(id(req.params.id)); res.sendStatus(204); }));
router.post('/calls/:id/observed', route((req, res) => { observeLiveAudio(id(req.params.id), number(req.body?.messageId, 1), number(req.body?.milliseconds, 0, 1800000)); res.sendStatus(204); }));
router.post('/calls/:id/end', route(async (req, res) => { await endLiveCall(id(req.params.id)); res.sendStatus(204); }));
export default router;
