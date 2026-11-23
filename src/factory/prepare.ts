import { workflowLocation } from './location';
import { getDb } from '../db/schema';
import { preparationOperation } from '../sync/preparation-errors';
import { digest } from '../sync/normalize';
import { readWorkflowOriginals } from '../evidence-adapter';
import { PROCESS_PROMPT } from '../workflow-learning';
import { LEARNING_FORMAT, saveSummaryProcess } from './learning-store';

/** Explicit preparation of selected old leaves. Never called by a page read or an ordinary background tick. */
export async function prepareCachedProcesses(keys: readonly string[], run: number, model: string,
  ask: (payload: unknown, system: string) => Promise<string>, signal: AbortSignal): Promise<void> {
  const db = getDb();
  const prepareLeaf = async (key: string) => {
    signal.throwIfAborted();
    const row = db.prepare('SELECT l.input_json,l.output_hash,c.output_json FROM summary_leaf_inputs l JOIN summary_cache c ON c.key=l.key WHERE l.key=?').get(key) as { input_json: string; output_hash: string; output_json: string } | undefined;
    if (!row || digest(row.output_json) !== row.output_hash) throw Error('Saved summary changed or is unavailable');
    const input = JSON.parse(row.input_json), pointers = [...input.evidence, ...input.background];
    const location = workflowLocation(input.workspace);
    if (location.kind === 'unavailable') throw Error('Working folder is unavailable');
    const records = await readWorkflowOriginals(pointers, signal);
    if (db.prepare("SELECT 1 FROM process_extractions WHERE kind='summary' AND status='completed' AND json_extract(source_dependencies_json,'$.format')=? AND json_extract(source_dependencies_json,'$.leaf')=?").get(LEARNING_FORMAT, key)) return;
    const unique = [...new Map(records.map(record => [record.ref, record])).values()];
    const references = unique.map(record => record.ref), roles = unique.map(record => record.role);
    let repair: { validation_error: string; previous_output: string } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (JSON.stringify(await readWorkflowOriginals(pointers, signal)) !== JSON.stringify(records) || workflowLocation(input.workspace).key !== location.key) throw Error('Process originals or location changed before inference');
      const raw = await ask({ task: 'prepare_workflow_process', stage: 'workflow_process',
        records: unique.map((record, i) => ({ ...record, ref: `S${i + 1}` })), ...(repair ? { repair } : {}) }, PROCESS_PROMPT);
      signal.throwIfAborted();
      let sourceError: string | undefined;
      try {
        if (JSON.stringify(await readWorkflowOriginals(pointers, signal)) !== JSON.stringify(records)) throw Error('Process originals changed during inference');
      } catch (error) { signal.throwIfAborted(); sourceError = error instanceof Error ? error.message : 'Original verification failed'; }
      let value: unknown;
      try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
      catch { value = undefined; }
      const valid = db.transaction(() => saveSummaryProcess(key, model, { table: 'background_runs', id: run }, row.input_json,
        value, references, roles, { separateCall: true, sourceError, location, rawOutputs: [raw] }))();
      if (valid) break;
      const failed = db.prepare("SELECT output_json FROM process_extractions WHERE status='failed' AND json_extract(source_dependencies_json,'$.leaf')=? ORDER BY rowid DESC LIMIT 1").get(key) as { output_json: string };
      const message = JSON.parse(failed.output_json).failure.message as string;
      if (sourceError || attempt === 1) throw Error(`Process preparation failed: ${message}`);
      repair = { validation_error: message, previous_output: raw.slice(0, 60000) };
    }
  };
  for (const key of keys) await preparationOperation(run, 'process-extraction', `${model}:${key}`, signal, () => prepareLeaf(key));
}
