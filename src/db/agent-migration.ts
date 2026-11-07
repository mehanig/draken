import type Database from 'better-sqlite3';

/** Runs inside initSchema's transaction, before any generic schema statements.
 * ALTER TABLE preserves row IDs, foreign keys and AUTOINCREMENT high-water marks.
 * There are deliberately no writable pi_* aliases or copied session tables. */
export function renameAgentTables(db: Database.Database): void {
  const has = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  if (has('pi_sessions') || has('pi_entries')) {
    if (!has('pi_sessions') || !has('pi_entries') || has('agent_sessions') || has('agent_entries')) throw new Error('Ambiguous agent schema; existing data was not changed');
    db.exec('ALTER TABLE pi_sessions RENAME TO agent_sessions; ALTER TABLE pi_entries RENAME TO agent_entries; DROP INDEX IF EXISTS pi_entries_pending; DROP INDEX IF EXISTS pi_entries_event');
  }
}
export function migrateAgents(db: Database.Database): void {
  const marker = (db.prepare("SELECT value FROM sync_settings WHERE key='source_schema'").get() as any)?.value;
  if (marker && marker !== 'agents-v1') throw new Error('Unknown agent source schema; existing data was not changed');
  db.exec(`CREATE TABLE IF NOT EXISTS agent_sources(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
    INSERT OR IGNORE INTO agent_sources VALUES('pi',1),('codex',0),('claude',0);`);
  const columns = new Set((db.pragma('table_info(agent_sessions)') as {name:string}[]).map(row => row.name));
  if (!columns.has('agent')) db.exec("ALTER TABLE agent_sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'pi'");
  if (!columns.has('external_id')) {
    db.exec('ALTER TABLE agent_sessions ADD COLUMN external_id TEXT');
    db.exec('UPDATE agent_sessions SET external_id=id');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_identity ON agent_sessions(agent,external_id)');
  if (!(db.pragma('table_info(agent_entries)') as {name:string}[]).some(row => row.name === 'parser_version')) db.exec('ALTER TABLE agent_entries ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1');
  db.prepare("INSERT OR IGNORE INTO sync_settings VALUES('source_schema','agents-v1')").run();
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Agent migration failed foreign-key verification');
}
