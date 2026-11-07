import { getDb } from '../db/schema';
import { getSync } from '../sync/store';
import { invalidateRecap } from '../sync/recap';

/** Data compatibility only. The removed local speech engine cannot start or run here. */
export function legacyCallHistory(syncId: number) {
  getSync(syncId);
  return (getDb().prepare('SELECT id, status, started_at, ended_at, end_reason FROM voice_calls WHERE sync_id = ? ORDER BY started_at DESC LIMIT 10').all(syncId) as any[])
    .map(call => ({ ...call, mode: 'legacy' as const, turns: getDb().prepare('SELECT id, question, answer, heard_text, status, error, evidence_json, model_ms, first_audio_ms FROM voice_turns WHERE call_id = ? ORDER BY id').all(call.id) }));
}

/** Preserve unfinished historical exchanges after an upgrade; never resume speech. */
export function recoverLegacyCalls() {
  const db = getDb();
  db.transaction(() => {
    const now = new Date().toISOString();
    for (const call of db.prepare("SELECT id, sync_id FROM voice_calls WHERE status = 'active'").all() as any[]) {
      for (const turn of db.prepare('SELECT * FROM voice_turns WHERE call_id = ? AND messages_saved = 0').all(call.id) as any[]) {
        const refs: string[] = JSON.parse(turn.evidence_json);
        const heard = turn.heard_text ? `${turn.heard_text}${refs.length ? ' ' + refs.map(ref => `[${ref}]`).join(' ') : ''}` : '';
        const answer = `[Voice reply interrupted; ${heard ? 'only these complete sentences were confirmed played' : 'no complete sentence was confirmed played'}.]\n${heard}`.trim();
        const insert = db.prepare('INSERT INTO sync_messages(sync_id, role, content, created_at) VALUES (?, ?, ?, ?)');
        insert.run(call.sync_id, 'user', turn.question, now);
        insert.run(call.sync_id, 'assistant', answer, now);
        db.prepare("UPDATE voice_turns SET status = 'interrupted', completed_at = ?, messages_saved = 1 WHERE id = ?").run(now, turn.id);
        invalidateRecap(call.sync_id);
      }
    }
    db.prepare("UPDATE voice_calls SET status = 'interrupted', ended_at = ?, end_reason = 'Server restarted; local speech retired' WHERE status = 'active'").run(now);
  })();
}
