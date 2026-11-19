import fs from 'fs';
import { recentSession, activityDays } from '../sources/activity-window';
import path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { sourceStamps } from './stamps';
import { sourceRoots, type RootInput } from '../sources/registry';
import { MODEL_ID } from './model-files';
import { modelFilesPresent } from './model-assets';

const KEY = 'call-history-ready-v1';
// Keep the storage key so old receipts are replaced by explicit preparation,
// not mistaken for current coverage. Compatible passages/vectors remain intact.
const VERSION = 2;
export interface HistoryReadiness { ready: boolean; before: string | null }
interface RequiredFile {
  id: string; path: string; file_identity: string; byte_offset: number; scanned_bytes: number; modified_at: string; end: number;
}
interface CachedStamp {
  revision: string; roots: string; before?: string; from: number; until: number; stamp: string;
  files: RequiredFile[]; metadata: string;
}
// Two replaceable slots, not a map of every preparation/cutoff ever requested.
// Retain only required-file descriptors and digests, never per-entry/frozen JSON.
const cached = new WeakMap<Database.Database, { current?: CachedStamp; captured?: CachedStamp }>();

function fileMetadata(files: RequiredFile[]): string {
  const metadata = createHash('sha256');
  for (const row of files) {
    const stat = fs.lstatSync(row.path);
    if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== row.file_identity || stat.size < row.scanned_bytes) throw new Error('Original session file is unavailable.');
    if (stat.size === row.scanned_bytes && stat.mtime.toISOString() !== row.modified_at) throw new Error('Original session file is unavailable or changed. Prepare history again.');
    if (row.scanned_bytes <= 0 || row.scanned_bytes < row.byte_offset || row.byte_offset < row.end) throw new Error('Finish importing history before calling.');
    // This is only a cache invalidator, NOT receipt identity. A valid append may
    // rebuild metadata without changing the captured stamp. Never read bodies.
    metadata.update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
  }
  return metadata.digest('hex');
}

/** A scheduling/readiness hint, not evidence. Original bytes are still verified
 * when preparing and retrieving. Identity covers admitted records, not mutable
 * import cursors: an append followed by a scan must preserve a prepared prefix.
 * Frozen aliases need their own links even when sourceStamps coalesces them. */
