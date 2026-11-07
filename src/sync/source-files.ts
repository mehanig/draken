import type Database from 'better-sqlite3';
import { retainedText } from '../db/retained-text';
import { RecordReader, type NormalizationCache } from './jsonl';
import { getSourceRoots, type RootInput } from '../sources/registry';
export { RECORD_BYTES, getSessionRoot, fileRecords, openSessionFile, verifySessionHeader, type RecordPointer } from './jsonl';

/** Current branch projection. Legacy text is readable only during conversion;
 * the pointer-only schema has no legacy text columns or retained-text table. */
export class EntryReader {
  private reader: RecordReader;
  private row;
  constructor(private db: Database.Database, root: RootInput = getSourceRoots(), cache?: NormalizationCache) {
    this.reader = new RecordReader(root, cache);
    this.row = db.prepare(`SELECT e.*,s.path,s.file_identity,s.agent,s.external_id FROM agent_entries e JOIN agent_sessions s ON s.id=e.session_id WHERE e.id=?`);
  }
  private normalized(row: any) {
    try { return this.reader.read(row.session_id, row.path, row, row.entry_id, row.event_key, row.normalization ?? 2, row.file_identity, { agent: row.agent, external_id: row.external_id || row.session_id, parser_version: row.parser_version ?? 1 }); }
    catch { throw new Error('Original session evidence is unavailable or changed. Scan sessions again or restore the original session file. No copied text was substituted.'); }
  }
  effective(id: number): string {
    const row = this.row.get(id) as any;
    if (!row) throw new Error('Session entry is unavailable');
    if (!row.effective_length) return '';
    const original = row.record_hash ? this.normalized(row) : undefined;
    if (row.effective_legacy_ref) return retainedText(this.db, row.effective_legacy_ref);
    if (row.effective_id !== null) {
      const edit = this.row.get(row.effective_id) as any;
      if (!edit || edit.session_id !== row.session_id || edit.type !== 'context_edit' || edit.target_id !== row.entry_id) throw new Error('Invalid context-edit pointer');
      if (edit.legacy_replacement_ref) return retainedText(this.db, edit.legacy_replacement_ref);
      return this.normalized(edit).replacement || '';
    }
    if (row.legacy_text_ref) return retainedText(this.db, row.legacy_text_ref);
    return (original || this.normalized(row)).text;
  }
  close() { this.reader.close(); }
}
