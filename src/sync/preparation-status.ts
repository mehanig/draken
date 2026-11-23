import { getDb } from '../db/schema';

const LEGACY_FAILURE = 'Background summaries could not finish. Check provider settings, invocation limits and original session files, then explicitly retry automatic preparation in Settings. Cached work is retained.';
const operations: Record<string, string> = {
  planning: 'History preparation', summarize: 'Summarization', group_topics: 'Summary grouping',
  select_workflow_candidates: 'Workflow selection', compare_workflow_identity: 'Workflow comparison',
  reconstruct_task: 'Task reconstruction', review_task_reconstruction: 'Task reconstruction review',
  prepare_workflow_process: 'Workflow extraction', enrich_workflow: 'Workflow preparation',
  sources: 'Original history check', finalization: 'Completing preparation',
};
export const preparationOperation = (task: string) => operations[task] || 'Model preparation';

/** Read saved failure details only. Never reopen original history or retry work. */
export function preparationFailure(runId: number | undefined, task: string, error?: unknown) {
  const db = getDb();
  const run = runId === undefined ? undefined : db.prepare(`SELECT invocations,max_invocations,
    json_extract(metrics_json,'$[#-1].task') AS task,json_extract(metrics_json,'$[#-1].status') AS request_status
    FROM background_runs WHERE id=?`).get(runId) as { invocations: number; max_invocations: number; task: string | null; request_status: string | null } | undefined;
  const message = error instanceof Error ? error.message : '';
  const receipt = runId === undefined ? undefined : db.prepare(`SELECT json_extract(output_json,'$.failure.stage') AS stage,
    json_extract(output_json,'$.failure.message') AS message FROM process_extractions
    WHERE status='failed' AND json_extract(usage_json,'$.backgroundRun')=?
    AND (?='' OR json_extract(output_json,'$.failure.message')=?) ORDER BY completed_at DESC,created_at DESC LIMIT 1`).get(runId, message, message) as { stage: string; message: string } | undefined;
  const operation = preparationOperation(task || run?.task || 'planning');
  const detail = message || receipt?.message || '';
  let reason = 'The cause could not be identified.';
  if ((error instanceof Error && error.name === 'AbortError') || detail.startsWith('Generation cancelled')) reason = 'Preparation was cancelled.';
  else if (detail.startsWith('Invocation budget reached.')) reason = 'The model-call limit for this attempt was reached.';
  else if (detail.startsWith('Summary request exceeds its token safety budget;') || detail.startsWith('The final input exceeds its compact token budget;') || detail === 'Task fragment exceeds the reconstruction input budget' || detail.startsWith('One summary input exceeds the safety limit;') || detail.startsWith('Model input exceeds the safety limit;')) reason = 'The input exceeded the size limit for this model step. That request was not sent.';
  else if (detail === 'Pair must cite supplied main stages') reason = 'The model compared steps outside the main task steps supplied for comparison.';
  else if (detail === 'Task boundary cites another task or unknown original') reason = 'The model used evidence from another task or an unknown original to define this task.';
  else if (detail === 'Task reconstruction split an existing task; review is required') reason = 'The model proposed splitting an existing task. That task grouping needs review before preparation can continue.';
  else if (detail === 'Background ownership was not recovered') reason = 'An earlier preparation attempt still owns this work. Its shutdown or recovery has not completed.';
  else if (detail.startsWith('Original session evidence is unavailable or changed.') || detail === 'Original leaf dependency is unavailable or changed.' || receipt?.stage === 'sources') reason = 'The original history required for this step is unavailable or changed.';
  else if (receipt?.stage === 'validation') reason = 'The model returned an invalid response for this step.';
  else if (detail.startsWith('Private pi is unavailable.')) reason = 'The model runtime is unavailable. Run draken setup, then draken login.';
  else if (detail.startsWith('Cannot start pi.')) reason = 'The configured model runtime could not start.';
  else if (detail.startsWith('pi returned no response.')) reason = 'The model returned no response.';
  else if (detail.startsWith('pi timed out.')) reason = 'The model request exceeded its time limit.';
  else if (detail.startsWith('pi produced too much output.')) reason = 'The model response exceeded the output size limit and was not accepted.';
  else if (error instanceof SyntaxError) reason = 'A JSON result could not be read.';
  else if (run?.request_status === 'failed') reason = 'The model request did not complete successfully.';
  const calls = run ? ` Attempt #${runId} used ${run.invocations} of ${run.max_invocations} allowed model calls.` : '';
  return { operation, reason, message: `${operation} stopped. ${reason}${calls} Saved summaries and workflows are retained.` };
}

export function savedPreparationError(): string {
  const db = getDb();
  const error = (db.prepare("SELECT value FROM sync_settings WHERE key='auto_summary_error'").get() as { value: string } | undefined)?.value || '';
  if (error !== LEGACY_FAILURE) return error;
  const run = db.prepare("SELECT id FROM background_runs WHERE status='failed' AND error=? ORDER BY id DESC LIMIT 1").get(error) as { id: number } | undefined;
  return preparationFailure(run?.id, '').message;
}
