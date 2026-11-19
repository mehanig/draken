import Database from 'better-sqlite3';
import path from 'path';
import { getDataDir } from '../data-dir';
import fs from 'fs';
import { entryTable, migratePointers } from './pointer-migration';
import { migrateSnapshotPointers } from './snapshot-pointers';
import { renameAgentTables, migrateAgents } from './agent-migration';

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
    try { initSchema(db); } catch (error) { db.close(); db = null; throw error; }
  }
  return db;
}

export function initSchema(database: Database.Database): void {
  database.transaction(() => {
  // Seed the new-install default only for a genuinely empty database, before
  // migrations create any objects. Existing databases (even without a saved
  // preference) retain their old behavior; local-only consent is not upgraded.
  const fresh = !database.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get();
  renameAgentTables(database);
  const pointerOnly = database.prepare("SELECT 1 FROM sqlite_schema WHERE name='sync_settings'").get()
    && (database.prepare("SELECT value FROM sync_settings WHERE key='storage_schema'").get() as any)?.value === 'pointer-v2';
  // Existing project/task tables are untouched. The explicit pointer migration
  // below changes representation transactionally, not historical evidence.
  database.exec(`
    CREATE TABLE IF NOT EXISTS sync_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
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
    ${pointerOnly ? '' : 'CREATE TABLE IF NOT EXISTS retained_text (key TEXT PRIMARY KEY, text TEXT NOT NULL);'}
    ${entryTable('agent_entries', !pointerOnly)};
    CREATE INDEX IF NOT EXISTS agent_entries_pending ON agent_entries(active, is_activity, present);
    CREATE INDEX IF NOT EXISTS agent_entries_event ON agent_entries(event_key);
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
    -- Snapshots can be opened independently. Inclusion is not review/coverage.
    DROP INDEX IF EXISTS one_open_sync;
    CREATE TABLE IF NOT EXISTS sync_items (
      sync_id INTEGER NOT NULL REFERENCES syncs(id),
      event_key TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      PRIMARY KEY(sync_id, event_key)
    );
    CREATE INDEX IF NOT EXISTS sync_items_event ON sync_items(event_key);
    CREATE TABLE IF NOT EXISTS sync_presentations (
      sync_id INTEGER PRIMARY KEY REFERENCES syncs(id),
      request_id TEXT UNIQUE,
      memory_inputs_json TEXT NOT NULL DEFAULT '[]',
      recap TEXT NOT NULL DEFAULT '',
      recap_hash TEXT NOT NULL DEFAULT '',
      recap_state TEXT NOT NULL DEFAULT 'empty',
      recap_error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS sync_recap_cache (
      key TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
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
    -- Complete verified leaf boundaries, independent of snapshot/transport labels.
    -- input_json contains frozen original pointers, not transcript text.
    CREATE TABLE IF NOT EXISTS summary_leaf_inputs (
      key TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      recipe TEXT NOT NULL,
      batch INTEGER NOT NULL,
      input_json TEXT NOT NULL,
      output_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS summary_leaf_inputs_model ON summary_leaf_inputs(model);
    -- Planning context is immutable; extra citation dependencies are not planner inputs.
    CREATE TABLE IF NOT EXISTS summary_planning_context (
      sync_id INTEGER PRIMARY KEY REFERENCES syncs(id), refs_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS summary_leaf_plans (
      identity TEXT PRIMARY KEY, keys_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS summary_replay_attempts (
      identity TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS summary_pending_plans (
      identity TEXT PRIMARY KEY, inputs_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS summary_parent_inputs (
      key TEXT PRIMARY KEY, children_json TEXT NOT NULL, compact INTEGER NOT NULL, label TEXT NOT NULL
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
    -- Paid cache preparation has no snapshot, reservation or coverage identity.
    CREATE TABLE IF NOT EXISTS background_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      started_at TEXT NOT NULL,
      completed_at TEXT,
      metrics_json TEXT NOT NULL DEFAULT '[]',
      input_key TEXT NOT NULL,
      source_keys_json TEXT NOT NULL DEFAULT '{}',
      cache_receipt_json TEXT NOT NULL DEFAULT '[]',
      failure_events_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS background_runs_input ON background_runs(input_key, id);
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
    CREATE TABLE IF NOT EXISTS live_calls (
      id TEXT PRIMARY KEY,
      sync_id INTEGER NOT NULL REFERENCES syncs(id),
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_live_call ON live_calls(status) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS live_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT NOT NULL REFERENCES live_calls(id),
      request_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      text TEXT NOT NULL DEFAULT '',
      sources_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'streaming',
      observed_audio_ms INTEGER NOT NULL DEFAULT 0,
      first_audio_ms INTEGER,
      started_at TEXT NOT NULL,
      UNIQUE(call_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS live_messages_call ON live_messages(call_id, id);
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
    conversation_last_user_at: 'TEXT',
    conversation_ended_at: 'TEXT',
    conversation_before: 'TEXT',
  })) {
    if (!columns.has(name)) database.exec(`ALTER TABLE syncs ADD COLUMN ${name} ${definition}`);
  }
  const nodeColumns = new Set((database.prepare('PRAGMA table_info(sync_tree_nodes)').all() as { name: string }[]).map(column => column.name));
  if (!nodeColumns.has('last_run_id')) {
    database.exec(`ALTER TABLE sync_tree_nodes ADD COLUMN last_run_id INTEGER;
      UPDATE sync_tree_nodes SET last_run_id=(SELECT MAX(id) FROM sync_runs WHERE sync_id=sync_tree_nodes.sync_id)`);
  }
  const runColumns = new Set((database.prepare('PRAGMA table_info(sync_runs)').all() as { name: string }[]).map(column => column.name));
  if (!runColumns.has('metrics_json')) database.exec("ALTER TABLE sync_runs ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '[]'");
  if (!runColumns.has('request_id')) database.exec('ALTER TABLE sync_runs ADD COLUMN request_id TEXT');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS sync_run_request ON sync_runs(request_id) WHERE request_id IS NOT NULL');
  database.prepare('UPDATE syncs SET snapshot_at = created_at WHERE snapshot_at IS NULL').run();
  if (!columns.has('conversation_last_user_at')) {
    // Only real user activity seeds the idle clock. Generated replies, polls,
    // receipts and background runs are deliberately absent from this migration.
    database.exec(`UPDATE syncs SET conversation_last_user_at=MAX(created_at,
      COALESCE((SELECT MAX(created_at) FROM sync_messages WHERE sync_id=syncs.id AND role='user'),created_at),
      COALESCE((SELECT MAX(m.started_at) FROM live_messages m JOIN live_calls c ON c.id=m.call_id
        WHERE c.sync_id=syncs.id AND m.role='user' AND TRIM(m.text)!=''),created_at)) WHERE status='open'`);
    // An already used v0.7 chat/call passed explicit history preparation. Retain
    // a conservative cutoff even when a newer receipt format needs refreshing.
    database.exec(`UPDATE syncs SET conversation_before=snapshot_at WHERE status='open'
      AND briefing!='' AND compression_complete=1 AND (
        EXISTS(SELECT 1 FROM sync_runs WHERE sync_id=syncs.id AND request_id IS NOT NULL)
        OR EXISTS(SELECT 1 FROM live_calls WHERE sync_id=syncs.id))`);
    // Also preserve prepared-but-not-yet-used chats from the old read-only
    // receipt. This is historical preparation, NOT validation of current inputs.
    const file = path.join(getDataDir(), 'memory', 'index.sqlite');
    let memory: Database.Database | undefined;
    try {
      if (fs.existsSync(file)) {
        memory = new Database(file, { readonly: true, fileMustExist: true });
        const raw = memory.prepare("SELECT value FROM meta WHERE key='call-history-ready-v1'").get() as { value: string } | undefined;
        const marker = raw && raw.value.length <= 1024 ? JSON.parse(raw.value) : null;
        if (marker && typeof marker.before === 'string' && Number.isFinite(Date.parse(marker.before))
          && new Date(marker.before).toISOString() === marker.before && marker.before <= new Date().toISOString()
          && typeof marker.stamp === 'string' && /^[a-f0-9]{64}$/.test(marker.stamp)
          && typeof marker.model === 'string' && marker.model.length > 0
          && marker.model === (memory.prepare("SELECT value FROM meta WHERE key='model'").get() as { value: string } | undefined)?.value
          && (memory.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined)?.value === 'history-index-v3-contentless') {
          database.prepare(`UPDATE syncs SET conversation_before=? WHERE status='open' AND conversation_before IS NULL
            AND briefing!='' AND compression_complete=1 AND snapshot_at<=?`).run(marker.before, marker.before);
        }
      }
    } catch { /* Missing/old caches do not prevent opening the original database. */ }
    finally { memory?.close(); }
  }
  migratePointers(database); migrateSnapshotPointers(database); migrateAgents(database);
  const sessionColumns = new Set((database.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[]).map(column => column.name));
  if (!sessionColumns.has('scanned_bytes')) database.exec('ALTER TABLE agent_sessions ADD COLUMN scanned_bytes INTEGER NOT NULL DEFAULT -1');
  for (const [name, type] of Object.entries({ first_message_at: 'TEXT', last_message_at: 'TEXT', last_message_preview: "TEXT NOT NULL DEFAULT ''", activity_stamp: "TEXT NOT NULL DEFAULT ''" })) {
    if (!sessionColumns.has(name)) database.exec(`ALTER TABLE agent_sessions ADD COLUMN ${name} ${type}`);
  }
  if (fresh) {
    const seed = database.prepare('INSERT INTO sync_settings(key,value) VALUES (?,?)');
    seed.run('auto_index', 'true');
  }
  // Summary preparation defaults on; explicit saved opt-outs remain untouched.
  // Preserve the saved indexing choice while withdrawing the retired permission
  // to create snapshots and spend provider quota in the background.
  database.exec(`INSERT OR IGNORE INTO sync_settings(key,value)
    SELECT 'auto_index',value FROM sync_settings WHERE key='auto_prepare_conversations';
    DELETE FROM sync_settings WHERE key IN ('auto_prepare_conversations','auto_preparing_sync','auto_briefing_failed');`);
  })();
}

export function closeDb(): void {
  db?.close();
  db = null;
}
