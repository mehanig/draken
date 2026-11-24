import type Database from 'better-sqlite3';
import type { Evidence } from '../types';
import { EvidenceReader } from '../db/evidence';
import { admittedAgent } from '../sources/registry';
import { HttpError } from '../errors';

/** Only the original planning refs are initial C. Persist before any adoption;
 * retry/reopen must never promote added dependencies to the frozen scope. */
export function planningContext<T extends { ref: string }>(db: Database.Database, id: number | undefined, context: T[]): T[] {
  const saved = id && db.prepare('SELECT refs_json FROM summary_planning_context WHERE sync_id=?').get(id) as { refs_json: string } | undefined;
  const refs = new Set<string>(saved ? JSON.parse(saved.refs_json) : context.map(item => item.ref));
  if (id && !saved) db.prepare('INSERT OR IGNORE INTO summary_planning_context(sync_id,refs_json) VALUES (?,?)').run(id, JSON.stringify([...refs]));
  return context.filter(item => refs.has(item.ref));
}

/** Exact captured representation plus its only authorized metadata reduction.
 * Canonical body IDs alone cannot identify a selected edit/projection. Ref labels
 * and paths are deliberately excluded; the full selected pointer is not. */
export function evidenceIdentities(metadata: Record<string, any>): [string, string] {
  const identity = (sequence: unknown) => JSON.stringify([metadata.agent || 'pi', metadata.session_id, metadata.entry_id, metadata.event_key,
    metadata.cwd, metadata.timestamp, sequence, metadata.role, metadata.source_key, metadata.source_pointer]);
  return [identity(metadata.sequence), identity(undefined)];
}

/** Admission policy over stored metadata, separate from session content.
 * Reference labels and file moves are not model input; the selected projection
 * and all model attribution are. No archive scans or cached consent decisions. */
export class EvidenceScope {
  private readonly frozen = new Set<string>();
  private readonly current;
  private readonly consent;
  constructor(db: Database.Database, initial: Iterable<Record<string, any>>) {
    for (const item of initial) {
      const [exact, reduced] = evidenceIdentities(item);
      this.frozen.add(exact);
      this.frozen.add(reduced);
    }
    this.consent = db.prepare(`SELECT agent FROM agent_sessions s WHERE id=?
      AND included=1 AND missing=0 AND ${admittedAgent('s')}`);
    this.current = db.prepare(`SELECT e.event_key,e.record_hash,s.cwd,s.agent,x.record_hash AS edit_hash
      FROM agent_entries e JOIN agent_sessions s ON s.id=e.session_id LEFT JOIN agent_entries x ON x.id=e.effective_id
      WHERE e.session_id=? AND e.entry_id=? AND e.active=1 AND e.present=1
        AND s.included=1 AND s.missing=0 AND ${admittedAgent('s')}
        AND (e.effective_id IS NULL OR (x.present=1 AND x.session_id=e.session_id
          AND x.type='context_edit' AND x.target_id=e.entry_id))`);
  }
  assert(metadata: any) {
    if (this.frozen.has(evidenceIdentities(metadata)[0])) {
      const session = this.consent.get(metadata.session_id) as { agent: string } | undefined;
      if (session && session.agent === (metadata.agent || 'pi')) return;
    } else {
      const pointer = metadata.source_pointer;
      const current = this.current.get(metadata.session_id, metadata.entry_id) as any;
      if (current && current.cwd === metadata.cwd && current.agent === (metadata.agent || 'pi') && current.event_key === metadata.event_key &&
        current.record_hash === pointer?.original?.record_hash && (current.edit_hash || undefined) === pointer?.edit?.record_hash) return;
    }
    throw new Error('Original leaf evidence is unavailable, changed or excluded; no paid replacement was requested.');
  }
}

/** Check current permissions and availability of the selected stored projections.
 * A supplied snapshot avoids loading the same records twice. */
export function verifySyncEvidence(db: Database.Database, id: number, freshlyRead?: { items: Evidence[]; context: Evidence[] }): void {
  const items = (db.prepare('SELECT evidence_json FROM sync_items WHERE sync_id=? ORDER BY rowid').all(id) as { evidence_json: string }[])
    .map(row => JSON.parse(row.evidence_json));
  const row = db.prepare('SELECT context_json FROM syncs WHERE id=?').get(id) as { context_json: string } | undefined;
  if (!row) throw new HttpError(404, 'Sync not found');
  const context = JSON.parse(row.context_json);
  const scope = new EvidenceScope(db, [...items, ...planningContext(db, id, context)]);
  if (freshlyRead && [...freshlyRead.items, ...freshlyRead.context].some(item => item.unavailable)) {
    throw new HttpError(409, 'Original session evidence is unavailable or changed. Restore the session files before calling.');
  }
  const reader = freshlyRead ? undefined : new EvidenceReader(db);
  try {
    for (const item of [...items, ...context]) {
      scope.assert(item);
      reader?.read(item);
    }
  } catch (error) {
    throw new HttpError(409, error instanceof Error ? error.message : 'Original snapshot evidence is unavailable or changed.');
  } finally { reader?.close(); }
}
