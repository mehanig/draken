import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { sourceStamps } from './stamps';
import { sourceRoots, type RootInput } from '../sources/registry';
import { MODEL_ID } from './model-files';
import { modelFilesPresent } from './model-assets';

const KEY = 'call-history-ready-v1';
export interface HistoryReadiness { ready: boolean; before: string | null }
const cached = new WeakMap<Database.Database, { revision: string; until: number; stamp: string; before?: string }>();

/** A scheduling/readiness hint, not evidence. Original bytes are still verified
 * when preparing and retrieving. Include frozen aliases here: unlike the
 * strict64 counter, readiness must cover their search links too. */
export function historyStamp(source: Database.Database, before?: string, roots?: RootInput): string {
  if ((source.prepare("SELECT value FROM sync_settings WHERE key='source-scan-complete-v1'").get() as { value: string } | undefined)?.value === '0') throw new Error('History import has not completed. Scan sessions before calling.');
  const now = Date.now(), cutoff = before || new Date(now).toISOString();
  const files = createHash('sha256').update(JSON.stringify(sourceRoots(roots)));
  for (const row of source.prepare('SELECT s.path,s.file_identity,s.byte_offset,s.scanned_bytes,s.modified_at FROM agent_sessions s JOIN agent_sources a ON a.id=s.agent WHERE s.included=1 AND s.missing=0 AND a.enabled=1 AND EXISTS (SELECT 1 FROM agent_entries e WHERE e.session_id=s.id AND e.is_activity=1) ORDER BY s.id').iterate() as Iterable<{ path: string; file_identity: string; byte_offset: number; scanned_bytes: number; modified_at: string }>) {
    const stat = fs.lstatSync(row.path);
    if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== row.file_identity || stat.size < row.scanned_bytes) throw new Error('Original session file is unavailable.');
    if (stat.size === row.scanned_bytes && stat.mtime.toISOString() !== row.modified_at) throw new Error('Original session file is unavailable or changed. Prepare history again.');
    if (!row.scanned_bytes || row.scanned_bytes < row.byte_offset) throw new Error('Finish importing history before calling.');
    // Later appends belong to a later preparation. Never make an active agent's
    // growing log invalidate an already captured and verified prefix forever.
    files.update(JSON.stringify([row.path, row.file_identity, row.byte_offset, row.scanned_bytes]));
  }
  const fileStamp = files.digest('hex');
  const revision = `${source.pragma('data_version', { simple: true })}:${(source.prepare('SELECT total_changes() AS n').get() as { n: number }).n}:${fileStamp}`;
  const prior = cached.get(source);
  if (prior?.revision === revision && prior.before === before && now < prior.until) return prior.stamp;
  const hash = createHash('sha256').update(fileStamp).update(JSON.stringify([...sourceStamps(source, cutoff)]));
  for (const row of source.prepare("SELECT i.sync_id,i.evidence_json FROM sync_items i JOIN syncs s ON s.id=i.sync_id WHERE s.status!='discarded' ORDER BY i.rowid").iterate()) hash.update(JSON.stringify(row));
  for (const row of source.prepare("SELECT id,context_json FROM syncs WHERE status!='discarded' ORDER BY id").iterate()) hash.update(JSON.stringify(row));
  const stamp = hash.digest('hex');
  if (!before) {
    const next = source.prepare(`SELECT MIN(at) AS at FROM (
      SELECT timestamp AS at FROM agent_entries WHERE timestamp>?
      UNION ALL SELECT created_at FROM sync_messages WHERE created_at>?
      UNION ALL SELECT completed_at FROM syncs WHERE completed_at>?)`).get(cutoff, cutoff, cutoff) as { at: string | null };
    cached.set(source, { revision, until: next.at ? Date.parse(next.at) : Infinity, stamp });
  } else cached.set(source, { revision, until: Infinity, stamp, before });
  return stamp;
}

export function saveHistoryReadiness(db: Database.Database, source: Database.Database, before: string, stamp: string, model: string, roots?: RootInput): void {
  if (historyStamp(source, before, roots) !== stamp) throw new Error('History changed during preparation. Prepare the remaining changes before calling.');
  const prior = db.prepare('SELECT value FROM meta WHERE key=?').get(KEY) as { value: string } | undefined;
  // Unchanged preparation must not rewrite derived state merely to move a clock.
  if (prior && prior.value.length <= 1024) {
    try {
      const value = JSON.parse(prior.value);
      if (value.stamp === stamp && value.model === model && typeof value.before === 'string'
        && new Date(value.before).toISOString() === value.before && value.before <= before) return;
    } catch { /* Explicit preparation can replace an invalid receipt, not source evidence. */ }
  }
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify({ before, stamp, model }));
}

export function indexReadiness(db: Database.Database, source: Database.Database, capturedOnly = false): HistoryReadiness {
  const absent = { ready: false, before: null };
  try {
    if ((db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined)?.value !== 'history-index-v3-contentless') return absent;
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(KEY) as { value: string } | undefined;
    if (!row || row.value.length > 1024) return absent;
    const marker = JSON.parse(row.value);
    if (typeof marker.before !== 'string' || !Number.isFinite(Date.parse(marker.before)) || new Date(marker.before).toISOString() !== marker.before || marker.before > new Date().toISOString()
      || typeof marker.stamp !== 'string' || !/^[a-f0-9]{64}$/.test(marker.stamp)
      || marker.model !== (db.prepare("SELECT value FROM meta WHERE key='model'").get() as { value: string } | undefined)?.value) return absent;
    if (db.prepare('SELECT 1 FROM passages p JOIN chunk_links c ON c.passage_id=p.id JOIN records r ON r.ref=c.ref WHERE p.embedded=0 AND r.at<=? LIMIT 1').get(marker.before)) return absent;
    // A text conversation may keep using its prepared cutoff while saving new
    // messages. Those newer messages are supplied directly, not falsely claimed
    // as indexed. Original-file/cursor/admission changes still invalidate it.
    return marker.stamp === historyStamp(source, capturedOnly ? marker.before : undefined) ? { ready: true, before: marker.before } : absent;
  } catch { return absent; }
}

/** Read-only metadata. Never creates a cache, scans source logs, starts a worker,
 * downloads weights or infers. Missing/older receipts need explicit preparation. */
export function storedHistoryReadiness(directory: string, source: Database.Database, capturedOnly = false): HistoryReadiness {
  const file = path.join(directory, 'memory', 'index.sqlite');
  if (!fs.existsSync(file)) return { ready: false, before: null };
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON'); db.pragma('busy_timeout = 1000');
    if ((db.prepare("SELECT value FROM meta WHERE key='model'").get() as { value: string } | undefined)?.value !== MODEL_ID) return { ready: false, before: null };
    if (db.prepare('SELECT 1 FROM passages WHERE embedded=1 LIMIT 1').get()
      && !modelFilesPresent(path.join(directory, 'memory', 'model'))) return { ready: false, before: null };
    return indexReadiness(db, source, capturedOnly);
  } catch { return { ready: false, before: null }; }
  finally { db?.close(); }
}
