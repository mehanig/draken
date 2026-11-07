import fs from 'fs';
import type Database from 'better-sqlite3';
import type { Evidence } from '../types';
import { cleanText, digest, normalizeEntry, type NormalizedEntry, type NormalizationVersion } from '../sync/normalize';
import { fileRecords, openSessionFile, verifySessionHeader, getSessionRoot, type RecordPointer } from '../sync/jsonl';
import { encodeEvidence, recordPointer, type FrozenPointer } from './evidence';
import { retainedText, thawEvidence } from './retained-text';
import { entryTable } from './pointer-migration';

type Candidate = { pointer: RecordPointer; versions: Map<NormalizationVersion, NormalizedEntry> };
/** Migration-only exact matching, never a retrieval fallback or file discovery. */
class Catalog {
  private sessions = new Map<string, Map<string, Candidate[]>>();
  constructor(private db: Database.Database) {}
  records(session: string): Map<string, Candidate[]> {
    const saved = this.sessions.get(session); if (saved) return saved;
    const source = this.db.prepare('SELECT path,byte_offset FROM agent_sessions WHERE id=?').get(session) as any;
    if (!source) throw new Error('Original session is not registered');
    const fd = openSessionFile(source.path, getSessionRoot()), records = new Map<string, Candidate[]>();
    try {
      verifySessionHeader(fd, session);
      for (const record of fileRecords(fd, Math.min(fs.fstatSync(fd).size, source.byte_offset))) {
        const current = normalizeEntry(record.value); if (!current) continue;
        const older = normalizeEntry(record.value, 1)!;
        const candidate = { pointer: recordPointer(record), versions: new Map<NormalizationVersion, NormalizedEntry>([[2, current], [1, older]]) };
        const values = records.get(current.entry_id) || []; values.push(candidate); records.set(current.entry_id, values);
      }
    } finally { fs.closeSync(fd); }
    this.sessions.set(session, records); return records;
  }
  frozen(item: Evidence, snapshotAt: string): FrozenPointer {
    const records = this.records(item.session_id);
    const originals = records.get(item.entry_id) || [];
    for (const original of originals) for (const [version, normalized] of original.versions) {
      if (normalized.event_key !== item.event_key || normalized.role !== item.role || normalized.timestamp !== item.timestamp) continue;
      const base: FrozenPointer = { version: 1, original: original.pointer, normalization: version, text_hash: digest(item.text) };
      if (normalized.text === item.text) return base;
      for (const clipVersion of [2, 1] as const) if (cleanText(normalized.text, 2000, clipVersion) === item.text) return { ...base, clip: { limit: 2000, normalization: clipVersion } };
      const matches: FrozenPointer[] = [];
      for (const candidates of records.values()) for (const candidate of candidates) for (const [editVersion, edit] of candidate.versions) {
        if (edit.type !== 'context_edit' || edit.target_id !== item.entry_id || edit.replacement === null || candidate.pointer.record_offset <= original.pointer.record_offset) continue;
        const when = Date.parse(edit.timestamp), frozenAt = Date.parse(snapshotAt);
        if (!Number.isFinite(when) || !Number.isFinite(frozenAt) || when > frozenAt) continue;
        let parent = edit.parent_id; const seen = new Set<string>();
        while (parent && parent !== item.entry_id && !seen.has(parent)) { seen.add(parent); parent = records.get(parent)?.at(-1)?.versions.get(2)?.parent_id || null; }
        if (parent !== item.entry_id) continue;
        const pointer: FrozenPointer = { ...base, legacy_edit_match: true, edit: { ...candidate.pointer, entry_id: edit.entry_id, event_key: edit.event_key, normalization: editVersion } };
        if (edit.replacement === item.text) matches.push(pointer);
        else for (const clipVersion of [2, 1] as const) if (cleanText(edit.replacement, 2000, clipVersion) === item.text) matches.push({ ...pointer, clip: { limit: 2000, normalization: clipVersion } });
      }
      // Equivalent normalization recipes for the same raw edit are not separate
      // sources. Different matching edits are ambiguous: do not guess history.
      const distinct = new Map(matches.map(pointer => [pointer.edit!.record_hash, pointer]));
      if (distinct.size === 1) return distinct.values().next().value!;
      if (distinct.size > 1) throw new Error('Historical context-edit selection is ambiguous');
    }
    throw new Error('Frozen text cannot be reconstructed from its original pi records');
  }
  legacy(row: any): any {
    if (!row.legacy_text_ref && !row.legacy_replacement_ref && !row.effective_legacy_ref) return { ...row, normalization: row.normalization ?? 2 };
    const text = row.legacy_text_ref ? retainedText(this.db, row.legacy_text_ref) : undefined;
    const replacement = row.legacy_replacement_ref ? retainedText(this.db, row.legacy_replacement_ref) : undefined;
    const candidates = this.records(row.session_id).get(row.entry_id) || [];
    let result: any;
    for (const candidate of candidates) for (const [normalization, entry] of candidate.versions) {
      if (entry.event_key === row.event_key && (text === undefined || entry.text === text) && (replacement === undefined || entry.replacement === replacement)) {
        result = { ...row, ...candidate.pointer, normalization }; break;
      }
    }
    if (!result) throw new Error('Legacy entry cannot be reconstructed from its original pi record');
    if (row.effective_legacy_ref) {
      const expected = retainedText(this.db, row.effective_legacy_ref);
      const candidates = this.db.prepare("SELECT * FROM agent_entries WHERE session_id=? AND target_id=? AND type='context_edit' AND active=1 AND present=1").all(row.session_id, row.entry_id) as any[];
      const matches = candidates.filter(edit => {
        const records = this.records(row.session_id).get(edit.entry_id) || [];
        return records.some(record => [...record.versions.values()].some(value => value.event_key === edit.event_key && value.replacement === expected));
      });
      if (matches.length !== 1) throw new Error('Legacy override has no unique original context edit');
      result.effective_id = matches[0].id;
    }
    return result;
  }
}

