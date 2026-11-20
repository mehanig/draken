import { Router } from 'express';
import { route, connected } from './http';
import { readFactory } from '../factory/service';
import { readExecution, startExecution, cancelExecution } from '../factory/execution';
import { readWorkspaces, startWorkspace, cancelWorkspace, workspaceLog } from '../factory/workspace';
const router = Router();
router.get('/workspaces', route((_req, res) => { res.json(readWorkspaces()); }));
router.get('/workspaces/:id/log', route((req, res) => { res.json(workspaceLog(String(req.params.id))); }));
router.post('/workspaces', route(async (req, res) => { res.status(202).json(await startWorkspace(req.body)); }));
router.post('/workspaces/:id/cancel', route((req, res) => { cancelWorkspace(String(req.params.id)); res.status(204).end(); }));
router.get('/execution', route((_req, res) => connected(res, async signal => { res.json(await readExecution(signal)); })));
router.post('/execution/runs', route((req, res) => connected(res, async signal => {
  res.status(202).json(await startExecution(req.body, req.headers.authorization?.replace(/^Bearer /, '') || '', signal));
})));
router.post('/execution/runs/:id/cancel', route(async (req, res) => {
  await cancelExecution(String(req.params.id)); res.status(204).end();
}));
router.get('/', route((req, res) => connected(res, async signal => {
  res.json(await readFactory(req.query.before === undefined ? undefined : Number(req.query.before), signal));
})));
export default router;
