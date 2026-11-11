import fs from 'fs';
import type Database from 'better-sqlite3';
import { fileRecords, getSessionRoot, openSessionFile, verifySessionHeader, type RecordPointer } from '../sync/jsonl';
import { normalizeEntry, type NormalizedEntry } from '../sync/normalize';
import { freezeEvidence, retainText, thawEvidence } from './retained-text';

export function entryTable(name: string, legacy = true): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    entry_id TEXT NOT NULL, parent_id TEXT, timestamp TEXT NOT NULL,
    type TEXT NOT NULL, role TEXT NOT NULL, event_key TEXT NOT NULL,
    is_activity INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0,
    present INTEGER NOT NULL DEFAULT 1, target_id TEXT,
    record_offset INTEGER, record_bytes INTEGER, record_hash TEXT,
    text_length INTEGER NOT NULL DEFAULT 0, replacement_length INTEGER NOT NULL DEFAULT 0,
    effective_length INTEGER NOT NULL DEFAULT 0, effective_id INTEGER,
    normalization INTEGER NOT NULL DEFAULT 2,
    ${legacy ? `legacy_text_ref TEXT REFERENCES retained_text(key),
    legacy_replacement_ref TEXT REFERENCES retained_text(key),
    effective_legacy_ref TEXT REFERENCES retained_text(key),` : ''}
    UNIQUE(session_id,entry_id)
  )`;
}

/** Atomic representation migration. No scans, model calls, review or source-file writes.
 * Unverifiable historical imports are preserved once, not discarded or guessed.
 */
export function migratePointers(db: Database.Database): void {
  const version = (db.prepare("SELECT value FROM sync_settings WHERE key='storage_schema'").get() as any)?.value;
  if (version === 'pointer-v1' || version === 'pointer-v2') return;
  if (version) throw new Error('Unknown canonical storage version; existing data was not converted');
  db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(agent_entries)').all() as { name: string }[];
    if (columns.some(column => column.name === 'text')) {
      const sequence = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='agent_entries'").get() as any)?.seq || 0;
      db.exec(entryTable('agent_entries_pointer'));
      const insert = db.prepare(`INSERT INTO agent_entries_pointer
        (id,session_id,entry_id,parent_id,timestamp,type,role,event_key,is_activity,active,present,target_id,
         record_offset,record_bytes,record_hash,text_length,replacement_length,effective_length,effective_id,legacy_text_ref,legacy_replacement_ref,effective_legacy_ref)
        VALUES (@id,@session_id,@entry_id,@parent_id,@timestamp,@type,@role,@event_key,@is_activity,@active,@present,@target_id,
         @record_offset,@record_bytes,@record_hash,@text_length,@replacement_length,@effective_length,@effective_id,@legacy_text_ref,@legacy_replacement_ref,@effective_legacy_ref)`);
      for (const session of db.prepare('SELECT id,path,file_identity,byte_offset,leaf_id FROM agent_sessions').all() as any[]) {
        const originals = db.prepare('SELECT * FROM agent_entries WHERE session_id=? ORDER BY id').all(session.id) as any[];
        const wanted = new Set(originals.map(row => row.entry_id));
        const found = new Map<string, RecordPointer & { entry: NormalizedEntry }>();
        let fd: number | undefined;
        try {
          fd = openSessionFile(session.path, getSessionRoot(), session.file_identity);
          verifySessionHeader(fd, session.id);
          for (const pointer of fileRecords(fd, Math.min(fs.fstatSync(fd).size, session.byte_offset))) {
            if (!wanted.has(pointer.value?.id)) continue;
            const entry = normalizeEntry(pointer.value);
            if (entry) found.set(entry.entry_id, { record_offset: pointer.record_offset, record_bytes: pointer.record_bytes, record_hash: pointer.record_hash, entry });
          }
        } catch { found.clear(); } // Retain old text when a source cannot be safely verified.
        finally { if (fd !== undefined) fs.closeSync(fd); }
        const byId = new Map(originals.filter(row => row.present).map(row => [row.entry_id, row]));
        const branch: any[] = [], visited = new Set<string>(), edits = new Map<string, any>();
        let leaf = session.leaf_id;
        while (leaf && byId.has(leaf) && !visited.has(leaf)) { visited.add(leaf); const entry = byId.get(leaf)!; branch.push(entry); leaf = entry.parent_id; }
        for (const edit of branch.reverse()) if (edit.active && edit.type === 'context_edit' && edit.target_id) edits.set(edit.target_id, edit);
        for (const row of originals) {
          const edit = row.active ? edits.get(row.entry_id) : undefined;
          const effectiveId = edit && (edit.replacement || '') === row.effective_text ? edit.id : null;
          const pointer = found.get(row.entry_id);
          const verified = pointer && pointer.entry.event_key === row.event_key && pointer.entry.text === row.text && pointer.entry.replacement === row.replacement;
          insert.run({ ...row,
            record_offset: verified ? pointer.record_offset : null, record_bytes: verified ? pointer.record_bytes : null, record_hash: verified ? pointer.record_hash : null,
            text_length: row.text.length, replacement_length: row.replacement?.length || 0, effective_length: row.effective_text.length, effective_id: effectiveId,
            legacy_text_ref: !verified && row.text ? retainText(db, row.text) : null,
            legacy_replacement_ref: !verified && row.replacement !== null ? retainText(db, row.replacement) : null,
            effective_legacy_ref: !effectiveId && row.effective_text && row.effective_text !== row.text ? retainText(db, row.effective_text) : null,
          });
        }
      }
      const before = (db.prepare('SELECT COUNT(*) n FROM agent_entries').get() as any).n;
      if ((db.prepare('SELECT COUNT(*) n FROM agent_entries_pointer').get() as any).n !== before) throw new Error('Pointer migration did not preserve every session entry');
      db.exec('DROP TABLE agent_entries; ALTER TABLE agent_entries_pointer RENAME TO agent_entries');
      if (!db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='agent_entries'").run(sequence).changes && sequence) db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run('agent_entries', sequence);
    }
    db.exec('CREATE INDEX IF NOT EXISTS agent_entries_pending ON agent_entries(active,is_activity,present); CREATE INDEX IF NOT EXISTS agent_entries_event ON agent_entries(event_key)');
    const update = db.prepare('UPDATE sync_items SET evidence_json=? WHERE sync_id=? AND event_key=?');
    for (const row of db.prepare('SELECT sync_id,event_key,evidence_json FROM sync_items').all() as any[]) {
      update.run(freezeEvidence(db, thawEvidence(db, row.evidence_json)), row.sync_id, row.event_key);
    }
    for (const row of db.prepare('SELECT id,context_json FROM syncs').all() as any[]) {
      const context = (JSON.parse(row.context_json) as any[]).map(item => JSON.parse(freezeEvidence(db, thawEvidence(db, item))));
      db.prepare('UPDATE syncs SET context_json=? WHERE id=?').run(JSON.stringify(context), row.id);
    }
    db.prepare("INSERT OR REPLACE INTO sync_settings VALUES('storage_schema','pointer-v1')").run();
  })();
}
