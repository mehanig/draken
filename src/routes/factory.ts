import { Router } from 'express';
import { route, connected } from './http';
import { readFactory } from '../factory/service';
import { readWorkspaces, saveExecutionSettings, startWorkspace, cancelWorkspace, workspaceLog } from '../factory/workspace';
import { prepareWorkflowEnrichment } from '../sync/summary-preparation';
const router = Router();
router.post('/:id/enrichment', route((req, res) => connected(res, async signal => {
  res.json(await prepareWorkflowEnrichment(String(req.params.id), req.body, signal));
})));
router.post('/workspaces/settings', route((req, res) => { saveExecutionSettings(req.body); res.status(204).end(); }));
router.get('/workspaces', route(async (_req, res) => { res.json(await readWorkspaces()); }));
router.get('/workspaces/:id/log', route(async (req, res) => { res.json(await workspaceLog(String(req.params.id))); }));
router.post('/workspaces', route(async (req, res) => { res.status(202).json(await startWorkspace(req.body, req.headers.authorization?.replace(/^Bearer /, '') || '')); }));
router.post('/workspaces/:id/cancel', route((req, res) => { cancelWorkspace(String(req.params.id)); res.status(204).end(); }));
router.get('/', route((req, res) => connected(res, async signal => {
  res.json(await readFactory(req.query.before === undefined ? undefined : Number(req.query.before), signal));
})));
export default router;
