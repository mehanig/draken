import type Database from 'better-sqlite3';
import { cleanText, digest } from '../sync/normalize';
import { EntryReader } from '../sync/source-files';
import { getSourceRoots, type RootInput } from '../sources/registry';
import { EvidenceReader } from '../db/evidence';
import type { NormalizationCache } from '../sync/jsonl';
import type { Evidence } from '../types';
import type { HistoryQuery, HistoryRecord } from './types';

export interface SourceRecord extends HistoryRecord { group: string; position: number; identity: string }

/** Read canonical metadata/frozen pointers and verified, admitted JSONL records.
 * No discovery, scan, recovery or application/source writes. Current exclusions
 * and baseline apply to archive retrieval, not to frozen pages. */
export function* historySources(db: Database.Database, root: RootInput = getSourceRoots(), cache?: NormalizationCache, scope: Partial<HistoryQuery> = {}): Generator<SourceRecord> {
  const sessions = new Map((db.prepare('SELECT s.id,s.included,s.missing,a.enabled FROM agent_sessions s JOIN agent_sources a ON a.id=s.agent').all() as { id: string; included: number; missing: number; enabled: number }[]).map(row => [row.id, row]));
  const baseline = (db.prepare("SELECT value FROM sync_settings WHERE key='history_since'").get() as { value: string } | undefined)?.value || '';
  const allowed = (session: string, at: string) => scope.kind !== 'conversation'
    && (!scope.session_id || session === scope.session_id) && (!scope.session_ids || scope.session_ids.includes(session))
    && (!scope.before || Boolean(at && at <= scope.before))
    && sessions.get(session)?.enabled === 1 && sessions.get(session)?.included === 1 && !sessions.get(session)?.missing && at >= baseline;
  const record = (key: string, data: Omit<SourceRecord, 'ref' | 'identity'>, identity?: string): SourceRecord => {
    const clean = { ...data, text: cleanText(data.text, Number.MAX_SAFE_INTEGER), title: cleanText(data.title, 180), workspace: cleanText(data.workspace, 300), role: cleanText(data.role, 40) };
    return { ...clean, identity: identity || digest(key + '\0' + clean.text), ref: `H${digest(JSON.stringify([key, clean])).slice(0, 24)}` };
  };
  const evidence = (item: Evidence, syncId: number): SourceRecord | undefined => {
    if (!allowed(item.session_id, item.timestamp) || !item.text.trim()) return;
    const key = digest(item.event_key + '\0' + cleanText(item.text, Number.MAX_SAFE_INTEGER));
    return record(`snapshot:${syncId}:${item.ref}`, { kind: 'snapshot', session_id: item.session_id, sync_id: syncId, origin_ref: item.ref,
      title: item.agent && item.agent !== 'pi' ? `${item.agent}: ${item.session_name || item.cwd}` : item.session_name || item.cwd, workspace: item.cwd, role: item.role, at: item.timestamp, text: item.text,
      qualification: 'Frozen session excerpt. Assistant claims are not independently verified; tool output proves only what is shown.',
      group: `session:${item.session_id}`, position: item.sequence || 0 }, key);
  };
  const frozen = new EvidenceReader(db, root, cache);
  try {
  for (const row of db.prepare("SELECT i.sync_id,i.evidence_json FROM sync_items i JOIN syncs s ON s.id=i.sync_id WHERE s.status!='discarded' ORDER BY i.sync_id,i.rowid").iterate() as Iterable<{ sync_id: number; evidence_json: string }>) {
    if (scope.sync_id && scope.sync_id !== row.sync_id) continue;
    const metadata = JSON.parse(row.evidence_json);
    if (!allowed(metadata.session_id, metadata.timestamp)) continue;
    const result = evidence(frozen.read(metadata), row.sync_id); if (result) yield result;
  }
  for (const row of db.prepare("SELECT id,status,completed_at,context_json,decisions,carry_forward FROM syncs WHERE status!='discarded' ORDER BY id").iterate() as Iterable<{ id: number; status: string; completed_at: string | null; context_json: string; decisions: string; carry_forward: string }>) {
    if (scope.sync_id && scope.sync_id !== row.id) continue;
    for (const item of JSON.parse(row.context_json) as Evidence[]) {
      if (!allowed(item.session_id, item.timestamp)) continue;
      const result = evidence(frozen.read(item), row.id); if (result) yield result;
    }
    for (const kind of ['decisions', 'carry_forward'] as const) if (scope.kind !== 'sources' && !scope.session_id && !scope.session_ids && (!scope.before || (row.completed_at && row.completed_at <= scope.before)) && row[kind].trim()) yield record(`${kind}:${row.id}`, {
      kind, sync_id: row.id, session_id: null, origin_ref: null, title: `Sync #${row.id} saved ${kind === 'decisions' ? 'decisions' : 'carry-forward'}`,
      workspace: '', role: 'saved_note', at: row.status === 'completed' ? row.completed_at : null, text: row[kind],
      qualification: row.status === 'completed' ? 'Explicitly saved note, frozen on completion; not proof the proposed work happened.' : 'Current saved note. Its edit time was not retained; do not infer when this decision was made.',
      group: `notes:${row.id}`, position: kind === 'decisions' ? 0 : 1 });
  }
  } finally { frozen.close(); }
  const reader = new EntryReader(db, root, cache);
  try {
  for (const row of db.prepare(`SELECT e.id,e.event_key,e.session_id,s.agent,s.name,s.cwd,e.role,e.timestamp
      FROM agent_entries e JOIN agent_sessions s ON s.id=e.session_id
      WHERE e.active=1 AND e.present=1 AND e.is_activity=1 AND e.effective_length>0 ORDER BY e.id`).iterate() as Iterable<{ id: number; event_key: string; session_id: string; agent: string; name: string; cwd: string; role: string; timestamp: string }>) {
    if (scope.sync_id || !allowed(row.session_id, row.timestamp)) continue;
    const text = reader.effective(row.id);
    const key = digest(row.event_key + '\0' + cleanText(text, Number.MAX_SAFE_INTEGER));
    yield record(`entry:${row.id}`, { kind: 'session', session_id: row.session_id, sync_id: null, origin_ref: null, title: row.agent !== 'pi' ? `${row.agent}: ${row.name || row.cwd}` : row.name || row.cwd,
      workspace: row.cwd, role: row.role, at: row.timestamp, text,
      qualification: 'Indexed active session excerpt, not a reviewed snapshot. Assistant claims are not independently verified.', group: `session:${row.session_id}`, position: row.id }, key);
  }
  } finally { reader.close(); }
  for (const row of db.prepare(`SELECT m.id,m.sync_id,m.role,m.content,m.created_at FROM sync_messages m JOIN syncs s ON s.id=m.sync_id WHERE s.status!='discarded' ORDER BY m.id`).iterate() as Iterable<{ id: number; sync_id: number; role: string; content: string; created_at: string }>) {
    if (scope.kind === 'sources' || scope.session_id || scope.session_ids || (scope.sync_id && scope.sync_id !== row.sync_id) || (scope.before && row.created_at > scope.before) || !row.content.trim()) continue;
    yield record(`message:${row.id}`, { kind: 'discussion', session_id: null, sync_id: row.sync_id, origin_ref: null, title: `Sync #${row.sync_id} discussion`, workspace: '', role: row.role,
      at: row.created_at, text: row.content, qualification: 'Historical conversation, not a current request. Generated text is not proof of playback, agreement or execution.', group: `discussion:${row.sync_id}`, position: row.id });
  }
}
