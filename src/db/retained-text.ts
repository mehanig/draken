import type Database from 'better-sqlite3';
import type { Evidence } from '../types';
import { digest } from '../sync/normalize';

/** Immutable canonical text shared by frozen evidence and unresolvable legacy imports. */
export function retainText(db: Database.Database, text: string): string {
  const key = digest(text);
  db.prepare('INSERT OR IGNORE INTO retained_text(key,text) VALUES(?,?)').run(key, text);
  if (retainedText(db, key) !== text) throw new Error('Retained evidence hash mismatch');
  return key;
}
export function retainedText(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT text FROM retained_text WHERE key=?').get(key) as { text: string } | undefined;
  if (!row || digest(row.text) !== key) throw new Error('Retained evidence is missing or damaged');
  return row.text;
}
export function freezeEvidence(db: Database.Database, item: Evidence): string {
  const { text, ...metadata } = item;
  return JSON.stringify({ ...metadata, text_ref: retainText(db, text) });
}
export function thawEvidence(db: Database.Database, value: string | Record<string, any>): Evidence {
  const item = typeof value === 'string' ? JSON.parse(value) : value;
  // Imported older snapshots and test fixtures remain readable, never silently rewritten on read.
  if (typeof item.text === 'string') return item as Evidence;
  const { text_ref, ...metadata } = item;
  if (typeof text_ref !== 'string') throw new Error('Frozen evidence has no content reference');
  return { ...metadata, text: retainedText(db, text_ref) } as Evidence;
}
