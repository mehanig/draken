import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import type { FrozenPointer } from '../db/evidence';

const KEY = 'background-source-stamps-v1';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** One counter slot per original source entry, not per session/alias/snapshot.
 * Distinct frozen projections join that entry's fingerprint rather than counting
 * the same original again. No bodies are reconstructed or retained here. */
export function sourceStamps(db: Database.Database, before?: string): Map<string, string> {
  const since = (db.prepare("SELECT value FROM sync_settings WHERE key='history_since'").get() as { value: string } | undefined)?.value || '';
  const sessions = new Set((db.prepare('SELECT s.id FROM agent_sessions s JOIN agent_sources a ON a.id=s.agent WHERE s.included=1 AND s.missing=0 AND a.enabled=1').all() as { id: string }[]).map(row => row.id));
  const groups = new Map<string, Set<string>>();
  const add = (key: unknown, projection: unknown) => {
    const id = hash(key), versions = groups.get(id) || new Set<string>(); versions.add(hash(projection)); groups.set(id, versions);
  };
  const allowed = (session: string, at: string) => sessions.has(session) && at >= since && (!before || at <= before);
  const projection = (agent: string, name: string, cwd: string, role: string, at: string, pointer: FrozenPointer) =>
    [agent, name || cwd, cwd, role, at, pointer.original.record_hash, pointer.normalization,
      pointer.edit ? [pointer.edit.record_hash, pointer.edit.normalization] : null, pointer.clip || null];
  for (const row of db.prepare(`SELECT e.*,s.agent,s.name,s.cwd,edit.record_hash AS edit_hash,edit.normalization AS edit_normalization
    FROM agent_entries e JOIN agent_sessions s ON s.id=e.session_id LEFT JOIN agent_entries edit ON edit.id=e.effective_id
    WHERE e.active=1 AND e.present=1 AND e.is_activity=1 AND e.effective_length>0 ORDER BY e.id`).iterate() as Iterable<any>) {
    if (!allowed(row.session_id, row.timestamp)) continue;
    add(['entry', row.session_id, row.entry_id], projection(row.agent, row.name, row.cwd, row.role, row.timestamp,
      { original: row, normalization: row.normalization, ...(row.edit_hash ? { edit: { record_hash: row.edit_hash, normalization: row.edit_normalization } } : {}) } as FrozenPointer));
  }
  const frozen = (item: any) => {
    if (!allowed(item.session_id, item.timestamp)) return;
    if (!item.source_pointer) throw new Error('Background checkpoint requires verified frozen pointers');
    add(['entry', item.session_id, item.entry_id], projection(item.agent || 'pi', item.session_name, item.cwd, item.role, item.timestamp, item.source_pointer));
  };
  for (const row of db.prepare("SELECT i.evidence_json FROM sync_items i JOIN syncs s ON s.id=i.sync_id WHERE s.status!='discarded' ORDER BY i.rowid").iterate() as Iterable<{ evidence_json: string }>) frozen(JSON.parse(row.evidence_json));
  for (const row of db.prepare("SELECT id,status,completed_at,context_json,decisions,carry_forward FROM syncs WHERE status!='discarded' ORDER BY id").iterate() as Iterable<any>) {
    for (const item of JSON.parse(row.context_json)) frozen(item);
    const at = row.status === 'completed' ? row.completed_at : null;
    if (before && (!at || at > before)) continue; // Same cutoff admission as prepare().
    for (const kind of ['decisions', 'carry_forward']) if (row[kind].trim()) add([kind, row.id], [row[kind], at, row.status === 'completed']);
  }
  for (const row of db.prepare("SELECT m.id,m.content,m.role,m.created_at FROM sync_messages m JOIN syncs s ON s.id=m.sync_id WHERE s.status!='discarded' ORDER BY m.id").iterate() as Iterable<any>) {
    if (row.content.trim() && (!before || row.created_at <= before)) add(['message', row.id], [row.content, row.role, row.created_at]);
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, hash([...values].sort())]));
}

/** Write only after successful unscoped preparation. Hashes are scheduling hints,
 * never evidence or authorization to skip fresh source verification. */
export function saveSourceCheckpoint(db: Database.Database, stamps: Map<string, string>) {
  const value = JSON.stringify([...stamps]);
  const prior = db.prepare('SELECT value FROM meta WHERE key=?').get(KEY) as { value: string } | undefined;
  if (prior?.value !== value) db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, value);
}

/** No file/DB/model creation. Older indexes without a checkpoint need one
 * foreground preparation; treating the whole cached archive as new would let
 * a small tail bypass the minimum after a restart. */
export function loadSourceCheckpoint(directory: string): Map<string, string> | undefined {
  const file = path.join(directory, 'memory', 'index.sqlite');
  if (!fs.existsSync(file)) return new Map();
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON'); db.pragma('busy_timeout = 5000');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get()) return new Map(); // Interrupted brand-new initialization.
    const size = db.prepare('SELECT length(value) AS size FROM meta WHERE key=?').get(KEY) as { size: number } | undefined;
    if (!size) return undefined;
    if (size.size > 33554432) throw new Error('Oversized background checkpoint');
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(KEY) as { value: string };
    const pairs: unknown = JSON.parse(row.value);
    if (!Array.isArray(pairs) || pairs.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) throw new Error('Invalid background checkpoint');
    const result = new Map<string, string>(pairs);
    if (result.size !== pairs.length) throw new Error('Duplicate background checkpoint identity');
    return result;
  } finally { db.close(); }
}
