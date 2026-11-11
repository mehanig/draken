import { Router } from 'express';
import { route, connected } from './http';
import { historyProgress, readHistory, searchHistory, validateHistoryQuery } from '../memory/service';
import { yieldBackgroundIndexing } from '../memory/automatic';
const router = Router();
// Metadata only: never starts a worker, downloads a model or queues behind it.
router.get('/progress', (_req, res) => res.json(historyProgress()));
router.post('/search', route((req, res) => connected(res, async signal => {
  const query = validateHistoryQuery(req.body);
  await yieldBackgroundIndexing(); signal.throwIfAborted();
  res.json(await searchHistory(query, signal));
})));
router.get('/records/:ref', route((req, res) => connected(res, async signal => {
  await yieldBackgroundIndexing(); signal.throwIfAborted();
  res.json(await readHistory(String(req.params.ref), req.query.offset === undefined ? 0 : Number(req.query.offset), signal));
})));
export default router;
