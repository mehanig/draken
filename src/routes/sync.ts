import { Router, Request, Response, NextFunction } from 'express';
import { getDb, getDataDir } from '../db/schema';
import { piSetupStatus } from '../pi/runtime';
import { scanSessions } from '../sync/collector';
import { completeSync, configureModels, discardSync, expandSnapshot, getProgress, getSync, getTreeNode, homeOverview, HttpError, overview, saveNotes, setIncluded, setAgentEnabled, startSync, startConversationSync, busySyncs, activeVoiceSyncs } from '../sync/store';
import { cancelReply, launchReply, launchRecap } from '../sync/manager';
import { autoIndexSettings, setAutoIndex, yieldBackgroundIndexing } from '../memory/automatic';
import { callReadiness, prepareCall } from '../voice/preparation';

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

router.get('/setup', route(async (req, res) => {
  if (Object.keys(req.query).some(key => key !== 'refresh') || (req.query.refresh !== undefined && req.query.refresh !== '1')) throw new HttpError(400, 'Unknown setup status option');
  res.json({ pi: await piSetupStatus(req.query.refresh === '1'), data_dir: getDataDir() });
}));
router.get('/settings/auto-index', route((_req, res) => res.json(autoIndexSettings())));
router.patch('/settings/auto-index', route((req, res) => {
  if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'enabled')) throw new HttpError(400, 'Only enabled is accepted');
  res.json(setAutoIndex(req.body.enabled));
}));
router.use((req, _res, next) => { if (['POST', 'PATCH', 'DELETE'].includes(req.method)) yieldBackgroundIndexing(); next(); });

router.get('/home', route((req, res) => {
  const before = req.query.before === undefined ? undefined : Number(req.query.before);
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new HttpError(400, 'Invalid history cursor');
  res.json(homeOverview(before));
}));
async function completeScan() {
  const scan = await scanSessions();
  if (scan.warnings.length) throw new HttpError(409, 'History import could not finish. Check session sources and scan again; no new snapshot was prepared.');
  return scan;
}
let starting = false;
router.post('/syncs/start-call', route(async (req, res) => {
  const requestId = req.body?.request_id;
  if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(requestId)) throw new HttpError(400, 'A request ID is required');
  // One scan/start operation at a time, including the async indexing interval.
  if (starting) throw new HttpError(409, 'A sync is already being prepared');
  const prior = getDb().prepare('SELECT sync_id FROM sync_presentations WHERE request_id=?').get(requestId) as { sync_id: number } | undefined;
  if (prior) { res.status(202).json({ sync: getSync(prior.sync_id), scan: { files: 0, added: 0, warnings: [] } }); return; }
  if (busySyncs.size || activeVoiceSyncs.size) throw new HttpError(409, 'End the active call or wait for preparation before starting another sync.');
  starting = true;
  try {
    const setup = await piSetupStatus(true);
    if (setup.state !== 'configured') throw new HttpError(503, setup.message);
    const scan = await completeScan(), sync = startConversationSync(requestId);
    res.status(202).json({ sync: launchReply(sync.id), scan });
  } finally { starting = false; }
}));
router.post('/syncs/:id/recap', route((req, res) => res.status(202).json(launchRecap(id(req)))));
router.get('/overview', route((_req, res) => res.json(overview())));
router.patch('/agents/:agent', route((req, res) => {
  if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.enabled !== 'boolean') throw new HttpError(400, 'Only boolean enabled is accepted');
  res.json(setAgentEnabled(String(req.params.agent), req.body.enabled));
}));
router.post('/scan', route(async (_req, res) => res.json(await scanSessions())));
router.patch('/sessions/:sessionId', route((req, res) => {
  if (typeof req.body?.included !== 'boolean') throw new HttpError(400, 'included must be a boolean');
  setIncluded(String(req.params.sessionId), req.body.included);
  res.json(overview());
}));
router.post('/syncs', route(async (req, res) => {
  const since = req.body?.history_since;
  if (since !== undefined && since !== null && typeof since !== 'string') throw new HttpError(400, 'history_since must be a date string or null');
  const scan = await completeScan();
  res.json({ sync: startSync(since), scan });
}));
router.get('/syncs/:id', route((req, res) => res.json(getSync(id(req)))));
router.get('/syncs/:id/progress', route((req, res) => res.json(getProgress(id(req)))));
router.get('/syncs/:id/call-readiness', route((req, res) => res.json(callReadiness(id(req)))));
router.post('/syncs/:id/prepare-call', route((req, res) => res.status(202).json(prepareCall(id(req)))));
router.get('/syncs/:id/tree/:key', route((req, res) => res.json(getTreeNode(id(req), String(req.params.key)))));
router.post('/syncs/:id/expand', route(async (req, res) => {
  const scan = await completeScan();
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
  if (Object.keys(req.body).some(key => key !== 'message')) throw new HttpError(400, 'Unknown discussion option. Refresh the page.');
  res.status(202).json(launchReply(id(req), question));
}));
router.post('/syncs/:id/complete', route((req, res) => {
  res.json(completeSync(id(req), text(req.body?.decisions, 'Decisions'), text(req.body?.carry_forward, 'Carry forward'), req.body?.reviewed === true));
}));
router.post('/syncs/:id/discard', route((req, res) => res.json(discardSync(id(req)))));

export default router;
