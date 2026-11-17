import { getDb } from '../db/schema';
import type { CallReadiness } from '../types';
import { assertEvidenceAvailable, getSync, requireOpen } from './store';
import { activity } from './activity';
import { HttpError } from '../errors';
import { historyReadiness, prepareHistory } from '../memory/service';
import { assertConversationActive, conversationStatus, expireConversations, markConversationPrepared } from './conversation';

const jobs = new Map<number, { done: Promise<void> }>();
const failures = new WeakMap<ReturnType<typeof getDb>, Map<number, string>>();
function errors() { const db = getDb(); let map = failures.get(db); if (!map) { map = new Map(); failures.set(db, map); } return map; }

export function callReadiness(id: number, _capturedOnly = false): CallReadiness {
  const row = getDb().prepare('SELECT status,briefing,compression_complete FROM syncs WHERE id=?').get(id) as { status: string; briefing: string; compression_complete: number } | undefined;
  if (!row) throw new HttpError(404, 'Sync not found');
  const conversation = conversationStatus(id);
  const briefingReady = row.status === 'open' && !conversation.ended_at && Boolean(row.briefing) && Boolean(row.compression_complete);
  const preparing = jobs.has(id), busy = activity.jobActive(id) || activity.voiceActive(id);
  // Text and voice share the durable initial preparation, including fallback
  // history. New arrivals cannot revoke it, and polling cannot adopt a newer
  // receipt. Original snapshot verification remains a write-admission check.
  const history = briefingReady && !busy
    ? { ready: Boolean(conversation.history_before), before: conversation.history_before }
    : { ready: false, before: null };
  return { ready: briefingReady && history.ready && !busy, briefingReady, historyReady: history.ready, preparing, before: history.before, error: errors().get(id) || '' };
}

/** Explicit, cancellable preparation outside a voice reservation. Background
 * indexing writes the same readiness receipt, without invoking any provider. */
export function prepareCall(id: number) {
  assertConversationActive(id);
  const sync = requireOpen(id);
  assertEvidenceAvailable(sync);
  if (!sync.briefing || !sync.tree.complete) throw new HttpError(409, 'Prepare the briefing before preparing a call.');
  const controller = new AbortController(), failed = errors();
  const release = activity.beginJob(id, controller);
  const job = { done: Promise.resolve() };
  failed.delete(id); jobs.set(id, job);
  job.done = Promise.resolve().then(async () => {
    const before = new Date().toISOString();
    await prepareHistory(before, controller.signal);
    controller.signal.throwIfAborted();
    // The receipt can retain an earlier unchanged cutoff; never claim the
    // requested cutoff was indexed if preparation reused that receipt.
    const prepared = historyReadiness(true);
    if (!prepared.ready || !prepared.before) throw new Error('History preparation did not produce a ready receipt');
    markConversationPrepared(id, prepared.before);
  }).catch(() => {
    if (failed.size >= 128) failed.delete(failed.keys().next().value!);
    failed.set(id, controller.signal.aborted ? 'History preparation stopped. Completed work is kept.' : 'History could not be prepared. Check the original session files, then retry. Completed work is kept.');
  }).finally(() => { if (jobs.get(id) === job) jobs.delete(id); release(); expireConversations(); });
  return getSync(id, false);
}

export async function prepareCallAndWait(id: number) {
  prepareCall(id);
  await jobs.get(id)?.done;
  return getSync(id);
}
