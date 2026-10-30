import { getDb } from '../db/schema';
import { Evidence, ObservedSession, Overview, SyncDetail, SyncSummary } from '../types';
import { getSessionRoot } from './collector';
import { cleanText } from './normalize';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const busySyncs = new Set<number>();
const summaryQuery = `SELECT s.id, s.status, s.created_at, s.completed_at, s.briefing, s.decisions, s.carry_forward,
  s.remaining_count, (SELECT COUNT(*) FROM sync_items i WHERE i.sync_id = s.id) AS item_count FROM syncs s`;
const historyWindow = `e.timestamp >= COALESCE((SELECT value FROM sync_settings WHERE key = 'history_since'), '')`;
const pendingWhere = `e.active = 1 AND e.present = 1 AND e.is_activity = 1 AND e.effective_text != ''
  AND ${historyWindow} AND s.included = 1 AND s.missing = 0 AND NOT EXISTS (SELECT 1 FROM sync_coverage c WHERE c.event_key = e.event_key)`;
const evidenceSelect = `SELECT e.id AS source_id, e.event_key, e.session_id, s.name AS session_name, s.path AS source_path,
  s.cwd, e.entry_id, e.timestamp, e.role, e.effective_text AS text FROM pi_entries e JOIN pi_sessions s ON s.id = e.session_id`;

export function pendingCount(): number {
  return (getDb().prepare(`SELECT COUNT(DISTINCT e.event_key) AS count FROM pi_entries e
    JOIN pi_sessions s ON s.id = e.session_id WHERE ${pendingWhere}`).get() as { count: number }).count;
}

export function overview(): Overview {
  const db = getDb();
  const sessions = db.prepare(`SELECT s.id, s.path, s.cwd, s.name, s.included, s.missing, s.modified_at,
    (SELECT COUNT(DISTINCT e.event_key) FROM pi_entries e WHERE e.session_id = s.id AND e.active = 1
    AND e.present = 1 AND e.is_activity = 1 AND e.effective_text != '' AND ${historyWindow}
    AND NOT EXISTS (SELECT 1 FROM sync_coverage c WHERE c.event_key = e.event_key)) AS pending
    FROM pi_sessions s ORDER BY s.modified_at DESC`).all() as ObservedSession[];
  const syncs = db.prepare(`${summaryQuery} ORDER BY s.id DESC LIMIT 50`).all() as SyncSummary[];
  return {
    sessions, syncs, pending: pendingCount(), active_sync_id: syncs.find(s => s.status === 'open')?.id || null,
    session_root: getSessionRoot(), model: process.env.DRAKEN_PI_MODEL || 'pi configured default',
    history_since: historySince(),
    history_initialized: Boolean(db.prepare("SELECT 1 FROM sync_settings WHERE key = 'history_since'").get()),
  };
}

export function setIncluded(sessionId: string, included: boolean): void {
  const result = getDb().prepare('UPDATE pi_sessions SET included = ? WHERE id = ?').run(Number(included), sessionId);
  if (!result.changes) throw new HttpError(404, 'Session not found');
}

function historySince(): string | null {
  const row = getDb().prepare("SELECT value FROM sync_settings WHERE key = 'history_since'").get() as { value: string } | undefined;
  return row?.value || null;
}

export function getSync(id: number): SyncDetail {
  const db = getDb();
  const row = db.prepare(`${summaryQuery} WHERE s.id = ?`).get(id) as SyncSummary | undefined;
  if (!row) throw new HttpError(404, 'Sync not found');
  const extra = db.prepare('SELECT context_json, memory_json FROM syncs WHERE id = ?').get(id) as any;
  const items = (db.prepare('SELECT evidence_json FROM sync_items WHERE sync_id = ? ORDER BY rowid').all(id) as any[])
    .map(item => JSON.parse(item.evidence_json));
  return {
    ...row, items, context: JSON.parse(extra.context_json), memory: JSON.parse(extra.memory_json),
    messages: db.prepare('SELECT id, role, content, created_at FROM sync_messages WHERE sync_id = ? ORDER BY id').all(id) as SyncDetail['messages'],
    busy: busySyncs.has(id), history_since: historySince(),
  };
}

export function requireOpen(id: number, allowBusy = false): SyncDetail {
  const sync = getSync(id);
  if (sync.status !== 'open') throw new HttpError(409, 'This sync is already closed');
  if (!allowBusy && sync.busy) throw new HttpError(409, 'A reply is still being generated. Wait before changing this sync.');
  return sync;
}

