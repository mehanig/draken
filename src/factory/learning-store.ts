import { getDb } from '../db/schema';
import { defaultModels } from '../sync/models';
import { preparationOperationFailed } from '../sync/preparation-errors';
import { digest } from '../sync/normalize';
import { CONTRACT_MATCH_PROMPT, decideContractMatch, validateWorkflow, type WorkflowCandidate } from '../workflow-learning';
import { LEARNING_FORMAT, COMPARISON_FORMAT, learningInputKey, workflowComparisonPayload, type LearningRow } from './process-store';
import { readLearningParents, independentTasks, type LearningParent } from './episode-store';

export { LEARNING_FORMAT, COMPARISON_FORMAT, learningInputKey, workflowComparisonPayload, readProcessParent, saveSummaryProcess } from './process-store';
export type { LearningRow } from './process-store';

export function savedWorkflowCandidates(location: string, id: string | null = null): WorkflowCandidate[] {
  const rows = getDb().prepare(`SELECT id,display_json FROM active_workflow_discoveries
    WHERE json_extract(display_json,'$.location.key')=? AND (? IS NULL OR id=?) ORDER BY cursor DESC LIMIT 24`)
    .all(location, id, id) as { id: string; display_json: string }[];
  return rows.map(row => {
    const display = JSON.parse(row.display_json);
    return { id: row.id, workflow: validateWorkflow(display.task?.workflow || display.decision?.assessment.workflow) };
  });
}

export async function readWorkflowComparison(row: LearningRow, signal: AbortSignal) {
  const deps = JSON.parse(row.source_dependencies_json);
  if (deps.format !== COMPARISON_FORMAT || deps.phase !== 'match' || !Array.isArray(deps.parents) || deps.parents.length > 25 || !Array.isArray(deps.pair) || deps.pair.length !== 2 || deps.pair[0] !== 0 || !Number.isSafeInteger(deps.pair[1]) || deps.pair[1] < 1 || deps.pair[1] >= deps.parents.length) throw Error('Invalid workflow comparison');
  const loaded = await readLearningParents(deps.parents, signal);
  if (!independentTasks(deps.parents[deps.pair[0]] as LearningParent, deps.parents[deps.pair[1]] as LearningParent)) throw Error('Workflow examples are not established as independent tasks');
  if (JSON.stringify(loaded.map(p => p.identity)) !== JSON.stringify(deps.identities)) throw Error('Workflow dependencies changed');
  const location = loaded[deps.pair[0]].location;
  if (location.kind === 'unavailable' || loaded[deps.pair[1]].location.key !== location.key) throw Error('Workflow records belong to different or unavailable locations');
  if (deps.location && (JSON.stringify(deps.location) !== JSON.stringify(location) || loaded.some(parent => parent.location.key !== location.key))) throw Error('Workflow candidate locations changed');
  const evidence = deps.pair.map((i: number) => loaded[i].input);
  const saved: WorkflowCandidate[] = deps.savedWorkflows || [];
  const payload = workflowComparisonPayload(evidence, saved);
  // 0.15.2 comparison receipts remain verifiable after the prompt changes.
  const supportedRecipes = [digest(CONTRACT_MATCH_PROMPT), 'a578429d87caaf03055f9e248f1f07212e44e355c1c0237031f8e868cb0f59d9'];
  if (learningInputKey(deps, payload, row.model) !== row.input_key || !supportedRecipes.includes(row.recipe_version)) throw Error('Workflow comparison input changed');
  const decision = decideContractMatch(JSON.parse(row.output_json).assessment, evidence, saved);
  return { decision, evidence, location };
}
export function pendingWorkflows(): boolean {
  const models = defaultModels();
  const rows = getDb().prepare(`SELECT e.id,e.revision,e.assembly,l.extraction_id,l.fragment_key FROM work_episodes e
    JOIN episode_extractions l ON l.episode_id=e.id JOIN process_extractions p ON p.id=l.extraction_id
    WHERE e.learning_status='pending' AND e.superseded_by IS NULL AND p.status='completed'
    AND json_extract(p.source_dependencies_json,'$.format')=? GROUP BY e.id`).all(LEARNING_FORMAT) as { id: string; revision: number; assembly: string; extraction_id: string; fragment_key: string }[];
  return rows.some(row => row.assembly === 'fragment'
    ? !preparationOperationFailed('reconstruction', `${models.final}:${row.extraction_id}:${row.fragment_key}`)
    : !preparationOperationFailed('workflow-task', `${models.summary}:${row.id}:${row.revision}`));
}
