import type Database from 'better-sqlite3';

/** Additive process knowledge. No raw transcript bodies, no review/coverage writes. */
export function initProcessSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS process_extractions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('summary','comparison')),
      input_key TEXT NOT NULL,
      recipe_version TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
      source_dependencies_json TEXT NOT NULL,
      output_json TEXT,
      usage_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS process_extractions_input ON process_extractions(input_key,recipe_version,model);
    CREATE TABLE IF NOT EXISTS work_episodes (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL CHECK(state IN ('partial','completed','blocked','unknown')),
      description_json TEXT NOT NULL,
      assembly TEXT NOT NULL DEFAULT 'fragment' CHECK(assembly IN ('fragment','reconciled'))
    );
    CREATE TABLE IF NOT EXISTS episode_extractions (
      episode_id TEXT NOT NULL REFERENCES work_episodes(id),
      extraction_id TEXT NOT NULL REFERENCES process_extractions(id),
      fragment_key TEXT NOT NULL,
      PRIMARY KEY(episode_id,extraction_id,fragment_key)
    );
  `);
}
