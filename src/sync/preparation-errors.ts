import { getDb } from '../db/schema';
import { HttpError } from '../errors';
import { cleanText } from './normalize';

export class SkippedPreparationOperation extends Error {}
export function isPreparationLimit(error: unknown): boolean {
  return error instanceof HttpError && error.status === 409 && error.message.startsWith('Invocation budget reached.');
}
export function preparationOperationFailed(scope: string, key: string): boolean {
  const row = getDb().prepare('SELECT retry_state FROM preparation_errors WHERE scope=? AND operation_key=? ORDER BY id DESC LIMIT 1').get(scope, key) as { retry_state: number } | undefined;
  return row?.retry_state === 0;
}
export function preparationRetryRequested(scope: string, key: string): boolean {
  return (getDb().prepare('SELECT retry_state FROM preparation_errors WHERE scope=? AND operation_key=? ORDER BY id DESC LIMIT 1').get(scope, key) as { retry_state: number } | undefined)?.retry_state === 1;
}
export function preparationErrorCount(): number {
  return (getDb().prepare(`WITH receipts(scope,operation_key,run_id) AS (
    SELECT 'process-extraction',model||':'||json_extract(source_dependencies_json,'$.leaf'),json_extract(usage_json,'$.summaryRun.id') FROM process_extractions WHERE kind='summary' AND status='failed'
    UNION ALL SELECT 'reconstruction',model||':'||current_extraction||':'||current_fragment,run_id FROM episode_reconstructions WHERE status='failed'
    UNION ALL SELECT 'enrichment',workflow_id||':'||revision||':'||model,run_id FROM workflow_enrichments WHERE status='failed' AND run_table='background_runs'
    UNION ALL SELECT CASE WHEN json_extract(source_dependencies_json,'$.phase')='select' THEN 'workflow-task' ELSE 'comparison' END,
      CASE WHEN json_extract(source_dependencies_json,'$.phase')='select' THEN model||':'||json_extract(source_dependencies_json,'$.parents[0].episode')||':'||json_extract(source_dependencies_json,'$.parents[0].revision')
      ELSE json_array(recipe_version,model,json_array(min(left_id,right_id),max(left_id,right_id))) END,json_extract(usage_json,'$.backgroundRun')
      FROM (SELECT *,json_extract(source_dependencies_json,'$.identities['||json_extract(source_dependencies_json,'$.pair[0]')||']') left_id,
        json_extract(source_dependencies_json,'$.identities['||json_extract(source_dependencies_json,'$.pair[1]')||']') right_id FROM process_extractions WHERE kind='comparison' AND status='failed')
  ) SELECT (SELECT COUNT(*) FROM preparation_errors) + (SELECT COUNT(*) FROM receipts r WHERE NOT EXISTS
    (SELECT 1 FROM preparation_errors e WHERE e.scope=r.scope AND e.operation_key=r.operation_key AND e.run_id IS r.run_id)) n`).get() as { n: number }).n;
}
export function failedPreparationOperations(): number {
  return (getDb().prepare('SELECT COUNT(*) n FROM preparation_errors WHERE retry_state=0 AND id IN (SELECT MAX(id) FROM preparation_errors GROUP BY scope,operation_key)').get() as { n: number }).n;
}
export function preparationRetryPending(): boolean {
  return !!getDb().prepare('SELECT 1 FROM preparation_errors WHERE retry_state=1 LIMIT 1').get();
}
export function finishPreparationRetries(): void {
  // Unvisited failures may no longer belong to current work. Keep them failed, not queued forever.
  getDb().prepare('UPDATE preparation_errors SET retry_state=0 WHERE retry_state=1').run();
}
export function retryPreparationErrors(): void {
  const db = getDb();
  db.prepare("UPDATE work_episodes SET learning_status='pending' WHERE superseded_by IS NULL AND id IN (SELECT entity_id FROM preparation_errors WHERE retry_state=0)").run();
  db.prepare('UPDATE preparation_errors SET retry_state=1 WHERE retry_state=0').run();
}
export function recordPreparationError(run: number | undefined, scope: string, key: string, error: unknown, entity?: string, details: unknown = {}, retryState = 0): void {
  const db = getDb(), at = new Date().toISOString();
  const message = cleanText(error instanceof Error ? error.message : String(error), 1500);
  db.transaction(() => {
    db.prepare('UPDATE preparation_errors SET retry_state=2 WHERE scope=? AND operation_key=? AND retry_state=1').run(scope, key);
    const id = Number(db.prepare('INSERT INTO preparation_errors(scope,operation_key,run_id,entity_id,error,created_at,details_json,retry_state) VALUES (?,?,?,?,?,?,?,?)')
      .run(scope, key, run ?? null, entity ?? null, message, at, JSON.stringify(details), retryState).lastInsertRowid);
    if (run !== undefined) db.prepare("UPDATE background_runs SET failure_events_json=json_insert(failure_events_json,'$[#]',json(?)) WHERE id=?")
      .run(JSON.stringify({ status: 'failed', at, scope, error_id: id }), run);
    console.warn(`Preparation error #${id} (${scope}) recorded. Continuing independent work.`);
  })();
}
export async function preparationOperation<T>(run: number | undefined, scope: string, key: string, signal: AbortSignal, work: () => Promise<T>, entity?: string, details?: () => unknown): Promise<{ ok: true; value: T } | { ok: false }> {
  const check = () => { if (signal.aborted) throw new HttpError(409, 'Generation cancelled'); };
  check();
  if (preparationOperationFailed(scope, key)) return { ok: false };
  try {
    const value = await work(); check();
    getDb().prepare('UPDATE preparation_errors SET retry_state=2 WHERE scope=? AND operation_key=? AND retry_state=1').run(scope, key);
    return { ok: true, value };
  } catch (error) {
    check();
    if (isPreparationLimit(error)) throw error;
    if (error instanceof SkippedPreparationOperation) return { ok: false };
    recordPreparationError(run, scope, key, error, entity, details?.());
    return { ok: false };
  }
}
