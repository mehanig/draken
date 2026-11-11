import type Database from 'better-sqlite3';
import type { Evidence } from '../types';
import { cleanText, digest, sourceKey, type NormalizationVersion } from '../sync/normalize';
import { RecordReader, type RecordPointer, type NormalizationCache } from '../sync/jsonl';
import { getSourceRoots, sessionId, validIdentity, type RootInput, type SourceIdentity } from '../sources/registry';

export interface FrozenPointer {
  version: 1 | 2;
  source?: SourceIdentity;
  original: RecordPointer;
  normalization: NormalizationVersion;
  edit?: RecordPointer & { entry_id: string; event_key: string; normalization: NormalizationVersion };
  clip?: { limit: number; normalization: NormalizationVersion };
  text_hash: string;
  legacy_edit_match?: true;
}
const pointers = new WeakMap<Evidence, FrozenPointer>();
const UNAVAILABLE_EVIDENCE = 'Original session evidence is unavailable or changed. Restore the original session file; Draken does not keep a text copy.';
export const recordPointer = (row: RecordPointer): RecordPointer => ({ record_offset: row.record_offset, record_bytes: row.record_bytes, record_hash: row.record_hash });
export function encodeEvidence(item: Evidence, pointer: FrozenPointer): string {
  const { text: _text, unavailable: _unavailable, ...metadata } = item;
  return JSON.stringify({ ...metadata, source_key: sourceKey(item), source_pointer: pointer });
}

/** Live frozen membership, attribution and projection require original records.
 * Copied-text compatibility belongs to migration, not snapshot reads.
 * Share one reader per snapshot/request rather than reopening a file per item. */
export class EvidenceReader {
  private reader: RecordReader;
  private paths = new Map<string, string | undefined>();
  constructor(private db: Database.Database, root: RootInput = getSourceRoots(), cache?: NormalizationCache) { this.reader = new RecordReader(root, cache); }
  project(item: Evidence, pointer: FrozenPointer): string {
    if (pointer.version !== 1 && pointer.version !== 2) throw new Error('Unknown frozen pointer version');
    const source: SourceIdentity = pointer.version === 1 ? { agent: 'pi', external_id: item.session_id, parser_version: 1 } : pointer.source!;
    if (pointer.version === 2 && (!validIdentity(source) || sessionId(source) !== item.session_id)) throw new Error('Frozen source identity changed');
    if (item.agent && item.agent !== source.agent) throw new Error('Frozen agent attribution changed');
    if (!this.paths.has(item.session_id)) this.paths.set(item.session_id, (this.db.prepare('SELECT path FROM agent_sessions WHERE id=?').get(item.session_id) as any)?.path);
    const paths = [...new Set([this.paths.get(item.session_id), item.source_path].filter((value): value is string => Boolean(value)))];
    for (const file of paths) {
      try {
        const original = this.reader.read(item.session_id, file, pointer.original, item.entry_id, item.event_key, pointer.normalization, undefined, source);
        if (original.role !== item.role || original.timestamp !== item.timestamp) throw new Error('Frozen attribution changed');
        let text = original.text;
        if (pointer.edit) {
          const edit = this.reader.read(item.session_id, file, pointer.edit, pointer.edit.entry_id, pointer.edit.event_key, pointer.edit.normalization, undefined, source);
          if (edit.type !== 'context_edit' || edit.target_id !== item.entry_id || edit.replacement === null) throw new Error('Invalid frozen edit');
          text = edit.replacement;
        }
        if (pointer.clip) {
          if (pointer.clip.limit !== 2000) throw new Error('Unknown frozen excerpt limit');
          text = cleanText(text, pointer.clip.limit, pointer.clip.normalization);
        }
        if (digest(text) !== pointer.text_hash) throw new Error('Frozen projection changed');
        return text;
      } catch { /* A recorded old path may still resolve after a file move. */ }
    }
    throw new Error(UNAVAILABLE_EVIDENCE);
  }
  read(value: string | Record<string, any>, tolerateUnavailable = false): Evidence {
    const encoded = typeof value === 'string' ? JSON.parse(value) : value;
    const { source_pointer, source_key, ...metadata } = encoded;
    let item: Evidence;
    try {
      if (!source_pointer) throw new Error(UNAVAILABLE_EVIDENCE);
      item = { ...metadata, text: this.project(metadata as Evidence, source_pointer) };
    }
    catch (error) {
      if (!tolerateUnavailable) throw error;
      item = { ...metadata, text: '', source_key, unavailable: UNAVAILABLE_EVIDENCE } as Evidence;
    }
    if (source_pointer) pointers.set(item, source_pointer);
    return item;
  }
  freeze(item: Evidence): string {
    const previous = pointers.get(item);
    if (previous) {
      if (this.project(item, previous) !== item.text) throw new Error('Frozen evidence changed');
      return encodeEvidence(item, previous);
    }
    const row = this.db.prepare('SELECT e.*,s.agent,s.external_id FROM agent_entries e JOIN agent_sessions s ON s.id=e.session_id WHERE e.session_id=? AND e.entry_id=?').get(item.session_id, item.entry_id) as any;
    if (!row || row.event_key !== item.event_key || !row.record_hash) throw new Error('Cannot freeze evidence without its verified source record');
    const pointer: FrozenPointer = { version: row.agent === 'pi' ? 1 : 2, ...(row.agent !== 'pi' ? { source: { agent: row.agent, external_id: row.external_id, parser_version: row.parser_version ?? 1 } } : {}), original: recordPointer(row), normalization: row.normalization ?? 2, text_hash: digest(item.text) };
    if (row.effective_id !== null) {
      const edit = this.db.prepare('SELECT * FROM agent_entries WHERE id=? AND session_id=?').get(row.effective_id, item.session_id) as any;
      if (!edit || edit.target_id !== item.entry_id || !edit.record_hash) throw new Error('Cannot freeze an unverified context edit');
      pointer.edit = { ...recordPointer(edit), entry_id: edit.entry_id, event_key: edit.event_key, normalization: edit.normalization ?? 2 };
    }
    try { this.project(item, pointer); }
    catch { pointer.clip = { limit: 2000, normalization: 2 }; this.project(item, pointer); }
    pointers.set(item, pointer); return encodeEvidence(item, pointer);
  }
  close() { this.reader.close(); this.paths.clear(); }
}
