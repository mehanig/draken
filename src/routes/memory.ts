import { Router, type Request, type Response, type NextFunction } from 'express';
import { historyProgress, readHistory, searchHistory, validateHistoryQuery } from '../memory/service';
import { yieldBackgroundIndexing } from '../memory/automatic';
const router = Router();
const route = (handler: (req: Request, res: Response, signal: AbortSignal) => unknown | Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  const abort = new AbortController(); const closed = () => { if (!res.writableEnded) abort.abort(); }; res.on('close', closed);
  void Promise.resolve().then(() => handler(req, res, abort.signal)).catch(next).finally(() => res.off('close', closed));
};
// Metadata only: never starts a worker, downloads a model or queues behind it.
router.get('/progress', (_req, res) => res.json(historyProgress()));
router.post('/search', route(async (req, res, signal) => {
  const query = validateHistoryQuery(req.body);
  await yieldBackgroundIndexing(); signal.throwIfAborted();
  res.json(await searchHistory(query, signal));
}));
router.get('/records/:ref', route(async (req, res, signal) => {
  await yieldBackgroundIndexing(); signal.throwIfAborted();
  res.json(await readHistory(String(req.params.ref), req.query.offset === undefined ? 0 : Number(req.query.offset), signal));
}));
export default router;
