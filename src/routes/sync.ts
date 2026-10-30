import { Router, Request, Response, NextFunction } from 'express';
import { scanSessions } from '../sync/collector';
import { completeSync, discardSync, getSync, HttpError, overview, saveNotes, setIncluded, startSync } from '../sync/store';
import { generateReply } from '../sync/manager';

const router = Router();
const route = (handler: (req: Request, res: Response) => unknown | Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { Promise.resolve().then(() => handler(req, res)).catch(next); };
function id(req: Request): number {
  const value = Number(req.params.id);
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, 'Invalid sync ID');
  return value;
}
function text(value: unknown, name: string, max = 4000): string {
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${name} must be text of at most ${max} characters`);
  return value.trim();
}
function consent(req: Request): void {
  if (req.body?.consent !== true) throw new HttpError(400, 'Explicit consent is required to send this snapshot to your configured pi model');
}

router.get('/overview', route((_req, res) => res.json(overview())));
router.post('/scan', route(async (_req, res) => res.json(await scanSessions())));
router.patch('/sessions/:sessionId', route((req, res) => {
  if (typeof req.body?.included !== 'boolean') throw new HttpError(400, 'included must be a boolean');
  setIncluded(String(req.params.sessionId), req.body.included);
  res.json(overview());
}));
router.post('/syncs', route(async (req, res) => {
  const since = req.body?.history_since;
  if (since !== undefined && since !== null && typeof since !== 'string') throw new HttpError(400, 'history_since must be a date string or null');
  const scan = await scanSessions();
  res.json({ sync: startSync(since), scan });
}));
router.get('/syncs/:id', route((req, res) => res.json(getSync(id(req)))));
router.patch('/syncs/:id/notes', route((req, res) => {
  res.json(saveNotes(id(req), text(req.body?.decisions, 'Decisions'), text(req.body?.carry_forward, 'Carry forward')));
}));
router.post('/syncs/:id/briefing', route(async (req, res) => {
  consent(req);
  res.json(await generateReply(id(req)));
}));
router.post('/syncs/:id/messages', route(async (req, res) => {
  consent(req);
  const question = text(req.body?.message, 'Message');
  if (!question) throw new HttpError(400, 'Message cannot be empty');
  res.json(await generateReply(id(req), question));
}));
router.post('/syncs/:id/complete', route((req, res) => {
  res.json(completeSync(id(req), text(req.body?.decisions, 'Decisions'), text(req.body?.carry_forward, 'Carry forward'), req.body?.reviewed === true));
}));
router.post('/syncs/:id/discard', route((req, res) => res.json(discardSync(id(req)))));

export default router;
