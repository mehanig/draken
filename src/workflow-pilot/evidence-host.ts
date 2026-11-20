import type Database from 'better-sqlite3';
import { EntryReader } from '../sync/source-files';
import { cleanText, digest } from '../sync/normalize';
import { recentSession } from '../sources/activity-window';
import { prepareProcedureEvidence, type ProcedurePacket, type ProcedureRecord, type ProcedureEvidenceRequest, type ProcedureEvidenceDependencies } from '../evidence';

export interface CapturedOriginal { id: number; ref: string; identity: string; eventKey: string }
export interface PilotCapture {
  version: 1;
  sessionId: string;
  before: string;
  originals: CapturedOriginal[];
  eligibleRecords: number;
  omittedRecords: number;
  workspace: string;
}
function allowed(db: Database.Database, session: string) {
  const row = db.prepare(`SELECT s.id,s.cwd FROM agent_sessions s JOIN agent_sources a ON a.id=s.agent
    WHERE s.id=? AND s.included=1 AND s.missing=0 AND a.enabled=1 AND ${recentSession('s')}`).get(session) as { id: string; cwd: string } | undefined;
  if (!row) throw new Error('Session is excluded, missing or outside the current activity window.');
  return row;
}
const baseline = (db: Database.Database) => (db.prepare("SELECT value FROM sync_settings WHERE key='history_since'").get() as { value: string } | undefined)?.value || '';
function original(db: Database.Database, id: number) {
  const row = db.prepare(`SELECT e.*,s.path,s.file_identity,s.agent,s.external_id FROM agent_entries e JOIN agent_sessions s ON s.id=e.session_id WHERE e.id=?`).get(id) as any;
  if (!row || !row.active || !row.present || !row.is_activity || !row.effective_length) throw new Error('Captured original is no longer active and available.');
  const edit = row.effective_id === null ? null : db.prepare('SELECT * FROM agent_entries WHERE id=?').get(row.effective_id);
  return { row, identity: digest(JSON.stringify([row, edit])) };
}
export function listPilotSessions(db: Database.Database) {
  return db.prepare(`SELECT s.id,s.cwd,s.name,s.last_message_at,
    (SELECT COUNT(*) FROM agent_entries e WHERE e.session_id=s.id AND e.active=1 AND e.present=1 AND e.is_activity=1 AND e.effective_length>0 AND e.timestamp>=?) records
    FROM agent_sessions s JOIN agent_sources a ON a.id=s.agent WHERE s.included=1 AND s.missing=0 AND a.enabled=1 AND ${recentSession('s')}
    ORDER BY s.last_message_at DESC LIMIT 30`).all(baseline(db));
}
/** Capture metadata only. No scanning/import, snapshot membership, or source writes. */
export function capturePilot(db: Database.Database, sessionId: string, records: number, before: string): PilotCapture {
  if (!Number.isSafeInteger(records) || records < 1 || records > 24 || !Number.isFinite(Date.parse(before))) throw new Error('Pilot supports one to 24 records at a fixed cutoff.');
  const session = allowed(db, sessionId), since = baseline(db);
  const params = [sessionId, since, before];
  const where = 'session_id=? AND active=1 AND present=1 AND is_activity=1 AND effective_length>0 AND timestamp>=? AND timestamp<=?';
  const total = (db.prepare(`SELECT COUNT(*) n FROM agent_entries WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`SELECT id FROM agent_entries WHERE ${where} ORDER BY id DESC LIMIT ?`).all(...params, records) as { id: number }[];
  if (!rows.length) throw new Error('No eligible indexed originals in this session. No scanning or model work was started.');
  const seen = new Set<string>(), originals: CapturedOriginal[] = [];
  for (const { id } of rows.reverse()) {
    const { row, identity } = original(db, id);
    if (seen.has(row.event_key)) continue;
    seen.add(row.event_key); originals.push({ id, ref: `R${id}`, identity, eventKey: row.event_key });
  }
  return { version: 1, sessionId, before, originals, eligibleRecords: total, omittedRecords: total - originals.length, workspace: cleanText(session.cwd, 300) };
}
export async function readPilotBatch(db: Database.Database, capture: PilotCapture, entries: CapturedOriginal[], signal: AbortSignal): Promise<ProcedurePacket> {
  const request: ProcedureEvidenceRequest = { sessionId: capture.sessionId, before: capture.before, refs: entries.map(item => item.ref), signal };
  const dependencies: ProcedureEvidenceDependencies = {
    cleanText,
    read: async (ref, currentSignal): Promise<ProcedureRecord> => {
      currentSignal.throwIfAborted(); allowed(db, capture.sessionId);
      const item = entries.find(entry => entry.ref === ref);
      if (!item) throw new Error('Original not in the captured sample.');
      const { row, identity } = original(db, item.id);
      if (row.session_id !== capture.sessionId || row.timestamp < baseline(db) || row.timestamp > capture.before || identity !== item.identity) throw new Error('Captured original identity or scope changed; no cached text substituted.');
      const reader = new EntryReader(db);
      let text: string;
      try { text = reader.effective(item.id); } finally { reader.close(); }
      currentSignal.throwIfAborted(); allowed(db, capture.sessionId);
      if (original(db, item.id).identity !== identity || row.timestamp < baseline(db)) throw new Error('Original changed during its verified read.');
      return { ref, sessionId: row.session_id, sequence: row.id, at: row.timestamp, role: row.role, text };
    },
  };
  return prepareProcedureEvidence(request, dependencies);
}