export function startSync(since?: string | null): SyncDetail {
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare("SELECT id FROM syncs WHERE status = 'open'").get() as { id: number } | undefined;
    if (existing) return getSync(existing.id);
    const initialized = db.prepare("SELECT 1 FROM sync_settings WHERE key = 'history_since'").get();
    if (!initialized) {
      const parsed = since ? new Date(since) : null;
      if (parsed && (!Number.isFinite(parsed.getTime()) || parsed.getTime() > Date.now())) {
        throw new HttpError(400, 'The initial history start must be a valid date in the past');
      }
      // This is an explicit first-use baseline, not coverage. It never moves on later syncs.
      // Earlier prototype databases with completed syncs always retain their all-history baseline.
      const hasCompleted = db.prepare("SELECT 1 FROM syncs WHERE status = 'completed' LIMIT 1").get();
      db.prepare("INSERT INTO sync_settings(key, value) VALUES ('history_since', ?)").run(hasCompleted ? '' : parsed?.toISOString() || '');
    }
    // Interleave sessions so one long-running session cannot monopolize every batch.
    const rows = db.prepare(`SELECT * FROM (
      SELECT e.id AS source_id, e.event_key, e.session_id, s.name AS session_name, s.path AS source_path,
      s.cwd, e.entry_id, e.timestamp, e.role, e.effective_text AS text,
      ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.id) AS session_position
      FROM pi_entries e JOIN pi_sessions s ON s.id = e.session_id WHERE ${pendingWhere}
    ) ORDER BY session_position, timestamp, source_id LIMIT 2000`).all() as (Evidence & { source_id: number })[];
    const chosen: Evidence[] = [];
    const seen = new Set<string>();
    const firstBySession = new Map<string, number>();
    let chars = 0;
    for (const row of rows) {
      if (seen.has(row.event_key)) continue;
      const { source_id, ...rest } = row;
      const evidence = { ...rest, ref: `E${chosen.length + 1}` };
      const cost = JSON.stringify(evidence).length;
      if (chosen.length >= 100 || chars + cost > 80000) break;
      chosen.push(evidence);
      seen.add(row.event_key);
      chars += cost;
      firstBySession.set(row.session_id, Math.min(firstBySession.get(row.session_id) ?? Infinity, source_id));
    }
    const context: Evidence[] = [];
    let contextChars = 0;
    for (const [sessionId, firstId] of firstBySession) {
      const prior = db.prepare(`${evidenceSelect} WHERE e.session_id = ? AND e.active = 1 AND e.present = 1
        AND e.id < ? AND e.effective_text != '' ORDER BY e.id DESC LIMIT 6`).all(sessionId, firstId) as Evidence[];
      for (const row of prior.reverse()) {
        if (seen.has(row.event_key)) continue;
        const item = { ...row, ref: `C${context.length + 1}`, text: cleanText(row.text, 2000) };
        const cost = JSON.stringify(item).length;
        if (contextChars + cost > 24000) break;
        context.push(item);
        contextChars += cost;
      }
    }
    const memory = db.prepare(`SELECT id AS sync_id, decisions, carry_forward FROM syncs
      WHERE status = 'completed' ORDER BY id DESC LIMIT 10`).all() as SyncDetail['memory'];
    const carry = memory[0]?.carry_forward || '';
    const result = db.prepare(`INSERT INTO syncs(created_at, context_json, memory_json, carry_forward, remaining_count)
      VALUES (?, ?, ?, ?, ?)`).run(new Date().toISOString(), JSON.stringify(context), JSON.stringify(memory), carry,
      Math.max(0, pendingCount() - chosen.length));
    const id = Number(result.lastInsertRowid);
    const insert = db.prepare('INSERT INTO sync_items(sync_id, event_key, evidence_json) VALUES (?, ?, ?)');
    for (const item of chosen) insert.run(id, item.event_key, JSON.stringify(item));
    return getSync(id);
  })();
}

export function saveNotes(id: number, decisions: string, carryForward: string): SyncDetail {
  requireOpen(id);
  getDb().prepare('UPDATE syncs SET decisions = ?, carry_forward = ? WHERE id = ?').run(decisions, carryForward, id);
  return getSync(id);
}

export function completeSync(id: number, decisions: string, carryForward: string, reviewed: boolean): SyncDetail {
  const db = getDb();
  return db.transaction(() => {
    requireOpen(id);
    if (!reviewed) throw new HttpError(400, 'Confirm you reviewed this snapshot before finishing the sync');
    db.prepare(`UPDATE syncs SET status = 'completed', completed_at = ?, decisions = ?, carry_forward = ? WHERE id = ?`)
      .run(new Date().toISOString(), decisions, carryForward, id);
    // Cover ONLY the frozen snapshot, never the current file offsets or wall clock.
    db.prepare('INSERT OR IGNORE INTO sync_coverage(event_key, sync_id) SELECT event_key, sync_id FROM sync_items WHERE sync_id = ?').run(id);
    return getSync(id);
  })();
}

export function discardSync(id: number): SyncDetail {
  requireOpen(id);
  getDb().prepare("UPDATE syncs SET status = 'discarded', completed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return getSync(id);
}
