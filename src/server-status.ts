import { serverTarget } from './server-state';

export type ServerTarget = ReturnType<typeof serverTarget>;

/** Connectivity only. Never obtains credentials, follows redirects, or calls models. */
export async function probeServer(target: ServerTarget): Promise<{ instance?: string }> {
  const response = await fetch(target.url + '/api/auth/status', { signal: AbortSignal.timeout(2500), redirect: 'error' });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Server did not respond as Draken'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) throw new Error('Oversized server status');
      chunks.push(part.value);
    }
    const identity = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (identity.application !== 'draken') throw new Error('Server did not respond as Draken');
    if (target.instance && identity.instance !== target.instance) throw new Error('Different server instance');
    return { instance: typeof identity.instance === 'string' ? identity.instance : undefined };
  } finally { await reader.cancel().catch(() => {}); }
}
