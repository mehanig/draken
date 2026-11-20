import { Router } from 'express';
import { route, connected } from './http';
import { readFactory } from '../factory/service';
const router = Router();
router.get('/', route((req, res) => connected(res, async signal => {
  res.json(await readFactory(req.query.before === undefined ? undefined : Number(req.query.before), signal));
})));
export default router;
