// Application wiring, deliberately outside the isolated evidence module.
import type { EvidenceDependencies } from './evidence';
import { readHistory, searchPreparedHistory } from './memory/service';
import { cleanText } from './sync/normalize';
import { getDb } from './db/schema';
import { recentSession } from './sources/activity-window';

export const evidenceDependencies: EvidenceDependencies = {
  sessions: async signal => {
    signal.throwIfAborted();
    return getDb().prepare(`SELECT s.id,s.cwd workspace,s.name title FROM agent_sessions s JOIN agent_sources a ON a.id=s.agent
      WHERE s.included=1 AND s.missing=0 AND a.enabled=1 AND ${recentSession('s')} ORDER BY s.id`).all() as { id: string; workspace: string; title: string }[];
  },
  search: (query, signal) => searchPreparedHistory(query, signal),
  read: (ref, offset, signal, before) => readHistory(ref, offset, signal, before),
  cleanText,
};

/** Actual user turns only. Collapse mirrored voice text; interpretation belongs to the module. */
export function evidenceQuestions(syncId: number, textId = -1, voiceId = -1): string[] {
  const db = getDb();
  const current = (textId !== -1 ? db.prepare('SELECT created_at at FROM sync_messages WHERE id=?').get(textId)
    : db.prepare('SELECT started_at at FROM live_messages WHERE id=?').get(voiceId)) as { at: string } | undefined;
  const before = current?.at || new Date().toISOString();
  return (db.prepare(`SELECT content,MAX(at) at FROM (
    SELECT content,created_at at FROM sync_messages WHERE sync_id=? AND role='user' AND created_at<?
    UNION ALL SELECT m.text content,m.started_at at FROM live_messages m JOIN live_calls c ON c.id=m.call_id
      WHERE c.sync_id=? AND m.role='user' AND m.status='generated' AND m.started_at<?
  ) GROUP BY content ORDER BY at DESC LIMIT 6`).all(syncId, before, syncId, before) as { content: string }[]).reverse().map(row => row.content);
}
