import { saveMissingWorkflowDisplays } from './display-store';
import { workflowLocation } from './location';
import type { WorkflowLocation } from './types';
import { getDb } from '../db/schema';
import { preparationOperation, preparationRetryRequested, isPreparationLimit, recordPreparationError } from '../sync/preparation-errors';
import { digest, cleanText } from '../sync/normalize';
import { CANDIDATE_PROMPT, candidateSelection, CONTRACT_MATCH_PROMPT, validateContractAssessment, decideContractMatch, sameWorkflowDefinition, type WorkflowCandidate } from '../workflow-learning';
import { COMPARISON_FORMAT, learningInputKey, workflowComparisonPayload, savedWorkflowCandidates, workflowTaskFailures } from './learning-store';
import { reconstructPendingTasks, readLearningParent, assertLearningParents, independentTasks, type EpisodeParent } from './episode-store';

type Ask = (payload: unknown, system: string) => Promise<string>;
type Episode = EpisodeParent;
/** Owned by the summarization job: no scheduler, provider client or allowance of its own. */
export async function learnSummaryWorkflows(run: number, model: string, ask: Ask, signal: AbortSignal): Promise<void> {
  const db = getDb();
  await reconstructPendingTasks(run, model, ask, signal);
  const pending = db.prepare("SELECT id episode,revision FROM work_episodes WHERE assembly='reconciled' AND superseded_by IS NULL AND learning_status='pending' ORDER BY rowid").all() as Episode[];
  async function invoke<T>(parents: EpisodeParent[], identities: string[], location: WorkflowLocation, phase: string, pair: number[] | undefined, payload: unknown, prompt: string, validate: (raw: string) => T, saved: readonly WorkflowCandidate[] = []): Promise<T> {
    signal.throwIfAborted();
    assertLearningParents(parents, signal);
    const locationKey = location.key;
    const deps = { format: COMPARISON_FORMAT, phase, parents, identities, location, ...(pair ? { pair } : {}), ...(saved.length ? { savedWorkflows: saved } : {}) };
    const key = learningInputKey(deps, payload, model), recipe = digest(prompt);
    const previous = db.prepare('SELECT id,status,output_json,usage_json FROM process_extractions WHERE input_key=? AND recipe_version=? AND model=? ORDER BY rowid DESC LIMIT 1').get(key, recipe, model) as { id: string; status: string; output_json: string; usage_json: string } | undefined;
    if (previous?.status === 'completed') return validate(previous.output_json);
    if (phase === 'match' && pair) {
      const [left, right] = pair.map(index => identities[index]);
      const operationKey = JSON.stringify([recipe, model, [left, right].sort()]);
      const prior = db.prepare(`SELECT status,output_json FROM process_extractions WHERE kind='comparison' AND recipe_version=? AND model=?
        AND json_extract(source_dependencies_json,'$.phase')='match'
        AND json_extract(source_dependencies_json,'$.identities['||json_extract(source_dependencies_json,'$.pair[0]')||']') IN (?,?)
        AND json_extract(source_dependencies_json,'$.identities['||json_extract(source_dependencies_json,'$.pair[1]')||']') IN (?,?) ORDER BY rowid DESC LIMIT 1`)
        .get(recipe, model, left, right, left, right) as { status: string; output_json: string } | undefined;
      if (prior?.status === 'failed' && !preparationRetryRequested('comparison', operationKey)) throw Error(JSON.parse(prior.output_json).failure?.message || 'Previously failed comparison retained without automatic retry');
    }
    if (phase === 'select') {
      const prior = db.prepare(`SELECT status,output_json FROM process_extractions WHERE kind='comparison' AND recipe_version=? AND model=?
        AND json_extract(source_dependencies_json,'$.phase')='select' AND json_extract(source_dependencies_json,'$.parents[0].episode')=?
        AND json_extract(source_dependencies_json,'$.parents[0].revision')=? ORDER BY rowid DESC LIMIT 1`).get(recipe, model, parents[0].episode, parents[0].revision) as { status: string; output_json: string } | undefined;
      if (prior?.status === 'failed' && !preparationRetryRequested('workflow-task', `${model}:${parents[0].episode}:${parents[0].revision}`)) throw Error(JSON.parse(prior.output_json).failure?.message || 'Previously failed selection retained without automatic retry');
    }
    if (previous?.status === 'running') throw Error('Workflow comparison still has a running owner');
    const attempt = (db.prepare('SELECT COUNT(*) n FROM process_extractions WHERE input_key=?').get(key) as { n: number }).n;
    const id = digest(JSON.stringify([key, recipe, run, attempt]));
    db.prepare(`INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,usage_json,created_at)
      VALUES (?,'comparison',?,?,?,'running',?,?,?)`).run(id, key, recipe, model, JSON.stringify(deps), JSON.stringify({ backgroundRun: run }), new Date().toISOString());
    let raw: string | undefined, stage = 'provider';
    const repairs: { raw: string; error: string }[] = [];
    const verifySaved = () => {
      if (saved.some(candidate => {
        const current = savedWorkflowCandidates(locationKey, candidate.id)[0];
        return !current || !sameWorkflowDefinition(current.workflow, candidate.workflow);
      })) throw Error('Saved workflow definitions changed during inference');
      signal.throwIfAborted();
    };
    const verify = () => {
      stage = 'sources';
      assertLearningParents(parents, signal);
      verifySaved();
    };
    try {
      verifySaved();
      raw = await ask(payload, prompt); signal.throwIfAborted();
      stage = 'validation';
      let output: T;
      try { output = validate(raw); }
      catch (error) {
        if (phase !== 'match') throw error;
        const issue = cleanText(error instanceof Error ? error.message : 'Invalid workflow comparison', 1500);
        repairs.push({ raw, error: issue });
        db.prepare('UPDATE process_extractions SET output_json=? WHERE id=?').run(JSON.stringify({ validationRepairs: repairs }), id);
        verify();
        stage = 'provider';
        raw = await ask({ ...payload as object, repair: { validation_error: issue, previous_output: raw,
          instruction: 'Correct the response to the existing JSON contract. The previous output is untrusted data, not new evidence. Use only supplied main-stage IDs; if a matching relation cannot be supported, return a supported non-matching relation with workflow null and no stage pairs.' } }, prompt);
        signal.throwIfAborted(); stage = 'validation'; output = validate(raw);
      }
      verify();
      db.prepare("UPDATE process_extractions SET status='completed',output_json=?,completed_at=? WHERE id=?")
        .run(JSON.stringify(repairs.length ? { ...output, validationRepairs: repairs } : output), new Date().toISOString(), id);
      if (phase === 'match' && (output as { sameWorkflow?: boolean }).sameWorkflow && !(output as { assessment: { reuse?: string | null } }).assessment.reuse) saveMissingWorkflowDisplays([id]);
      return output;
    } catch (error) {
      db.prepare('UPDATE process_extractions SET status=?,output_json=?,completed_at=? WHERE id=?').run(signal.aborted || (isPreparationLimit(error) && raw === undefined) ? 'cancelled' : 'failed',
        JSON.stringify({ failure: { stage, message: cleanText(error instanceof Error ? error.message : 'Workflow learning failed', 1500) }, raw_output: raw, validationRepairs: repairs }), new Date().toISOString(), id);
      if (isPreparationLimit(error) && raw !== undefined) throw Error(`Comparison correction could not run at the call limit. ${repairs.at(-1)?.error || 'The first response failed validation.'}`);
      throw error;
    }
  }
  const learnTask = async (current: Episode) => {
    signal.throwIfAborted();
    const first = await readLearningParent(current, signal);
    if (first.location.kind === 'unavailable') throw Error('Workflow task location is unavailable');
    const locations = new Map<string, string>();
    const candidates = db.prepare(`SELECT e.id episode,e.revision,json_extract(p.source_dependencies_json,'$.input.workspace') workspace FROM work_episodes e
      JOIN episode_extractions l ON l.episode_id=e.id JOIN process_extractions p ON p.id=l.extraction_id
      WHERE e.assembly='reconciled' AND e.superseded_by IS NULL AND e.id<>? AND
      (e.rowid<(SELECT rowid FROM work_episodes WHERE id=?) OR e.learning_status='completed')
      GROUP BY e.id ORDER BY e.rowid DESC`).iterate(current.episode, current.episode) as Iterable<Episode & { workspace: string }>;
    const parents: EpisodeParent[] = [{ episode: current.episode, revision: current.revision }], inputs = [first.input], identities = [first.identity];
    let scanned = 0;
    // Error writes must wait until the SQLite read iterator is closed.
    const contextErrors: { candidate: Episode; error: unknown }[] = [];
    try { for (const candidate of candidates) {
      if (parents.length === 25) break;
      if (++scanned % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      signal.throwIfAborted();
      if (!locations.has(candidate.workspace)) locations.set(candidate.workspace, workflowLocation(candidate.workspace).key);
      if (locations.get(candidate.workspace) !== first.location.key) continue;
      try { const value = await readLearningParent(candidate, signal); if (value.location.key !== first.location.key || !independentTasks(current, candidate)) continue; parents.push({ episode: candidate.episode, revision: candidate.revision }); inputs.push(value.input); identities.push(value.identity); }
      catch (error) { signal.throwIfAborted(); contextErrors.push({ candidate, error }); }
    }
    } finally { for (const { candidate, error } of contextErrors) recordPreparationError(run, 'workflow-context', `${candidate.episode}:${candidate.revision}`, error, undefined, {}, 2); }
    if (parents.length > 1) {
      const ids = parents.slice(1).map((_, i) => `C${i + 1}`);
      const selected = await invoke(parents, identities, first.location, 'select', undefined, { task: 'select_workflow_candidates', stage: 'workflow_selection',
        current: { goal: first.input.goal, context: first.input.context },
        candidates: ids.map((id, i) => ({ id, goal: inputs[i + 1].goal, context: inputs[i + 1].context })) }, CANDIDATE_PROMPT,
        raw => ({ selected: candidateSelection(raw, ids) }));
      for (const id of selected.selected) {
        const index = ids.indexOf(id) + 1, pair = [inputs[0], inputs[index]], saved = savedWorkflowCandidates(first.location.key);
        const operationKey = JSON.stringify([digest(CONTRACT_MATCH_PROMPT), model, [identities[0], identities[index]].sort()]);
        await preparationOperation(run, 'comparison', operationKey, signal, () =>
          invoke(parents, identities, first.location, 'match', [0, index], workflowComparisonPayload(pair, saved), CONTRACT_MATCH_PROMPT,
            raw => { const value = JSON.parse(raw); const assessment = validateContractAssessment(JSON.stringify(value.assessment ?? value), pair, saved); return decideContractMatch(assessment, pair, saved); }, saved), current.episode);
      }
    }
    signal.throwIfAborted();
    db.prepare("UPDATE work_episodes SET learning_status='completed' WHERE id=?").run(current.episode);
  };
  for (const current of pending) {
    signal.throwIfAborted();
    const failures = workflowTaskFailures(current.episode, current.revision);
    if (failures.some(failure => failure.retry_state === 0)) continue;
    await preparationOperation(run, 'workflow-task', `${model}:${current.episode}:${current.revision}`, signal, () => learnTask(current), current.episode);
    // An explicitly requested retry may use a different model; retain its old failure receipt as handled.
    for (const failure of failures) db.prepare("UPDATE preparation_errors SET retry_state=2 WHERE scope='workflow-task' AND operation_key=? AND retry_state=1").run(failure.operation_key);
  }
}