export function historyStamp(source: Database.Database, before?: string, roots?: RootInput, capturedOnly = false): string {
  // A failed discovery of a NEW file must block new global coverage, but cannot
  // revoke a previously captured context. Its own files still need completed
  // imports below. Preparing a receipt always uses the strict check.
  if (!capturedOnly && (source.prepare("SELECT value FROM sync_settings WHERE key='source-scan-complete-v1'").get() as { value: string } | undefined)?.value === '0') throw new Error('History import has not completed. Scan sessions before calling.');
  const now = Date.now(), cutoff = before || new Date(now).toISOString();
  const rootKey = JSON.stringify(sourceRoots(roots));
  const revision = `${VERSION}:${source.pragma('data_version', { simple: true })}:${(source.prepare('SELECT total_changes() AS n').get() as { n: number }).n}`;
  const slots = cached.get(source) || {};
  cached.set(source, slots);
  const slot = before === undefined ? 'current' : 'captured', prior = slots[slot];
  // Drop before validation/rebuilding so failures cannot leave reusable state.
  delete slots[slot];
  if (prior?.revision === revision && prior.before === before && prior.roots === rootKey
    && now < prior.until && (before !== undefined || now >= prior.from)) {
    // SQL metadata can be cached, external file changes cannot. In particular,
    // frozen-only branches still require their original file on every poll.
    if (fileMetadata(prior.files) === prior.metadata) {
      slots[slot] = prior;
      return prior.stamp;
    }
  }
  let until = Infinity;
  const since = (source.prepare("SELECT value FROM sync_settings WHERE key='history_since'").get() as { value: string } | undefined)?.value || '';
  const sessions = new Map((source.prepare(`SELECT s.id,s.path,s.file_identity,s.byte_offset,s.scanned_bytes,s.modified_at,s.last_message_at
    FROM agent_sessions s JOIN agent_sources a ON a.id=s.agent
    WHERE s.included=1 AND s.missing=0 AND a.enabled=1 AND ${recentSession('s')} ORDER BY s.id`).all() as {
      id: string; path: string; file_identity: string; byte_offset: number; scanned_bytes: number; modified_at: string; last_message_at: string | null;
    }[]).map(row => [row.id, row]));
  const days = activityDays(source);
  if (days !== null) for (const row of sessions.values()) if (row.last_message_at) until = Math.min(until, Date.parse(row.last_message_at) + days * 86400000);
  const required = new Map<string, number>();
  const requirePointer = (session: string, pointer: { record_offset: number; record_bytes: number }) => {
    const end = pointer.record_offset + pointer.record_bytes;
    if (!Number.isSafeInteger(pointer.record_offset) || pointer.record_offset < 0 || !Number.isSafeInteger(pointer.record_bytes) || pointer.record_bytes <= 0 || !Number.isSafeInteger(end)) throw new Error('Invalid history source pointer.');
    required.set(session, Math.max(required.get(session) || 0, end));
  };
  for (const row of source.prepare(`SELECT e.session_id,e.record_offset,e.record_bytes,edit.record_offset AS edit_offset,edit.record_bytes AS edit_bytes
    FROM agent_entries e LEFT JOIN agent_entries edit ON edit.id=e.effective_id
    WHERE e.active=1 AND e.present=1 AND e.is_activity=1 AND e.effective_length>0 AND e.timestamp>=? AND e.timestamp<=?`).iterate(since, cutoff) as Iterable<any>) {
    if (!sessions.has(row.session_id)) continue;
    requirePointer(row.session_id, row);
    if (row.edit_offset !== null) requirePointer(row.session_id, { record_offset: row.edit_offset, record_bytes: row.edit_bytes });
  }
  const aliases = createHash('sha256');
  const original = source.prepare('SELECT record_offset,record_bytes,record_hash,present FROM agent_entries WHERE session_id=? AND entry_id=?');
  const verified = new Set<string>();
  const frozenPointer = (session: string, entry: string, pointer: { record_offset: number; record_bytes: number; record_hash: string }) => {
    requirePointer(session, pointer);
    const key = JSON.stringify([session, entry, pointer]);
    if (verified.has(key)) return;
    // A frozen-only superseded branch is not represented by the live stamps.
    // A rescan that removed/rewrote its bytes must still revoke readiness, even
    // though the immutable frozen pointer itself (correctly) never changes.
    const row = original.get(session, entry) as { record_offset: number; record_bytes: number; record_hash: string; present: number } | undefined;
    if (!row?.present || row.record_hash !== pointer.record_hash || row.record_offset !== pointer.record_offset || row.record_bytes !== pointer.record_bytes) throw new Error('Original frozen session record is unavailable or changed.');
    verified.add(key);
  };
  const frozen = (sync: number, item: any) => {
    if (!sessions.has(item.session_id) || item.timestamp < since) return;
    if (item.timestamp > cutoff) {
      if (before === undefined) until = Math.min(until, Date.parse(item.timestamp));
      return;
    }
    if (!item.source_pointer) throw new Error('History requires verified frozen pointers.');
    frozenPointer(item.session_id, item.entry_id, item.source_pointer.original);
    if (item.source_pointer.edit) frozenPointer(item.session_id, item.source_pointer.edit.entry_id, item.source_pointer.edit);
    aliases.update(JSON.stringify([sync, item]));
  };
  for (const row of source.prepare("SELECT i.sync_id,i.evidence_json FROM sync_items i JOIN syncs s ON s.id=i.sync_id WHERE s.status!='discarded' ORDER BY i.sync_id,i.rowid").iterate() as Iterable<any>) frozen(row.sync_id, JSON.parse(row.evidence_json));
  for (const row of source.prepare("SELECT id,context_json FROM syncs WHERE status!='discarded' ORDER BY id").iterate() as Iterable<any>) {
    for (const item of JSON.parse(row.context_json)) frozen(row.id, item);
  }
  const files = createHash('sha256').update(rootKey).update(aliases.digest('hex'));
  const descriptors: RequiredFile[] = [];
  for (const [id, row] of sessions) {
    const end = required.get(id); if (end === undefined) continue;
    descriptors.push({ ...row, end });
    // Cursors are validated, never hashed. They advance on normal append+scan;
    // old record hashes/projections/admission below still detect actual damage.
    files.update(JSON.stringify([id, row.path, row.file_identity]));
  }
  const metadata = fileMetadata(descriptors);
  const fileStamp = files.digest('hex');
  const stamp = createHash('sha256').update(fileStamp).update(JSON.stringify([...sourceStamps(source, cutoff)])).digest('hex');
  if (before === undefined) {
    const next = source.prepare(`SELECT MIN(at) AS at FROM (
      SELECT timestamp AS at FROM agent_entries WHERE timestamp>?
      UNION ALL SELECT created_at FROM sync_messages WHERE created_at>?
      UNION ALL SELECT completed_at FROM syncs WHERE completed_at>?)`).get(cutoff, cutoff, cutoff) as { at: string | null };
    until = Math.min(until, next.at ? Date.parse(next.at) : Infinity);
  }
  slots[slot] = { revision, roots: rootKey, before, from: now, until, stamp, files: descriptors, metadata };
  return stamp;
}

