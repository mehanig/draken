import { HttpError } from '../errors';
import type { SavedEnrichment } from './types';
import { getDb } from '../db/schema';
import { preparationOperation, preparationRetryRequested, isPreparationLimit } from '../sync/preparation-errors';
import { digest } from '../sync/normalize';
import { readDiscovery, readProposal, discoveryFromProposal } from './discovery';
import { saveWorkflowDisplay } from './display-store';
import { COMPARISON_FORMAT } from './learning-store';
import { enrich, proposeEnrichment, ENRICHMENT_PROMPT, ENRICHMENT_POLICY_VERSION, type Discovery, type Enrichment } from '../factory-enrichment';

const recipe = digest(ENRICHMENT_PROMPT);
type PreparationOwner = { table: 'sync_runs' | 'background_runs'; id: number };
interface Row { id: number; status: string; output_json: string | null; run_id: number; run_table: PreparationOwner['table'] }
function latest(workflow: Discovery): Row | undefined {
  return getDb().prepare('SELECT id,status,output_json,run_id,run_table FROM workflow_enrichments WHERE workflow_id=? AND revision=? AND policy_version=? AND recipe_version=? ORDER BY id DESC LIMIT 1')
    .get(workflow.id, workflow.revision, ENRICHMENT_POLICY_VERSION, recipe) as Row | undefined;
}
/** Caller must supply a freshly source-verified discovery. Reading never starts inference. */
export function savedEnrichment(workflow: Discovery): SavedEnrichment {
  const row = latest(workflow);
  if (!row || (row.status === 'cancelled' && row.run_table === 'background_runs')) return { status: 'pending' };
  if (row.status === 'completed') {
    try { const value = JSON.parse(row.output_json!); if (JSON.stringify(enrich(workflow, value.guidance)) === JSON.stringify(value)) return { status: 'ready', value }; } catch {}
  }
  const owner = getDb().prepare(`SELECT status FROM ${row.run_table} WHERE id=?`).get(row.run_id) as {status: string} | undefined;
  return { status: row.status === 'running' && owner?.status === 'running' ? 'running' : 'failed' };
}
export async function requireEnrichment(id: string, signal: AbortSignal): Promise<Enrichment> {
  const saved = savedEnrichment(await readDiscovery(id, signal));
  if (!saved.value) throw new HttpError(409, 'Workflow enrichment is not ready. Prepare it in Factory before running a task.');
  return saved.value;
}
/** The preparation owner supplies accounting and cancellation. Failed attempts require explicit retry. */
export async function prepareEnrichment(id: string, owner: PreparationOwner, model: string, ask: (payload: unknown, prompt: string) => Promise<string>, signal: AbortSignal, retry = false): Promise<Enrichment> {
  const proposal = await readProposal(id, signal), workflow = discoveryFromProposal(proposal), state = savedEnrichment(workflow);
  saveWorkflowDisplay(proposal);
  if (state.value) return state.value;
  if (state.status === 'running' || (state.status === 'failed' && !retry)) throw new HttpError(409, 'Enrichment already attempted; wait for completion or explicitly retry the failed attempt.');
  signal.throwIfAborted();
  const db = getDb(), attempt = Number(db.prepare(`INSERT INTO workflow_enrichments(workflow_id,revision,policy_version,recipe_version,model,run_id,run_table,status,created_at)
    VALUES (?,?,?,?,?,?,?,'running',?)`).run(id, workflow.revision, ENRICHMENT_POLICY_VERSION, recipe, model, owner.id, owner.table, new Date().toISOString()).lastInsertRowid);
  try {
    const value = await proposeEnrichment(workflow, {
      assertCurrent: async s => { if (JSON.stringify(await readDiscovery(id, s)) !== JSON.stringify(workflow)) throw Error('Workflow sources changed during enrichment'); },
      ask: async (payload, prompt) => {
        const raw = await ask({ task: 'enrich_workflow', stage: 'workflow_enrichment', ...payload as object }, prompt);
        db.prepare('UPDATE workflow_enrichments SET raw_output=? WHERE id=?').run(raw, attempt); return raw;
      },
    }, signal);
    db.prepare("UPDATE workflow_enrichments SET status='completed',output_json=?,completed_at=? WHERE id=?").run(JSON.stringify(value), new Date().toISOString(), attempt);
    return value;
  } catch (error) {
    db.prepare('UPDATE workflow_enrichments SET status=?,completed_at=? WHERE id=?').run(signal.aborted || (owner.table === 'background_runs' && isPreparationLimit(error)) ? 'cancelled' : 'failed', new Date().toISOString(), attempt);
    throw error;
  }
}
/** New discoveries are prepared by the same background owner, never by a page read or execution run. */
export async function prepareDiscoveredEnrichments(run: number, model: string, ask: (payload: unknown, prompt: string) => Promise<string>, signal: AbortSignal): Promise<void> {
  const rows = getDb().prepare(`SELECT id FROM process_extractions WHERE id IN (SELECT id FROM active_workflow_discoveries) AND kind='comparison' AND status='completed'
    AND json_extract(source_dependencies_json,'$.format')=? AND json_extract(source_dependencies_json,'$.phase')='match'
    AND json_extract(output_json,'$.sameWorkflow')=1 ORDER BY rowid`).all(COMPARISON_FORMAT) as {id: string}[];
  for (const row of rows) {
    signal.throwIfAborted();
    await preparationOperation(run, 'enrichment-source', row.id, signal, async () => {
      const workflow = await readDiscovery(row.id, signal), state = savedEnrichment(workflow);
      const key = `${row.id}:${workflow.revision}:${model}`;
      if (state.status === 'pending' || (state.status === 'failed' && preparationRetryRequested('enrichment', key))) await preparationOperation(run, 'enrichment', key, signal,
        () => prepareEnrichment(row.id, { table: 'background_runs', id: run }, model, ask, signal, state.status === 'failed'));
    });
  }
}
