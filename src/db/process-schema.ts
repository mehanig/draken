import type Database from 'better-sqlite3';

export function initProcessSchema(db: Database.Database): void {
  const migrateErrors = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preparation_errors'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS preparation_errors (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, operation_key TEXT NOT NULL,
      run_id INTEGER, entity_id TEXT, error TEXT NOT NULL, created_at TEXT NOT NULL,
      retry_state INTEGER NOT NULL DEFAULT 0, details_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS preparation_errors_operation ON preparation_errors(scope,operation_key,id);
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
    CREATE TABLE IF NOT EXISTS workflow_enrichments (
      id INTEGER PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES process_extractions(id),
      revision TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      recipe_version TEXT NOT NULL,
      model TEXT NOT NULL,
      run_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
      raw_output TEXT,
      output_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS workflow_enrichments_source ON workflow_enrichments(workflow_id,revision,policy_version,recipe_version);
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
  const columns = new Set((db.prepare('PRAGMA table_info(work_episodes)').all() as { name: string }[]).map(c => c.name));
  if (!columns.has('learning_status')) db.exec("ALTER TABLE work_episodes ADD COLUMN learning_status TEXT NOT NULL DEFAULT 'pending' CHECK(learning_status IN ('pending','completed'))");
  if (!columns.has('superseded_by')) db.exec('ALTER TABLE work_episodes ADD COLUMN superseded_by TEXT REFERENCES work_episodes(id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_reconstructions (
      id TEXT PRIMARY KEY, input_key TEXT NOT NULL, recipe_version TEXT NOT NULL, model TEXT NOT NULL,
      current_extraction TEXT NOT NULL REFERENCES process_extractions(id), current_fragment TEXT NOT NULL,
      run_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
      source_dependencies_json TEXT NOT NULL, raw_output TEXT, output_json TEXT, error TEXT,
      created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS episode_revisions (
      episode_id TEXT NOT NULL REFERENCES work_episodes(id), revision INTEGER NOT NULL,
      reconstruction_id TEXT NOT NULL REFERENCES episode_reconstructions(id),
      PRIMARY KEY(episode_id,revision)
    );
    CREATE TABLE IF NOT EXISTS episode_memberships (
      extraction_id TEXT NOT NULL REFERENCES process_extractions(id), fragment_key TEXT NOT NULL,
      episode_id TEXT NOT NULL REFERENCES work_episodes(id),
      PRIMARY KEY(extraction_id,fragment_key)
    );
    CREATE INDEX IF NOT EXISTS episode_memberships_episode ON episode_memberships(episode_id);
    CREATE INDEX IF NOT EXISTS episode_reconstruction_input ON episode_reconstructions(input_key);
  `);
  const revisionColumns = new Set((db.prepare('PRAGMA table_info(episode_revisions)').all() as { name: string }[]).map(c => c.name));
  if (!revisionColumns.has('assembly_index')) db.exec('ALTER TABLE episode_revisions ADD COLUMN assembly_index INTEGER');
  const enrichmentColumns = new Set((db.prepare('PRAGMA table_info(workflow_enrichments)').all() as { name: string }[]).map(c => c.name));
  if (!enrichmentColumns.has('run_table')) db.exec("ALTER TABLE workflow_enrichments ADD COLUMN run_table TEXT NOT NULL DEFAULT 'background_runs' CHECK(run_table IN ('background_runs','sync_runs'))");
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_discoveries (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL CHECK(origin IN ('recurring','requested')),
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source_json TEXT,
      output_json TEXT,
      request_json TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_consolidation_batches (
      id TEXT PRIMARY KEY, run_id INTEGER NOT NULL, model TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
      source_json TEXT NOT NULL, raw_output TEXT, output_json TEXT, error TEXT,
      request TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_consolidations (
      workflow_id TEXT PRIMARY KEY REFERENCES workflow_discoveries(id),
      batch_id TEXT NOT NULL REFERENCES workflow_consolidation_batches(id),
      group_index INTEGER NOT NULL, task_parents_json TEXT NOT NULL,
      UNIQUE(batch_id,group_index)
    );
    CREATE TABLE IF NOT EXISTS workflow_consolidation_members (
      source_id TEXT PRIMARY KEY REFERENCES workflow_discoveries(id),
      workflow_id TEXT NOT NULL REFERENCES workflow_discoveries(id),
      CHECK(source_id<>workflow_id)
    );
    CREATE VIEW IF NOT EXISTS active_workflow_discoveries AS
      SELECT d.rowid cursor,d.* FROM workflow_discoveries d
      WHERE NOT EXISTS (SELECT 1 FROM workflow_consolidation_members m WHERE m.source_id=d.id)
        AND NOT EXISTS (SELECT 1 FROM workflow_consolidations c JOIN workflow_consolidation_batches b ON b.id=c.batch_id
          WHERE c.workflow_id=d.id AND b.status<>'completed');
    CREATE TABLE IF NOT EXISTS workflow_requests (
      request_id TEXT PRIMARY KEY,
      sync_id INTEGER NOT NULL REFERENCES syncs(id),
      turn_key TEXT NOT NULL,
      request_json TEXT NOT NULL,
      run_id INTEGER NOT NULL REFERENCES sync_runs(id),
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
      workflow_id TEXT REFERENCES workflow_discoveries(id),
      raw_output TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(sync_id,turn_key)
    );
    INSERT OR IGNORE INTO workflow_discoveries(id,origin,model,created_at)
      SELECT id,'recurring',model,created_at FROM process_extractions
      WHERE (kind='comparison' AND status='completed' AND CASE WHEN json_valid(output_json) THEN json_extract(output_json,'$.sameWorkflow')=1 AND json_extract(output_json,'$.assessment.reuse') IS NULL ELSE 0 END)
        OR id IN (SELECT workflow_id FROM workflow_enrichments);
    DROP TRIGGER IF EXISTS workflow_discovery_insert;
    DROP TRIGGER IF EXISTS workflow_discovery_update;
    CREATE TRIGGER workflow_discovery_insert AFTER INSERT ON process_extractions
      WHEN NEW.kind='comparison' AND NEW.status='completed' AND CASE WHEN json_valid(NEW.output_json) THEN json_extract(NEW.output_json,'$.sameWorkflow')=1 AND json_extract(NEW.output_json,'$.assessment.reuse') IS NULL ELSE 0 END
      BEGIN INSERT OR IGNORE INTO workflow_discoveries(id,origin,model,created_at) VALUES(NEW.id,'recurring',NEW.model,NEW.created_at); END;
    CREATE TRIGGER workflow_discovery_update AFTER UPDATE OF status,output_json ON process_extractions
      WHEN NEW.kind='comparison' AND NEW.status='completed' AND CASE WHEN json_valid(NEW.output_json) THEN json_extract(NEW.output_json,'$.sameWorkflow')=1 AND json_extract(NEW.output_json,'$.assessment.reuse') IS NULL ELSE 0 END
      BEGIN INSERT OR IGNORE INTO workflow_discoveries(id,origin,model,created_at) VALUES(NEW.id,'recurring',NEW.model,NEW.created_at); END;
  `);
  if (!(db.prepare('PRAGMA table_info(workflow_discoveries)').all() as { name: string }[]).some(c => c.name === 'display_json')) db.exec('ALTER TABLE workflow_discoveries ADD COLUMN display_json TEXT');
  if ((db.prepare('PRAGMA foreign_key_list(workflow_enrichments)').all() as { table: string }[]).some(fk => fk.table === 'process_extractions')) db.transaction(() => {
    db.exec(`CREATE TABLE workflow_enrichments_next (
      id INTEGER PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_discoveries(id),
      revision TEXT NOT NULL, policy_version TEXT NOT NULL, recipe_version TEXT NOT NULL,
      model TEXT NOT NULL, run_id INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
      raw_output TEXT, output_json TEXT, created_at TEXT NOT NULL, completed_at TEXT,
      run_table TEXT NOT NULL DEFAULT 'background_runs' CHECK(run_table IN ('background_runs','sync_runs'))
    );
    INSERT INTO workflow_enrichments_next SELECT id,workflow_id,revision,policy_version,recipe_version,model,run_id,status,raw_output,output_json,created_at,completed_at,run_table FROM workflow_enrichments;
    DROP TABLE workflow_enrichments;
    ALTER TABLE workflow_enrichments_next RENAME TO workflow_enrichments;
    CREATE INDEX workflow_enrichments_source ON workflow_enrichments(workflow_id,revision,policy_version,recipe_version);`);
  })();
  if (migrateErrors) db.exec(`
    INSERT INTO preparation_errors(scope,operation_key,run_id,entity_id,error,created_at)
      SELECT 'reconstruction',r.model||':'||r.current_extraction||':'||r.current_fragment,r.run_id,
        (SELECT episode_id FROM episode_extractions WHERE extraction_id=r.current_extraction AND fragment_key=r.current_fragment LIMIT 1),
        COALESCE(r.error,'Task reconstruction failed'),COALESCE(r.completed_at,r.created_at)
      FROM episode_reconstructions r WHERE r.status='failed' ORDER BY r.rowid;
    INSERT INTO preparation_errors(scope,operation_key,run_id,entity_id,error,created_at)
      SELECT 'comparison',json_array(recipe_version,model,json_array(min(left_id,right_id),max(left_id,right_id))),run_id,entity,
        COALESCE(message,'Workflow comparison failed'),at
      FROM (SELECT recipe_version,model,json_extract(usage_json,'$.backgroundRun') run_id,
        json_extract(source_dependencies_json,'$.parents[0].episode') entity,
        json_extract(output_json,'$.failure.message') message,COALESCE(completed_at,created_at) at,
        json_extract(source_dependencies_json,'$.identities['||json_extract(source_dependencies_json,'$.pair[0]')||']') left_id,
        json_extract(source_dependencies_json,'$.identities['||json_extract(source_dependencies_json,'$.pair[1]')||']') right_id
        FROM process_extractions WHERE kind='comparison' AND status='failed' AND json_extract(source_dependencies_json,'$.phase')='match');
    INSERT INTO preparation_errors(scope,operation_key,run_id,error,created_at)
      SELECT 'enrichment',workflow_id||':'||revision||':'||model,run_id,'Workflow enrichment failed',COALESCE(completed_at,created_at)
      FROM workflow_enrichments WHERE status='failed' AND run_table='background_runs';
  `);
}