export function saveHistoryReadiness(db: Database.Database, source: Database.Database, before: string, stamp: string, model: string, roots?: RootInput): void {
  if (historyStamp(source, before, roots) !== stamp) throw new Error('History changed during preparation. Prepare the remaining changes before calling.');
  const prior = db.prepare('SELECT value FROM meta WHERE key=?').get(KEY) as { value: string } | undefined;
  // Unchanged preparation must not rewrite derived state merely to move a clock.
  if (prior && prior.value.length <= 1024) {
    try {
      const value = JSON.parse(prior.value);
      if (value.version === VERSION && value.stamp === stamp && value.model === model && typeof value.before === 'string'
        && new Date(value.before).toISOString() === value.before && value.before <= before) return;
    } catch { /* Explicit preparation can replace an invalid receipt, not source evidence. */ }
  }
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify({ version: VERSION, before, stamp, model }));
}

export function indexReadiness(db: Database.Database, source: Database.Database | null, capturedOnly = false): HistoryReadiness {
  const absent = { ready: false, before: null };
  try {
    if ((db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined)?.value !== 'history-index-v3-contentless') return absent;
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(KEY) as { value: string } | undefined;
    if (!row || row.value.length > 1024) return absent;
    const marker = JSON.parse(row.value);
    if (marker.version !== VERSION || typeof marker.before !== 'string' || !Number.isFinite(Date.parse(marker.before)) || new Date(marker.before).toISOString() !== marker.before || marker.before > new Date().toISOString()
      || typeof marker.stamp !== 'string' || !/^[a-f0-9]{64}$/.test(marker.stamp)
      || marker.model !== (db.prepare("SELECT value FROM meta WHERE key='model'").get() as { value: string } | undefined)?.value) return absent;
    // Status polling reports the recorded checkpoint, not verified admission.
    if (source === null) return { ready: true, before: marker.before };
    // Start with incomplete physical passages, not every occurrence/alias. The
    // correlated lookup uses links_passage; new caches also have a tiny partial
    // passages index. Older read-only schemas need no migration to run this.
    if (db.prepare(`SELECT 1 FROM passages p WHERE p.embedded=0 AND EXISTS (
      SELECT 1 FROM chunk_links c JOIN records r ON r.ref=c.ref
      WHERE c.passage_id=p.id AND r.at<=?) LIMIT 1`).get(marker.before)) return absent;
    // New post-cutoff entries/messages/sessions are not claimed as indexed.
    // An alias of an OLD record still needs a link, regardless of snapshot age;
    // unlike an alias of a post-cutoff record, it must invalidate this receipt.
    return marker.stamp === historyStamp(source, capturedOnly ? marker.before : undefined, undefined, capturedOnly) ? { ready: true, before: marker.before } : absent;
  } catch { return absent; }
}

/** Read-only metadata. Never creates a cache, scans source logs, starts a worker,
 * downloads weights or infers. Missing/older receipts need explicit preparation. */
export function storedHistoryReadiness(directory: string, source: Database.Database | null, capturedOnly = false): HistoryReadiness {
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
