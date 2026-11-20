import { getDb } from '../db/schema';
import { digest } from '../sync/normalize';
import { CANDIDATE_PROMPT, candidateSelection, CONTRACT_MATCH_PROMPT, validateContractAssessment, decideContractMatch } from '../workflow-learning';
import { LEARNING_FORMAT, COMPARISON_FORMAT, learningInputKey, workflowComparisonPayload, readProcessParent, type ProcessParent } from './learning-store';

type Ask = (payload: unknown, system: string) => Promise<string>;
interface Episode extends ProcessParent { episode: string }
/** Owned by the summarization job: no scheduler, provider client or allowance of its own. */
export async function learnSummaryWorkflows(run: number, model: string, ask: Ask, signal: AbortSignal): Promise<void> {
  const db = getDb();
  const pending = db.prepare(`SELECT e.id episode,l.extraction_id extraction,l.fragment_key fragment FROM work_episodes e
    JOIN episode_extractions l ON l.episode_id=e.id JOIN process_extractions p ON p.id=l.extraction_id
    WHERE e.learning_status='pending' AND p.status='completed' AND json_extract(p.source_dependencies_json,'$.format')=? ORDER BY e.rowid`).all(LEARNING_FORMAT) as Episode[];
  async function load(parents: ProcessParent[]) {
    const values = [];
    for (const parent of parents) values.push(await readProcessParent(parent, signal));
    return values;
  }
  async function invoke<T>(parents: ProcessParent[], expectedIdentities: string[], phase: string, pair: number[] | undefined, payload: unknown, prompt: string, validate: (raw: string) => T): Promise<T> {
    signal.throwIfAborted();
    const before = await load(parents), identities = before.map(v => v.identity);
    if (JSON.stringify(identities) !== JSON.stringify(expectedIdentities)) throw Error('Workflow inputs changed before inference');
    const deps = { format: COMPARISON_FORMAT, phase, parents, identities, ...(pair ? { pair } : {}) };
    const key = learningInputKey(deps, payload, model), recipe = digest(prompt);
    const previous = db.prepare('SELECT id,status,output_json,usage_json FROM process_extractions WHERE input_key=? AND recipe_version=? AND model=? ORDER BY rowid DESC LIMIT 1').get(key, recipe, model) as { id: string; status: string; output_json: string; usage_json: string } | undefined;
    if (previous?.status === 'completed') return validate(previous.output_json);
    if (previous && previous.status !== 'cancelled' && JSON.parse(previous.usage_json).backgroundRun === run) throw Error('Workflow attempt failed or was interrupted; explicit retry is required');
    const attempt = (db.prepare('SELECT COUNT(*) n FROM process_extractions WHERE input_key=?').get(key) as { n: number }).n;
    const id = digest(JSON.stringify([key, recipe, run, attempt]));
    db.prepare(`INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,usage_json,created_at)
      VALUES (?,'comparison',?,?,?,'running',?,?,?)`).run(id, key, recipe, model, JSON.stringify(deps), JSON.stringify({ backgroundRun: run }), new Date().toISOString());
    try {
      const raw = await ask(payload, prompt); signal.throwIfAborted();
      const output = validate(raw);
      if (JSON.stringify((await load(parents)).map(v => v.identity)) !== JSON.stringify(identities)) throw Error('Workflow sources changed during inference');
      signal.throwIfAborted();
      db.prepare("UPDATE process_extractions SET status='completed',output_json=?,completed_at=? WHERE id=?").run(JSON.stringify(output), new Date().toISOString(), id);
      return output;
    } catch (error) {
      db.prepare('UPDATE process_extractions SET status=?,completed_at=? WHERE id=?').run(signal.aborted ? 'cancelled' : 'failed', new Date().toISOString(), id);
      throw error;
    }
  }
  for (const current of pending) {
    signal.throwIfAborted();
    let first;
    try { first = await readProcessParent(current, signal); }
    catch { signal.throwIfAborted(); db.prepare("UPDATE work_episodes SET learning_status='completed' WHERE id=?").run(current.episode); continue; }
    const primary = new Set(first.primary);
    const candidates = db.prepare(`SELECT e.id episode,l.extraction_id extraction,l.fragment_key fragment FROM work_episodes e
      JOIN episode_extractions l ON l.episode_id=e.id JOIN process_extractions p ON p.id=l.extraction_id
      WHERE l.extraction_id<>? AND e.rowid<(SELECT rowid FROM work_episodes WHERE id=?) AND p.status='completed' AND json_extract(p.source_dependencies_json,'$.format')=? ORDER BY e.rowid DESC LIMIT 24`).all(current.extraction, current.episode, LEARNING_FORMAT) as Episode[];
    const parents: ProcessParent[] = [{ extraction: current.extraction, fragment: current.fragment }], inputs = [first.input], identities = [first.identity];
    for (const candidate of candidates) {
      try { const value = await readProcessParent(candidate, signal); if (value.leaf === first.leaf || value.primary.some(ref => primary.has(ref))) continue; parents.push({ extraction: candidate.extraction, fragment: candidate.fragment }); inputs.push(value.input); identities.push(value.identity); }
      catch { signal.throwIfAborted(); }
    }
    if (parents.length > 1) {
      const ids = parents.slice(1).map((_, i) => `C${i + 1}`);
      const selected = await invoke(parents, identities, 'select', undefined, { task: 'select_workflow_candidates', stage: 'workflow_selection',
        current: { goal: first.input.goal, context: first.input.context },
        candidates: ids.map((id, i) => ({ id, goal: inputs[i + 1].goal, context: inputs[i + 1].context })) }, CANDIDATE_PROMPT,
        raw => ({ selected: candidateSelection(raw, ids) }));
      for (const id of selected.selected) {
        const index = ids.indexOf(id) + 1, pair = [inputs[0], inputs[index]];
        await invoke(parents, identities, 'match', [0, index], workflowComparisonPayload(pair), CONTRACT_MATCH_PROMPT,
          raw => { const value = JSON.parse(raw); const assessment = validateContractAssessment(JSON.stringify(value.assessment ?? value), pair); return decideContractMatch(assessment, pair); });
      }
    }
    signal.throwIfAborted();
    db.prepare("UPDATE work_episodes SET learning_status='completed' WHERE id=?").run(current.episode);
  }
}
