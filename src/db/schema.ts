import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

export function getDataDir(): string {
  return path.resolve(process.env.DRAKEN_DATA_DIR || path.join(os.homedir(), '.draken'));
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dir = getDataDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    db = new Database(path.join(dir, 'draken.db'));
    // Set mode before SQLite creates WAL/SHM sidecars, which inherit database permissions.
    fs.chmodSync(path.join(dir, 'draken.db'), 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    initSchema(db);
  }
  return db;
}

export function initSchema(database: Database.Database): void {
  // Additive migration: legacy projects/tasks are deliberately left untouched.
  database.exec(`
    CREATE TABLE IF NOT EXISTS sync_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pi_sessions (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      cwd TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      included INTEGER NOT NULL DEFAULT 1,
      missing INTEGER NOT NULL DEFAULT 0,
      modified_at TEXT NOT NULL,
      file_identity TEXT NOT NULL DEFAULT '',
      byte_offset INTEGER NOT NULL DEFAULT 0,
      boundary_hash TEXT NOT NULL DEFAULT '',
      prefix_hash TEXT NOT NULL DEFAULT '',
      leaf_id TEXT
    );
    CREATE TABLE IF NOT EXISTS pi_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES pi_sessions(id),
      entry_id TEXT NOT NULL,
      parent_id TEXT,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      effective_text TEXT NOT NULL,
      event_key TEXT NOT NULL,
      is_activity INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      present INTEGER NOT NULL DEFAULT 1,
      target_id TEXT,
      replacement TEXT,
      UNIQUE(session_id, entry_id)
    );
    CREATE INDEX IF NOT EXISTS pi_entries_pending ON pi_entries(active, is_activity, present);
    CREATE INDEX IF NOT EXISTS pi_entries_event ON pi_entries(event_key);
    CREATE TABLE IF NOT EXISTS syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'completed', 'discarded')),
      created_at TEXT NOT NULL,
      completed_at TEXT,
      briefing TEXT NOT NULL DEFAULT '',
      decisions TEXT NOT NULL DEFAULT '',
      carry_forward TEXT NOT NULL DEFAULT '',
      context_json TEXT NOT NULL DEFAULT '[]',
      memory_json TEXT NOT NULL DEFAULT '[]',
      remaining_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_sync ON syncs(status) WHERE status = 'open';
    CREATE TABLE IF NOT EXISTS sync_items (
      sync_id INTEGER NOT NULL REFERENCES syncs(id),
      event_key TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      PRIMARY KEY(sync_id, event_key)
    );
    CREATE TABLE IF NOT EXISTS sync_coverage (
      event_key TEXT PRIMARY KEY,
      sync_id INTEGER NOT NULL REFERENCES syncs(id)
    );
    CREATE TABLE IF NOT EXISTS summary_cache (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      output_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_tree_nodes (
      sync_id INTEGER NOT NULL REFERENCES syncs(id),
      key TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      children_json TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(sync_id, key)
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id INTEGER NOT NULL REFERENCES syncs(id),
      status TEXT NOT NULL DEFAULT 'running',
      stage TEXT NOT NULL DEFAULT 'Planning',
      summary_model TEXT NOT NULL,
      final_model TEXT NOT NULL,
      invocations INTEGER NOT NULL DEFAULT 0,
      max_invocations INTEGER NOT NULL,
      processed_entries INTEGER NOT NULL DEFAULT 0,
      total_entries INTEGER NOT NULL,
      cache_hits INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      question TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS sync_runs_sync ON sync_runs(sync_id, id);
    CREATE TABLE IF NOT EXISTS voice_calls (
      id TEXT PRIMARY KEY,
      sync_id INTEGER NOT NULL REFERENCES syncs(id),
      status TEXT NOT NULL DEFAULT 'active',
      model TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_voice_call ON voice_calls(status) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS voice_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT NOT NULL REFERENCES voice_calls(id),
      request_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      heard_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'thinking',
      error TEXT NOT NULL DEFAULT '',
      messages_saved INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      model_ms INTEGER,
      first_audio_ms INTEGER,
      UNIQUE(call_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS voice_turns_call ON voice_turns(call_id, id);
    CREATE TABLE IF NOT EXISTS sync_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id INTEGER NOT NULL REFERENCES syncs(id),
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const columns = new Set((database.prepare('PRAGMA table_info(syncs)').all() as { name: string }[]).map(column => column.name));
  for (const [name, definition] of Object.entries({
    snapshot_version: 'INTEGER NOT NULL DEFAULT 1',
    snapshot_at: 'TEXT',
    model_config_json: "TEXT NOT NULL DEFAULT '{}'",
    compression_complete: 'INTEGER NOT NULL DEFAULT 0',
  })) {
    if (!columns.has(name)) database.exec(`ALTER TABLE syncs ADD COLUMN ${name} ${definition}`);
  }
  database.prepare('UPDATE syncs SET snapshot_at = created_at WHERE snapshot_at IS NULL').run();
}

export function closeDb(): void {
  db?.close();
  db = null;
}
