import { getDb } from '../db/schema';
import { HttpError } from '../errors';
import type { SummaryPreparationSettings } from '../types';
import { activity } from './activity';
import { historyProgress } from '../memory/service';
import { assertEvidenceAvailable, previewSummaryInput } from './store';
import { SummaryTree, summaryPreparationKey } from './tree';
import { digest } from './normalize';
import { defaultModels } from './models';
import { learnSummaryWorkflows } from '../factory/learning';
import { pendingWorkflows } from '../factory/learning-store';
import { prepareCachedProcesses } from '../factory/prepare';
import { prepareEnrichment, prepareDiscoveredEnrichments, requireEnrichment } from '../factory/enrichment';
import { modelCall } from './model-call';

import { preparationOperation as operationName } from './preparation-status';
import { preparationOperation, preparationErrorCount, preparationRetryPending, retryPreparationErrors, isPreparationLimit, recordPreparationError, failedPreparationOperations, finishPreparationRetries } from './preparation-errors';
const setting = (key: string) => (getDb().prepare('SELECT value FROM sync_settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
function save(key: string, value: string) {
  getDb().prepare('INSERT INTO sync_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
const summaryPreparationEnabled = () => (setting('auto_summary') ?? 'true') === 'true';
const indexingEnabled = () => setting('auto_index') === 'true';
const idle = () => activity.backgroundIdle && !historyProgress().active && !historyProgress().queued;
interface Receipt { cache_receipt_json: string; total_entries: number; completed_at: string | null; stage: string }
interface Run { id: number; invocations: number; max_invocations: number; stage?: string }
let active: { controller: AbortController; done: Promise<void>; working: boolean; operation?: string } | undefined;

/** Cancellation is irrevocable for this job even if consent is immediately re-enabled. */
export function cancelSummaryPreparation(): Promise<void> {
  const prior = active;
  prior?.controller.abort();
  return prior?.done || Promise.resolve();
}

/** Called by the scheduler's lifecycle owner; reads never start the scheduler. */
export function configureAutoSummary(value: unknown): void {
  if (typeof value !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
  if (value && !indexingEnabled()) throw new HttpError(409, 'Enable local indexing before enabling model-backed summary and workflow preparation.');
  active?.controller.abort();
  getDb().transaction(() => {
    save('auto_summary', String(value));
    if (value) { save('auto_summary_error', ''); retryPreparationErrors(); }
  })();
}

function matching(key: string): Receipt | undefined {
  return getDb().prepare("SELECT cache_receipt_json,total_entries,completed_at,stage FROM background_runs WHERE status='completed' AND input_key=? ORDER BY id DESC LIMIT 1").get(key) as Receipt | undefined;
}

function cacheIntact(value: string | [string, string][]): boolean {
  let pairs: unknown;
  try { pairs = typeof value === 'string' ? JSON.parse(value) : value; } catch { return false; }
  if (!Array.isArray(pairs) || !pairs.length || pairs.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) return false;
  const lookup = getDb().prepare('SELECT output_json FROM summary_cache WHERE key=?');
  return pairs.every(([key, hash]) => {
    const row = lookup.get(key) as { output_json: string } | undefined;
    return row !== undefined && digest(row.output_json) === hash;
  });
}

/** Historical progress, not a live readiness claim. Polling must not reopen
 * transcript bodies; the preparing owner and explicit sync validate originals. */
export function summaryPreparationSettings(): SummaryPreparationSettings {
  const enabled = summaryPreparationEnabled();
  const last = getDb().prepare("SELECT total_entries,completed_at FROM background_runs WHERE status='completed' AND stage!='Completed with errors' AND input_key NOT LIKE 'workflow-enrichment:%' AND input_key NOT LIKE 'workflow-consolidation:%' ORDER BY id DESC LIMIT 1").get() as Pick<Receipt, 'total_entries' | 'completed_at'> | undefined;
  return { enabled, status: !enabled ? 'off' : !indexingEnabled() || !idle() || active?.controller.signal.aborted ? 'paused' : active?.working ? 'running' : 'waiting',
    prepared_entries: last?.total_entries || 0, last_completed_at: last?.completed_at || null, error: '', error_count: preparationErrorCount(), failed_operations: failedPreparationOperations(), operation: active?.operation };
}

/** Explicit preparation/retry of an older workflow. Shares the background owner, not its error/reset state. */
export async function prepareWorkflowEnrichment(id: string, body: unknown, signal: AbortSignal) {
  const input = body as {requestId?: unknown; retry?: unknown} | null;
  if (!/^[a-f0-9]{64}$/.test(id) || !input || typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId) || typeof input.retry !== 'boolean') throw new HttpError(400, 'Provide a workflow, request ID and explicit retry choice.');
  signal.throwIfAborted();
  if (active || getDb().prepare("SELECT id FROM background_runs WHERE status='running' LIMIT 1").get()) throw new HttpError(409, 'Preparation is busy or needs recovery.');
  const key = `workflow-enrichment:${id}:${input.requestId}`;
  if (getDb().prepare('SELECT id FROM background_runs WHERE input_key=?').get(key)) return requireEnrichment(id, signal);
  const controller = new AbortController(), abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
  const owner = { controller, done: Promise.resolve(), working: true }; active = owner;
  owner.done = Promise.resolve().then(async () => {
    const models = { ...defaultModels(), max_invocations: 1 }, db = getDb();
    const run = Number(db.prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,input_key,stage)
      VALUES (?,?,1,0,?,?,'Workflow enrichment')`).run(models.summary, models.final, new Date().toISOString(), key).lastInsertRowid);
    try {
      await prepareEnrichment(id, { table: 'background_runs', id: run }, models.final, (payload, system) => modelCall(payload, system, { models, runId: run, table: 'background_runs', final: true, signal: controller.signal }), controller.signal, input.retry as boolean);
      db.prepare("UPDATE background_runs SET status='completed',stage='Workflow ready',completed_at=? WHERE id=?").run(new Date().toISOString(), run);
    } catch (error) {
      db.prepare('UPDATE background_runs SET status=?,error=?,completed_at=? WHERE id=?').run(controller.signal.aborted ? 'cancelled' : 'failed', 'Workflow enrichment did not complete. Attempt and accounting retained.', new Date().toISOString(), run);
      throw error;
    }
  }).finally(() => { signal.removeEventListener('abort', abort); if (active === owner) active = undefined; });
  await owner.done;
  return requireEnrichment(id, signal);
}

/** Prepare reusable summaries and workflows. No sync identity, snapshot, briefing or verdict.
 * Failed operations are logged and skipped, not a global pause. Independent work
 * continues. Explicit retry can revisit failed operations; cancellation retains its allowance. */
export async function warmSummaryCache(signal: AbortSignal, onWork?: () => void, processLeaves?: readonly string[]): Promise<void> {
  if (processLeaves && (!processLeaves.length || processLeaves.length > 6 || new Set(processLeaves).size !== processLeaves.length || processLeaves.some(key => !/^[a-f0-9]{64}$/.test(key)))) throw Error('Select one to six distinct saved summary keys');
  if (signal.aborted || !summaryPreparationEnabled() || !indexingEnabled() || !idle()) return;
  if (active) return active.done;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const owner = { controller, done: Promise.resolve(), working: false, operation: 'History preparation' };
  active = owner;
  owner.done = Promise.resolve().then(async () => {
    let run: Run | undefined;
    let task = 'planning';
    const step = (next: string) => {
      task = next; owner.operation = operationName(next);
      if (run) getDb().prepare('UPDATE background_runs SET stage=? WHERE id=?').run(owner.operation, run.id);
    };
    const admitted = () => !controller.signal.aborted && summaryPreparationEnabled() && indexingEnabled() && idle();
    const check = () => { if (!admitted()) { controller.abort(); throw new HttpError(409, 'Background preparation paused'); } };
    try {
      check();
      const db = getDb();
      const orphan = db.prepare("SELECT id,invocations,max_invocations FROM background_runs WHERE status='running' LIMIT 1").get() as Run | undefined;
      if (orphan) return;
      if (setting('auto_summary_error')) save('auto_summary_error', '');
      step('sources');
      const input = processLeaves ? { items: [], context: [], models: defaultModels() } : previewSummaryInput();
      const key = summaryPreparationKey(input) + (processLeaves ? digest(JSON.stringify(processLeaves)) : input.items.length ? '' : digest(JSON.stringify(db.prepare("SELECT id FROM process_extractions WHERE kind='summary' AND status='completed' AND json_extract(source_dependencies_json,'$.format')='summary-workflows-v1' ORDER BY id").all())));
      const receipt = matching(key);
      const summariesReady = !!receipt && receipt.stage !== 'Completed with errors' && cacheIntact(receipt.cache_receipt_json);
      if ((summariesReady || receipt?.stage === 'Completed with errors' || (processLeaves && receipt)) && !pendingWorkflows() && !preparationRetryPending()) return;
      if (!processLeaves && !input.items.length && !pendingWorkflows() && !preparationRetryPending()) return;
      check();
      run = db.prepare(`SELECT id,invocations,max_invocations,stage FROM background_runs WHERE input_key=?
        AND status IN ('cancelled','interrupted','completed','failed') ORDER BY id DESC LIMIT 1`).get(key) as Run | undefined;
      const latest = db.prepare('SELECT id FROM background_runs WHERE input_key=? ORDER BY id DESC LIMIT 1').get(key) as { id: number } | undefined;
      if (run && latest?.id !== run.id) run = undefined;
      if (run?.stage === 'Call limit reached' && run.invocations >= run.max_invocations) return;
      if (run) {
        db.prepare("UPDATE background_runs SET status='running',stage='Planning',processed_entries=0,cache_hits=0,completed_at=NULL WHERE id=?").run(run.id);
        input.models = { ...input.models, max_invocations: run.max_invocations };
      } else {
        const result = db.prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,input_key)
          VALUES (?,?,?,?,?,?)`).run(input.models.summary, input.models.final, input.models.max_invocations, input.items.length, new Date().toISOString(), key);
        run = { id: Number(result.lastInsertRowid), invocations: 0, max_invocations: input.models.max_invocations };
      }
      owner.working = true; onWork?.();
      const tree = SummaryTree.forBackground(input, run.id, controller.signal);
      const call = tree.call.bind(tree);
      tree.call = async (payload, system, final = false) => {
        check();
        if (final) throw new Error('Background preparation cannot request a verdict');
        step((payload as { task?: string }).task || 'summarize');
        return call(payload, system, false);
      };
      step('summarize');
      const summaries = await preparationOperation(run.id, 'summary-batch', key, controller.signal, async () => {
        assertEvidenceAvailable(input);
        if (input.items.length) await tree.build();
      });
      if (processLeaves) await prepareCachedProcesses(processLeaves, run.id, input.models.summary, (payload, system) => tree.call(payload, system), controller.signal);
      check();
      step('select_workflow_candidates');
      await preparationOperation(run.id, 'workflow-learning-batch', key, controller.signal, () => learnSummaryWorkflows(run!.id, input.models.summary, (payload, system) => tree.call(payload, system), controller.signal,
        { model: input.models.final, ask: (payload, system) => {
          check(); step((payload as { task?: string }).task || 'reconstruct_task');
          return modelCall(payload, system, { models: input.models, runId: run!.id, table: 'background_runs', final: true, signal: controller.signal });
        } }));
      check();
      step('enrich_workflow');
      await preparationOperation(run.id, 'enrichment-batch', key, controller.signal, () => prepareDiscoveredEnrichments(run!.id, input.models.final, (payload, system) => {
        check(); return modelCall(payload, system, { models: input.models, runId: run!.id, table: 'background_runs', final: true, signal: controller.signal });
      }, controller.signal));
      check();
      step('finalization');
      if (JSON.stringify(defaultModels()) !== JSON.stringify(input.models)) { controller.abort(); throw new Error('Models changed'); }
      const cacheReceipt = tree.cacheReceipt();
      const complete = summaries.ok && !tree.incomplete;
      if (complete) tree.verifyFinal();
      if (complete && input.items.length && !cacheIntact(cacheReceipt)) throw new Error('Summary cache changed before completion');
      finishPreparationRetries();
      db.prepare("UPDATE background_runs SET status='completed',stage=?,completed_at=?,cache_receipt_json=? WHERE id=?")
        .run(complete ? 'Cached' : 'Completed with errors', new Date().toISOString(), complete ? JSON.stringify(cacheReceipt) : '[]', run.id);
    } catch (error) {
      const db = getDb();
      const cancelled = controller.signal.aborted;
      const status = cancelled ? 'cancelled' : isPreparationLimit(error) ? 'interrupted' : 'failed', at = new Date().toISOString();
      if (!cancelled && !isPreparationLimit(error)) recordPreparationError(run?.id, 'preparation-stage', task, error, undefined, {}, 2);
      if (run) {
        db.prepare("UPDATE background_runs SET status=?,stage=?,completed_at=? WHERE id=?")
          .run(status, isPreparationLimit(error) ? 'Call limit reached' : cancelled ? 'Cancelled' : 'Completed with errors', at, run.id);
        if (cancelled || isPreparationLimit(error)) db.prepare("UPDATE background_runs SET failure_events_json=json_insert(failure_events_json,'$[#]',json(?)) WHERE id=?")
          .run(JSON.stringify({ status, at, operation: operationName(task) }), run.id);
      }
    }
  }).finally(() => {
    signal.removeEventListener('abort', abort);
    if (active === owner) active = undefined;
  });
  return owner.done;
}
