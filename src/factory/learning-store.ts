import { getDb } from '../db/schema';
import { digest } from '../sync/normalize';
import { readWorkflowOriginals } from '../evidence-adapter';
import { SUMMARY_PROCESS_PROMPT, CONTRACT_MATCH_PROMPT, preparedProcess, validateProcess, validateProcessEvidence, contractMatchInput, decideContractMatch, type ProcessExtraction, type ContractMatchInput } from '../workflow-learning';

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
export function saveSummaryProcess(leaf: string, model: string, run: { table: 'sync_runs' | 'background_runs'; id: number }, input: string, value: unknown, references: string[], roles: string[]): void {
  const db = getDb(), recipe = digest(SUMMARY_PROCESS_PROMPT), id = digest(JSON.stringify([LEARNING_FORMAT, leaf, model, recipe]));
  if (db.prepare('SELECT 1 FROM process_extractions WHERE id=?').get(id)) return;
  let output: ProcessExtraction | undefined;
  try { output = preparedProcess(value, references, roles); } catch { /* Normal summaries remain usable; Factory reports the failed extraction. */ }
  const dependencies = JSON.stringify({ format: LEARNING_FORMAT, leaf, input: JSON.parse(input) });
  db.prepare(`INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,output_json,usage_json,created_at,completed_at)
    VALUES (?,'summary',?,?,?,?,?,?,?,?,?)`).run(id, digest(dependencies), recipe, model, output ? 'completed' : 'failed', dependencies,
      output ? JSON.stringify(output) : null, JSON.stringify({ summaryRun: run, includedInSummaryCall: true }), new Date().toISOString(), new Date().toISOString());
  if (output) for (const f of output.fragments) {
    const episode = digest(JSON.stringify([id, f.key]));
    db.prepare('INSERT INTO work_episodes(id,state,description_json) VALUES (?,?,?)').run(episode, f.state, JSON.stringify(f));
    db.prepare('INSERT INTO episode_extractions(episode_id,extraction_id,fragment_key) VALUES (?,?,?)').run(episode, id, f.key);
  }
}
export async function readProcessParent(parent: ProcessParent, signal: AbortSignal) {
  signal.throwIfAborted();
  const db = getDb();
  const row = db.prepare("SELECT * FROM process_extractions WHERE id=? AND kind='summary' AND status='completed'").get(parent.extraction) as LearningRow | undefined;
  if (!row) throw Error('Workflow parent unavailable');
  const deps = JSON.parse(row.source_dependencies_json);
  if (deps.format !== LEARNING_FORMAT || digest(row.source_dependencies_json) !== row.input_key) throw Error('Invalid workflow source receipt');
  const records = await readWorkflowOriginals([...deps.input.evidence, ...deps.input.background], signal);
  const output = validateProcessEvidence(validateProcess(row.output_json, records.map(r => r.ref)), records);
  const fragment = output.fragments.find(f => f.key === parent.fragment);
  if (!fragment) throw Error('Workflow fragment unavailable');
  return { input: { ...contractMatchInput(fragment), limitations: output.limitations }, identity: digest(JSON.stringify([parent.extraction, parent.fragment, row.output_json, row.source_dependencies_json, records])), leaf: deps.leaf as string, primary: records.slice(0, deps.input.evidence.length).map(record => record.ref) };
}
export async function readWorkflowComparison(row: LearningRow, signal: AbortSignal) {
  const deps = JSON.parse(row.source_dependencies_json);
  if (deps.format !== COMPARISON_FORMAT || deps.phase !== 'match' || !Array.isArray(deps.parents) || deps.parents.length > 25 || !Array.isArray(deps.pair) || deps.pair.length !== 2 || deps.pair[0] !== 0 || !Number.isSafeInteger(deps.pair[1]) || deps.pair[1] < 1 || deps.pair[1] >= deps.parents.length) throw Error('Invalid workflow comparison');
  const loaded: Awaited<ReturnType<typeof readProcessParent>>[] = [];
  for (const parent of deps.parents) loaded.push(await readProcessParent(parent, signal));
  if (JSON.stringify(loaded.map(p => p.identity)) !== JSON.stringify(deps.identities)) throw Error('Workflow dependencies changed');
  const evidence = deps.pair.map((i: number) => loaded[i].input);
  const payload = workflowComparisonPayload(evidence);
  if (learningInputKey(deps, payload, row.model) !== row.input_key || row.recipe_version !== digest(CONTRACT_MATCH_PROMPT)) throw Error('Workflow comparison input changed');
  const decision = decideContractMatch(JSON.parse(row.output_json).assessment, evidence);
  return { decision, evidence };
}
export function pendingWorkflows(): boolean {
  return !!getDb().prepare(`SELECT 1 FROM work_episodes e JOIN episode_extractions l ON l.episode_id=e.id JOIN process_extractions p ON p.id=l.extraction_id
    WHERE e.learning_status='pending' AND p.status='completed' AND json_extract(p.source_dependencies_json,'$.format')=? LIMIT 1`).get(LEARNING_FORMAT);
}
