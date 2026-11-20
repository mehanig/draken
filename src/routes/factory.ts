import { Router } from 'express';
import { route, connected } from './http';
import { readFactory } from '../factory/service';
import { readExecution, startExecution, cancelExecution } from '../factory/execution';
const router = Router();
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
