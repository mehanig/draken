import { prepareProcedureEvidence, type ProcedureRecord, type EvidenceDependencies } from './evidence';
import { EvidenceReader } from './db/evidence';
import { EvidenceScope } from './sync/evidence-scope';
import { assertRecentSessions } from './sources/activity-window';
import { sourceKey } from './sync/normalize';
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

/** Revalidate every frozen summary input, including uncited context, without a transcript archive. */
export async function readWorkflowOriginals(pointers: Record<string, unknown>[], signal: AbortSignal): Promise<ProcedureRecord[]> {
  const db = getDb(), reader = new EvidenceReader(db), scope = new EvidenceScope(db, []);
  const since = (db.prepare("SELECT value FROM sync_settings WHERE key='history_since'").get() as { value: string } | undefined)?.value || '';
  const records: ProcedureRecord[] = [];
  let count = 0;
  try {
    for (const pointer of pointers) {
      if (++count % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      signal.throwIfAborted(); scope.assert(pointer);
      const item = reader.read(pointer);
      assertRecentSessions(db, [item.session_id]);
      if (item.timestamp < since) throw Error('Workflow source is outside the history baseline');
      const ref = sourceKey(item);
      const sequence = (db.prepare('SELECT id FROM agent_entries WHERE session_id=? AND entry_id=?').get(item.session_id, item.entry_id) as { id: number }).id;
      const packet = await prepareProcedureEvidence({ sessionId: item.session_id, before: item.timestamp, refs: [ref], signal }, {
        cleanText,
        read: async () => {
          signal.throwIfAborted(); scope.assert(pointer);
          return { ref, sessionId: item.session_id, sequence, at: item.timestamp, role: item.role, text: item.text };
        },
      });
      records.push(...packet.records);
    }
    signal.throwIfAborted();
    const currentSince = (db.prepare("SELECT value FROM sync_settings WHERE key='history_since'").get() as { value: string } | undefined)?.value || '';
    assertRecentSessions(db, [...new Set(records.map(record => record.sessionId))]);
    for (const pointer of pointers) scope.assert(pointer);
    if (records.some(record => record.at < currentSince)) throw Error('Workflow history baseline changed');
    return records;
  } finally { reader.close(); }
}

function discussionBefore(textId: number, voiceId: number): string {
  const db = getDb();
  const current = (textId !== -1 ? db.prepare('SELECT created_at at FROM sync_messages WHERE id=?').get(textId)
    : db.prepare('SELECT started_at at FROM live_messages WHERE id=?').get(voiceId)) as { at: string } | undefined;
  return current?.at || new Date().toISOString();
}
/** Conversation is context for follow-ups, never source proof or action authority. */
export function evidenceDiscussion(syncId: number, textId = -1, voiceId = -1): { role: string; text: string }[] {
  return (getDb().prepare('SELECT role,content FROM sync_messages WHERE sync_id=? AND created_at<? ORDER BY id DESC LIMIT 12')
    .all(syncId, discussionBefore(textId, voiceId)) as { role: string; content: string }[]).reverse()
    .map(m => ({ role: m.role, text: cleanText(m.content, 1000) }));
}
/** Actual user turns only. Collapse mirrored voice text; interpretation belongs to the module. */
export function evidenceQuestions(syncId: number, textId = -1, voiceId = -1): string[] {
  const db = getDb(), before = discussionBefore(textId, voiceId);
  return (db.prepare(`SELECT content,MAX(at) at FROM (
    SELECT content,created_at at FROM sync_messages WHERE sync_id=? AND role='user' AND created_at<?
    UNION ALL SELECT m.text content,m.started_at at FROM live_messages m JOIN live_calls c ON c.id=m.call_id
      WHERE c.sync_id=? AND m.role='user' AND m.status='generated' AND m.started_at<?
  ) GROUP BY content ORDER BY at DESC LIMIT 6`).all(syncId, before, syncId, before) as { content: string }[]).reverse().map(row => row.content);
}
