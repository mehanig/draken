import type { Request, Response, RequestHandler } from 'express';

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

export function route(handler: Handler): RequestHandler {
  return (req, res, next) => { void Promise.resolve().then(() => handler(req, res)).catch(next); };
}

export async function connected<T>(res: Response, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', close);
  if (res.destroyed) controller.abort();
  try { return await operation(controller.signal); }
  finally { res.off('close', close); }
}
