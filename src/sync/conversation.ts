import { getDb } from '../db/schema';
import { HttpError } from '../errors';
import type { ConversationState } from '../types';
import { historyProgress, historyReadiness, historyPreparationStatus } from '../memory/service';
import { activity } from './activity';
import { backgroundUpdateStatus } from './update-status';

const IDLE_MS = 30 * 60_000;
interface Row {
  id: number; status: string; created_at: string;
  conversation_last_user_at: string | null;
  conversation_ended_at: string | null;
  conversation_before: string | null;
}
function row(id: number): Row {
  const value = getDb().prepare(`SELECT id,status,created_at,conversation_last_user_at,
    conversation_ended_at,conversation_before FROM syncs WHERE id=?`).get(id) as Row | undefined;
  if (!value) throw new HttpError(404, 'Sync not found');
  return value;
}
function deadline(value: Row): number { return Date.parse(value.conversation_last_user_at || value.created_at) + IDLE_MS; }
function inFlight(id: number): boolean { return activity.jobActive(id) || activity.voiceTurnActive(id); }
function ended(value: Row, now: number): string | null {
  return value.conversation_ended_at || (value.status === 'open' && deadline(value) <= now && !inFlight(value.id)
    ? new Date(deadline(value)).toISOString() : null);
}

/** Recorded progress only. Full history validation belongs at use boundaries,
 * not UI polling. Never adopts a cutoff, touches the idle clock or starts work. */
export function conversationStatuses(ids: number[]): ConversationState[] {
  let shared: { history: ReturnType<typeof historyReadiness>; progress: ReturnType<typeof historyProgress>;
    enabled: boolean; background: ReturnType<typeof backgroundUpdateStatus> } | undefined;
  const now = Date.now();
  return ids.map(id => {
    const value = row(id), end = ended(value, now);
    const base = { last_user_at: value.conversation_last_user_at || value.created_at,
      expires_at: new Date(deadline(value)).toISOString(), ended_at: end, history_before: value.conversation_before };
    if (end || value.status !== 'open') return Object.freeze({ ...base, available_before: null, update_state: 'paused', error: '' });
    const { history, progress, enabled, background } = shared ||= {
      history: historyPreparationStatus(), progress: historyProgress(), background: backgroundUpdateStatus(),
      enabled: (getDb().prepare("SELECT value FROM sync_settings WHERE key='auto_index'").get() as { value: string } | undefined)?.value === 'true',
    };
    const available = history.ready ? history.before : null;
    let update_state: ConversationState['update_state'], error = '';
    if (!value.conversation_before && activity.jobActive(id)) update_state = 'preparing';
    else if (!enabled) update_state = 'paused';
    else if (background?.phase === 'error' || background?.error) {
      update_state = 'error';
      error = 'Live updates could not finish. Check session sources and local model availability. Completed history is retained; automatic indexing will retry.';
    } else if (available && (!value.conversation_before || available > value.conversation_before)) update_state = 'new_info';
    else {
      const preparing = (progress.active && progress.work?.stage !== 'searching' && progress.work?.stage !== 'reading')
        || progress.queued > 0 || background?.phase === 'scanning' || background?.phase === 'indexing'
        || (background?.pending_records || 0) > 0;
      update_state = preparing || !history.ready ? 'preparing' : 'up_to_date';
    }
    return Object.freeze({ ...base, available_before: available, update_state, error });
  });
}

export function conversationStatus(id: number): ConversationState {
  return conversationStatuses([id])[0];
}

/** Write admission/timer cleanup, independent of explicit review and coverage. */
export function expireConversations(now = Date.now()): void {
  const db = getDb();
  const rows = db.prepare(`SELECT id,status,created_at,conversation_last_user_at,conversation_ended_at,conversation_before
    FROM syncs WHERE status='open' AND conversation_ended_at IS NULL
    AND COALESCE(conversation_last_user_at,created_at)<=?`).all(new Date(now - IDLE_MS).toISOString()) as Row[];
  const save = db.prepare('UPDATE syncs SET conversation_ended_at=? WHERE id=? AND conversation_ended_at IS NULL');
  db.transaction(() => { for (const value of rows) if (!inFlight(value.id)) save.run(new Date(now).toISOString(), value.id); })();
}

export function assertConversationActive(id: number): void {
  expireConversations();
  const value = row(id);
  if (value.conversation_ended_at) throw new HttpError(410, 'This conversation ended after 30 minutes without a user turn. Start a new sync to continue; the transcript and notes are preserved.');
  if (value.status !== 'open') throw new HttpError(409, 'This sync is already closed. Start a new sync to continue.');
}

/** Call only in the same transaction as accepting a NEW real user turn. */
export function touchConversation(id: number, at = Date.now()): void {
  assertConversationActive(id);
  getDb().prepare(`UPDATE syncs SET conversation_last_user_at=MAX(COALESCE(conversation_last_user_at,created_at),?)
    WHERE id=? AND status='open' AND conversation_ended_at IS NULL`).run(new Date(at).toISOString(), id);
}

/** Turn admission only. Never turns a never-prepared conversation into a ready
 * one merely because another conversation/background job prepared the corpus. */
export function captureConversationHistory(id: number): string | null {
  assertConversationActive(id);
  const value = row(id);
  if (!value.conversation_before) return null;
  const latest = historyPreparationStatus();
  const before = latest.ready && latest.before && latest.before > value.conversation_before ? latest.before : value.conversation_before;
  if (before !== value.conversation_before) getDb().prepare('UPDATE syncs SET conversation_before=? WHERE id=?').run(before, id);
  return before;
}

/** Initial explicit preparation success only; background work cannot revive or
 * prepare a conversation, and subsequent preparation cannot move its cutoff. */
export function markConversationPrepared(id: number, before: string): void {
  assertConversationActive(id);
  if (!Number.isFinite(Date.parse(before)) || new Date(before).toISOString() !== before) throw new Error('Invalid prepared history cutoff');
  getDb().prepare('UPDATE syncs SET conversation_before=? WHERE id=? AND conversation_before IS NULL').run(before, id);
}
