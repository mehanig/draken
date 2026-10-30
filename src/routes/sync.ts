import { Router, Request, Response, NextFunction } from 'express';
import { scanSessions } from '../sync/collector';
import { completeSync, configureModels, discardSync, expandSnapshot, getProgress, getSync, getTreeNode, HttpError, overview, saveNotes, setIncluded, startSync } from '../sync/store';
import { cancelReply, launchReply } from '../sync/manager';

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
router.get('/syncs/:id/progress', route((req, res) => res.json(getProgress(id(req)))));
router.get('/syncs/:id/tree/:key', route((req, res) => res.json(getTreeNode(id(req), String(req.params.key)))));
router.post('/syncs/:id/expand', route(async (req, res) => {
  const scan = await scanSessions();
  res.json({ sync: expandSnapshot(id(req)), scan });
}));
router.patch('/syncs/:id/models', route((req, res) => {
  res.json(configureModels(id(req), {
    summary: text(req.body?.summary, 'Summary model', 200),
    final: text(req.body?.final, 'Final model', 200),
    max_invocations: req.body?.max_invocations,
  }));
}));
router.post('/syncs/:id/cancel', route((req, res) => {
  cancelReply(id(req));
  res.status(202).json(getProgress(id(req)));
}));
router.patch('/syncs/:id/notes', route((req, res) => {
  res.json(saveNotes(id(req), text(req.body?.decisions, 'Decisions'), text(req.body?.carry_forward, 'Carry forward')));
}));
router.post('/syncs/:id/briefing', route((req, res) => {
  res.status(202).json(launchReply(id(req)));
}));
router.post('/syncs/:id/messages', route((req, res) => {
  const question = text(req.body?.message, 'Message');
  if (!question) throw new HttpError(400, 'Message cannot be empty');
  res.status(202).json(launchReply(id(req), question));
}));
router.post('/syncs/:id/complete', route((req, res) => {
  res.json(completeSync(id(req), text(req.body?.decisions, 'Decisions'), text(req.body?.carry_forward, 'Carry forward'), req.body?.reviewed === true));
}));
router.post('/syncs/:id/discard', route((req, res) => res.json(discardSync(id(req)))));

export default router;
