import type { WorkflowLocation } from './types';
import { workflowLocation } from './location';
import { getDb } from '../db/schema';
import { digest } from '../sync/normalize';
import { readWorkflowOriginals } from '../evidence-adapter';
import { SUMMARY_PROCESS_PROMPT, PROCESS_PROMPT, preparedProcess, validateProcess, validateProcessEvidence, contractMatchInput, type ProcessExtraction, type ContractMatchInput } from '../workflow-learning';

export const LEARNING_FORMAT = 'summary-workflows-v1';
export const COMPARISON_FORMAT = 'workflow-comparison-v1';
export interface ProcessParent { extraction: string; fragment: string }
export function workflowComparisonPayload(pair: ContractMatchInput[]) {
  const wire = pair.map(input => ({ ...input, facts: input.facts.map(({ refs: _refs, ...fact }) => fact) }));
  return { task: 'compare_workflow_identity', stage: 'workflow_match', left: wire[0], right: wire[1] };
}
export function learningInputKey(deps: unknown, payload: unknown, model: string): string {
  return digest(JSON.stringify([deps, payload, model]));
}
export interface LearningRow { id: string; kind: string; status: string; input_key: string; recipe_version: string; model: string; output_json: string; source_dependencies_json: string; created_at: string }
export function saveSummaryProcess(leaf: string, model: string, run: { table: 'sync_runs' | 'background_runs'; id: number }, input: string, value: unknown, references: string[], roles: string[], options: { sourceError?: string; separateCall?: boolean; location?: WorkflowLocation; rawOutputs?: readonly string[] } = {}): boolean {
  const db = getDb(), recipe = digest(options.separateCall ? PROCESS_PROMPT : SUMMARY_PROCESS_PROMPT);
  const base = digest(JSON.stringify([LEARNING_FORMAT, leaf, model, recipe]));
  const previous = db.prepare('SELECT status FROM process_extractions WHERE id=?').get(base) as { status: string } | undefined;
  if (previous && (!options.separateCall || previous.status === 'completed')) return previous.status === 'completed';
  const attempt = (db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE recipe_version=? AND model=? AND json_extract(source_dependencies_json,'$.leaf')=?").get(recipe, model, leaf) as { n: number }).n;
  const id = previous ? digest(JSON.stringify([base, run, attempt])) : base;
  const frozen = JSON.parse(input), location = workflowLocation(frozen.workspace);
  const sourceError = options.sourceError || (options.location && JSON.stringify(options.location) !== JSON.stringify(location) ? 'Repository or folder changed during inference' : undefined);
  let output: ProcessExtraction | undefined, failure: { stage: string; message: string } | undefined;
  try {
    if (sourceError) throw Error(sourceError);
    if (value === undefined) throw Error('Summary response did not include process');
    output = preparedProcess(value, references, roles);
  } catch (error) {
    failure = { stage: sourceError ? 'source_verification' : 'process_validation', message: error instanceof Error ? error.message.slice(0, 500) : 'Invalid process result' };
  }
  const dependencies = JSON.stringify({ format: LEARNING_FORMAT, leaf, input: frozen, location: options.location || location });
  db.prepare(`INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,output_json,usage_json,created_at,completed_at)
    VALUES (?,'summary',?,?,?,?,?,?,?,?,?)`).run(id, digest(dependencies), recipe, model, output ? 'completed' : 'failed', dependencies,
      output ? JSON.stringify(output) : JSON.stringify({ failure, outputHash: digest(JSON.stringify(value) ?? 'missing'), raw_output: options.rawOutputs, process: value }), JSON.stringify({ summaryRun: run, includedInSummaryCall: !options.separateCall }), new Date().toISOString(), new Date().toISOString());
  if (output) for (const f of output.fragments) {
    const episode = digest(JSON.stringify([id, f.key]));
    db.prepare('INSERT INTO work_episodes(id,state,description_json) VALUES (?,?,?)').run(episode, f.state, JSON.stringify(f));
    db.prepare('INSERT INTO episode_extractions(episode_id,extraction_id,fragment_key) VALUES (?,?,?)').run(episode, id, f.key);
  }
  return !!output;
}
export async function readProcessParents(parents: ProcessParent[], signal: AbortSignal) {
  signal.throwIfAborted();
  const inputs = parents.map(parent => {
    const row = getDb().prepare("SELECT * FROM process_extractions WHERE id=? AND kind='summary' AND status='completed'").get(parent.extraction) as LearningRow | undefined;
    if (!row) throw Error('Workflow parent unavailable');
    const deps = JSON.parse(row.source_dependencies_json);
    if (deps.format !== LEARNING_FORMAT || digest(row.source_dependencies_json) !== row.input_key) throw Error('Invalid workflow source receipt');
    return { parent, row, deps, pointers: [...deps.input.evidence, ...deps.input.background] as Record<string, unknown>[] };
  });
  const originals = await readWorkflowOriginals(inputs.flatMap(input => input.pointers), signal);
  let offset = 0;
  return inputs.map(({ parent, row, deps, pointers }) => {
    const records = originals.slice(offset, offset += pointers.length);
    const output = validateProcessEvidence(validateProcess(row.output_json, records.map(r => r.ref)), records);
    const location = workflowLocation(deps.input.workspace);
    for (const cwd of new Set(pointers.map(pointer => pointer.cwd as string))) {
      if (workflowLocation(cwd).key !== location.key) throw Error('Process sources span different locations');
    }
    if (deps.location && JSON.stringify(deps.location) !== JSON.stringify(location)) throw Error('Workflow repository or folder changed');
    const fragment = output.fragments.find(f => f.key === parent.fragment);
    if (!fragment) throw Error('Workflow fragment unavailable');
    return { location, fragment, records, input: { ...contractMatchInput(fragment), limitations: output.limitations }, identity: digest(JSON.stringify([parent.extraction, parent.fragment, row.output_json, row.source_dependencies_json, records])), leaf: deps.leaf as string, primary: records.slice(0, deps.input.evidence.length).map(record => record.ref) };
  });
}
export async function readProcessParent(parent: ProcessParent, signal: AbortSignal) {
  return (await readProcessParents([parent], signal))[0];
}
