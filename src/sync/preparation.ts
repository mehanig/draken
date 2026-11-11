import { getDb } from '../db/schema';
import type { CallReadiness } from '../types';
import { assertEvidenceAvailable, getSync, requireOpen } from './store';
import { activity } from './activity';
import { HttpError } from '../errors';
import { historyReadiness, prepareHistory } from '../memory/service';

const jobs = new Map<number, { done: Promise<void> }>();
const failures = new WeakMap<ReturnType<typeof getDb>, Map<number, string>>();
function errors() { const db = getDb(); let map = failures.get(db); if (!map) { map = new Map(); failures.set(db, map); } return map; }

export function callReadiness(id: number, capturedOnly = false): CallReadiness {
  const row = getDb().prepare('SELECT status,briefing,compression_complete FROM syncs WHERE id=?').get(id) as { status: string; briefing: string; compression_complete: number } | undefined;
  if (!row) throw new HttpError(404, 'Sync not found');
  const briefingReady = row.status === 'open' && Boolean(row.briefing) && Boolean(row.compression_complete);
  const preparing = jobs.has(id), busy = activity.jobActive(id) || activity.voiceActive(id);
  const history = briefingReady && !busy ? historyReadiness(capturedOnly) : { ready: false, before: null };
  return { ready: briefingReady && history.ready && !busy, briefingReady, historyReady: history.ready, preparing, before: history.before, error: errors().get(id) || '' };
}

/** Explicit, cancellable preparation outside a voice reservation. Background
 * indexing writes the same readiness receipt, without invoking any provider. */
export function prepareCall(id: number) {
  const sync = requireOpen(id);
  assertEvidenceAvailable(sync);
  if (!sync.briefing || !sync.tree.complete) throw new HttpError(409, 'Prepare the briefing before preparing a call.');
  const controller = new AbortController(), failed = errors();
  const release = activity.beginJob(id, controller);
  const job = { done: Promise.resolve() };
  failed.delete(id); jobs.set(id, job);
  job.done = Promise.resolve().then(() => prepareHistory(new Date().toISOString(), controller.signal)).catch(() => {
    if (failed.size >= 128) failed.delete(failed.keys().next().value!);
    failed.set(id, controller.signal.aborted ? 'History preparation stopped. Completed work is kept.' : 'History could not be prepared. Check the original session files, then retry. Completed work is kept.');
  }).finally(() => { if (jobs.get(id) === job) jobs.delete(id); release(); });
  return getSync(id);
}

export async function prepareCallAndWait(id: number) {
  prepareCall(id);
  await jobs.get(id)?.done;
  return getSync(id);
}
