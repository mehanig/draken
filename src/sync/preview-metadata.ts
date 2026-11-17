import type Database from 'better-sqlite3';

// Audited writes of SummaryTree.forPreview().previewCounts(): no outputs,
// parents, histories, source rows, settings, accounting, or vector databases.
// cached() only reads aliases; it does not promote/create summary_cache rows.
const tables = {
  summary_leaf_inputs: ['key', 'model', 'recipe', 'batch', 'input_json', 'output_hash'],
  summary_leaf_plans: ['identity', 'keys_json'],
  summary_pending_plans: ['identity', 'inputs_json'],
  summary_replay_attempts: ['identity'],
} as const;

/** Defense in depth on the PRIVATE clone only. Record the narrow delta without
 * sending receipts (or source bodies) through IPC. Unexpected planner writes
 * fail the job rather than broadening the merge contract. */
export function guardPreviewWrites(db: Database.Database): void {
  db.exec('CREATE TABLE preview_changes (name TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(name,key))');
  const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name!='preview_changes'").all() as { name: string }[];
  for (const [index, { name }] of names.entries()) {
    const quoted = '"' + name.replace(/"/g, '""') + '"';
    const columns = tables[name as keyof typeof tables];
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      if (columns && event !== 'DELETE') {
        db.exec(`CREATE TEMP TRIGGER "preview_track_${index}_${event}" AFTER ${event} ON ${quoted}
          BEGIN INSERT OR IGNORE INTO preview_changes VALUES ('${name}',new.${columns[0]}); END`);
      } else {
        db.exec(`CREATE TEMP TRIGGER "preview_deny_${index}_${event}" BEFORE ${event} ON ${quoted}
          BEGIN SELECT RAISE(ABORT,'Forbidden preview database write'); END`);
      }
    }
  }
}

/** Caller holds an IMMEDIATE transaction and has checked the pre-backup
 * revisions/data_version/models/roots/deadline under that lock. Thus no live
 * receipt or its output can have changed since the snapshot. Only touched
 * planner metadata is retained, atomically, with no deletions or output writes. */
export function importPreviewMetadata(db: Database.Database): void {
  for (const [table, columns] of Object.entries(tables)) {
    db.exec(`INSERT OR REPLACE INTO main.${table} (${columns.join(',')})
      SELECT ${columns.join(',')} FROM preview_clone.${table} WHERE ${columns[0]} IN
        (SELECT key FROM preview_clone.preview_changes WHERE name='${table}')`);
  }
}
