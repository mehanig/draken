import type Database from 'better-sqlite3';
import { sessionId, type SourceIdentity } from '../sources/registry';
import type { NormalizedEntry, NormalizationVersion } from '../sync/normalize';
import type { RecordPointer } from '../sync/jsonl';

export function sessionRecordKey(source: SourceIdentity, pointer: RecordPointer, version: NormalizationVersion): string {
  return JSON.stringify([source.agent, source.external_id, source.parser_version, pointer.record_offset, pointer.record_hash, version]);
}

/** Ingestion owns content storage. Readers never write or reopen processed records. */
export function saveSessionRecord(db: Database.Database, source: SourceIdentity, pointer: RecordPointer, version: NormalizationVersion, entry: NormalizedEntry): void {
  db.prepare('INSERT OR IGNORE INTO session_records(key,session_id,record_json) VALUES (?,?,?)')
    .run(sessionRecordKey(source, pointer, version), sessionId(source), JSON.stringify(entry));
}
