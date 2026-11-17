import type { Request, Response, RequestHandler } from 'express';
import { activity } from '../sync/activity';

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

export function route(handler: Handler): RequestHandler {
  return (req, res, next) => {
    // Own the entire handler, not the socket: disconnect does not mean that a
    // scan/native drain has finished. Preview itself must not cancel its owner.
    const mutation = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method) && req.path.replace(/\/+$/, '') !== '/preparation-preview';
    let release: (() => void) | undefined;
    try { if (mutation) release = activity.beginMutation(); } catch (error) { next(error); return; }
    void Promise.resolve().then(async () => {
      if (mutation) { await activity.drainPreview(); activity.assertAccepting(); }
      return handler(req, res);
    }).finally(() => release?.()).catch(next);
  };
}

export async function connected<T>(res: Response, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', close);
  if (res.destroyed) controller.abort();
  try { return await operation(controller.signal); }
  finally { res.off('close', close); }
}