/** All-or-nothing removal of copied pi evidence. An unverifiable old body stops
 * migration; it is never silently deleted, newly redacted or guessed. */
export function migrateSnapshotPointers(db: Database.Database): void {
  const version = (db.prepare("SELECT value FROM sync_settings WHERE key='storage_schema'").get() as any)?.value;
  if (version === 'pointer-v2') return;
  if (version !== 'pointer-v1') throw new Error('Unknown snapshot storage version');
  db.transaction(() => {
    const catalog = new Catalog(db), update = db.prepare('UPDATE sync_items SET evidence_json=? WHERE sync_id=? AND event_key=?');
    for (const row of db.prepare('SELECT i.sync_id,i.event_key,i.evidence_json,s.snapshot_at FROM sync_items i JOIN syncs s ON s.id=i.sync_id ORDER BY i.sync_id,i.rowid').all() as any[]) {
      const item = thawEvidence(db, row.evidence_json);
      try { update.run(encodeEvidence(item, catalog.frozen(item, row.snapshot_at)), row.sync_id, row.event_key); }
      catch { throw new Error(`Pointer migration stopped: sync #${row.sync_id} ${item.ref} could not be matched unambiguously to original pi records. Existing data is intact.`); }
    }
    for (const row of db.prepare('SELECT id,context_json,snapshot_at FROM syncs').all() as any[]) {
      const context = (JSON.parse(row.context_json) as any[]).map(value => {
        const item = thawEvidence(db, value);
        try { return JSON.parse(encodeEvidence(item, catalog.frozen(item, row.snapshot_at))); }
        catch { throw new Error(`Pointer migration stopped: sync #${row.id} ${item.ref} context could not be matched to original pi records. Existing data is intact.`); }
      });
      db.prepare('UPDATE syncs SET context_json=? WHERE id=?').run(JSON.stringify(context), row.id);
    }
    const sequence = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='agent_entries'").get() as any)?.seq || 0;
    db.exec(entryTable('agent_entries_source', false));
    const columns = (db.pragma('table_info(agent_entries_source)') as { name: string }[]).map(column => column.name);
    const insert = db.prepare(`INSERT INTO agent_entries_source(${columns.join(',')}) VALUES(${columns.map(column => '@' + column).join(',')})`);
    for (const row of db.prepare('SELECT * FROM agent_entries ORDER BY id').all() as any[]) {
      try { insert.run(catalog.legacy(row)); }
      catch { throw new Error(`Pointer migration stopped: session entry #${row.id} could not be reconstructed. Existing data is intact.`); }
    }
    db.exec('DROP TABLE agent_entries; ALTER TABLE agent_entries_source RENAME TO agent_entries; CREATE INDEX agent_entries_pending ON agent_entries(active,is_activity,present); CREATE INDEX agent_entries_event ON agent_entries(event_key); DROP TABLE retained_text');
    if (!db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='agent_entries'").run(sequence).changes && sequence) db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run('agent_entries', sequence);
    db.prepare("UPDATE sync_settings SET value='pointer-v2' WHERE key='storage_schema'").run();
  })();
}
