import { getDb } from '../db/schema';
import { digest, cleanText } from '../sync/normalize';
import { workflowLocation } from './location';
import { isBatchSummaryModel, LUNA_BATCH, promptTokens } from '../sync/summary-budget';
import { readProcessParent, readProcessParents, learningInputKey, LEARNING_FORMAT, type ProcessParent } from './process-store';
import { TASK_RECONSTRUCTION_PROMPT, reconstructTask, assembledTaskInput, reconstructionEvidence, type TaskFragment } from '../workflow-learning';

export interface EpisodeParent { episode: string; revision: number }
export type LearningParent = ProcessParent | EpisodeParent;
type Loaded = Awaited<ReturnType<typeof readProcessParent>>;
interface Group { episode?: string; parents: ProcessParent[] }
interface Receipt { id: string; input_key: string; recipe_version: string; model: string; status: string; source_dependencies_json: string; output_json: string }
const FORMAT = 'task-reconstruction-v1';
const key = (p: ProcessParent) => JSON.stringify([p.extraction, p.fragment]);
const payload = (loaded: Loaded[], excerpts: false | 1000 | 2000 = 1000) => ({ task: 'reconstruct_task', stage: 'task_reconstruction', current: { fragment: 'F0', goal: loaded[0].fragment.goal, context: loaded[0].fragment.context }, fragments: loaded.map((v, i): TaskFragment => ({ id: `F${i}`, process: v.fragment, ...(excerpts ? reconstructionEvidence(v.fragment, v.records, excerpts) : { records: v.records }) })) });

const load = readProcessParents;
function verify(loaded: Loaded[], identities: string[], location: string) {
  if (JSON.stringify(loaded.map(v => v.identity)) !== JSON.stringify(identities) || loaded.some(v => v.location.kind === 'unavailable' || v.location.key !== location)) throw Error('Task reconstruction sources or location changed');
}
export async function readLearningParents(parents: LearningParent[], signal: AbortSignal) {
  const frames = parents.map(parent => {
    if ('extraction' in parent) return { parent, row: undefined, deps: { parents: [parent] } };
    const row = getDb().prepare(`SELECT r.* FROM episode_revisions v JOIN episode_reconstructions r ON r.id=v.reconstruction_id
      WHERE v.episode_id=? AND v.revision=? AND r.status='completed'`).get(parent.episode, parent.revision) as Receipt | undefined;
    if (!row) throw Error('Reconstructed task unavailable');
    const deps = JSON.parse(row.source_dependencies_json);
    if (deps.format !== FORMAT || !Array.isArray(deps.parents) || !deps.parents.length || deps.parents.length > 64) throw Error('Invalid task reconstruction receipt');
    return { parent, row, deps };
  });
  const unique = [...new Map(frames.flatMap(frame => frame.deps.parents as ProcessParent[]).map(parent => [key(parent), parent])).values()];
  const originals = await load(unique, signal), byParent = new Map(unique.map((parent, i) => [key(parent), originals[i]]));
  return frames.map(({ parent, row, deps }) => {
    if ('extraction' in parent) return byParent.get(key(parent))!;
    if (!row) throw Error('Reconstructed task unavailable');
    const loaded = (deps.parents as ProcessParent[]).map(p => byParent.get(key(p))!); verify(loaded, deps.identities, deps.location);
    if (deps.projection !== undefined && !['task-excerpts-v1', 'task-excerpts-v2'].includes(deps.projection)) throw Error('Unknown task evidence projection');
    const input = payload(loaded, deps.projection === undefined ? false : deps.projection === 'task-excerpts-v1' ? 2000 : 1000);
    if (typeof deps.prompt !== 'string' || row.recipe_version !== digest(deps.prompt) || row.input_key !== learningInputKey(deps, input, row.model)) throw Error('Task reconstruction input changed');
    const result = reconstructTask(row.output_json, input.fragments);
    const selected = result.members.map(id => loaded[Number(id.slice(1))]);
    return { location: loaded[0].location, input: assembledTaskInput(result, selected.map(v => ({ fragment: v.fragment, limitations: v.input.limitations }))),
      identity: digest(JSON.stringify([{ episode: parent.episode, revision: parent.revision }, row.output_json, deps, loaded.map(v => v.identity)])), leaf: parent.episode,
      primary: [...new Set(selected.flatMap(v => v.primary))] };
  });
}
export async function readLearningParent(parent: LearningParent, signal: AbortSignal) {
  return (await readLearningParents([parent], signal))[0];
}
export function independentTasks(left: LearningParent, right: LearningParent): boolean {
  if (!('episode' in left) || !('episode' in right)) return true;
  const root = (id: string) => {
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(id)) throw Error('Invalid task lineage'); seen.add(id);
      const row = getDb().prepare('SELECT superseded_by FROM work_episodes WHERE id=?').get(id) as { superseded_by: string | null } | undefined;
      if (!row) throw Error('Task identity unavailable');
      if (!row.superseded_by) return id;
      id = row.superseded_by;
    }
  };
  if (root(left.episode) === root(right.episode)) return false;
  const snapshot = (parent: EpisodeParent) => {
    const row = getDb().prepare(`SELECT r.source_dependencies_json,r.output_json FROM episode_revisions v
      JOIN episode_reconstructions r ON r.id=v.reconstruction_id WHERE v.episode_id=? AND v.revision=? AND r.status='completed'`)
      .get(parent.episode, parent.revision) as Pick<Receipt, 'source_dependencies_json' | 'output_json'> | undefined;
    if (!row) throw Error('Task identity proof unavailable');
    const parents: ProcessParent[] = JSON.parse(row.source_dependencies_json).parents, members: string[] = JSON.parse(row.output_json).members;
    return { considered: new Set(parents.map(key)), selected: new Set(members.map(id => key(parents[Number(id.slice(1))]))) };
  };
  const a = snapshot(left), b = snapshot(right);
  if (!a.selected.size || !b.selected.size || [...a.selected].some(id => b.selected.has(id))) return false;
  return [...b.selected].every(id => a.considered.has(id)) || [...a.selected].every(id => b.considered.has(id));
}

export async function reconstructPendingTasks(run: number, model: string, ask: (payload: unknown, system: string) => Promise<string>, signal: AbortSignal): Promise<void> {
  const db = getDb();
  const pending = db.prepare(`SELECT e.id,l.extraction_id extraction,l.fragment_key fragment FROM work_episodes e
    JOIN episode_extractions l ON l.episode_id=e.id JOIN process_extractions p ON p.id=l.extraction_id
    WHERE e.assembly='fragment' AND e.learning_status='pending' AND p.status='completed'
      AND json_extract(p.source_dependencies_json,'$.format')=? ORDER BY e.rowid`).all(LEARNING_FORMAT) as (ProcessParent & { id: string })[];
  for (const current of pending) {
    signal.throwIfAborted();
    if (!(db.prepare("SELECT 1 FROM work_episodes WHERE id=? AND learning_status='pending'").get(current.id))) continue;
    let first: Loaded;
    try { first = await readProcessParent(current, signal); }
    catch { signal.throwIfAborted(); db.prepare("UPDATE work_episodes SET learning_status='completed' WHERE id=?").run(current.id); continue; }
    if (first.location.kind === 'unavailable') continue;
    const groups: Group[] = [], parents: ProcessParent[] = [{ extraction: current.extraction, fragment: current.fragment }], loaded = [first];
    const fits = (values: Loaded[]) => {
      const input = JSON.stringify(payload(values));
      return Buffer.byteLength(input) <= LUNA_BATCH.requestBytes && promptTokens(input, TASK_RECONSTRUCTION_PROMPT) <= (isBatchSummaryModel(model) ? LUNA_BATCH.plannedRequestTokens : LUNA_BATCH.finalTokens);
    };
    if (!fits(loaded)) throw Error('Task fragment exceeds the reconstruction input budget');
    const seen = new Set([key(current)]);
    const candidates = db.prepare(`SELECT e.id,e.assembly FROM work_episodes e WHERE e.id<>? AND e.superseded_by IS NULL AND (
      e.assembly='reconciled' OR (e.assembly='fragment' AND (e.learning_status='pending' OR EXISTS (
        SELECT 1 FROM episode_extractions l JOIN episode_reconstructions r ON r.current_extraction=l.extraction_id AND r.current_fragment=l.fragment_key
        WHERE l.episode_id=e.id AND r.status='completed' AND json_extract(r.output_json,'$.status')='uncertain'))
        AND NOT EXISTS (SELECT 1 FROM episode_extractions l JOIN episode_memberships m ON m.extraction_id=l.extraction_id AND m.fragment_key=l.fragment_key WHERE l.episode_id=e.id)))
      ORDER BY e.rowid DESC`).iterate(current.id) as Iterable<{ id: string; assembly: string }>;
    let scanned = 0;
    for (const candidate of candidates) {
      if (groups.length === 24 || parents.length === 64) break;
      if (++scanned % 32 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); signal.throwIfAborted(); }
      const members = db.prepare(`SELECT l.extraction_id extraction,l.fragment_key fragment,json_extract(p.source_dependencies_json,'$.input.workspace') workspace
        FROM episode_extractions l JOIN process_extractions p ON p.id=l.extraction_id WHERE l.episode_id=? ORDER BY p.rowid,l.fragment_key`).all(candidate.id) as (ProcessParent & { workspace: string })[];
      if (!members.length || parents.length + members.length > 64 || members.some(p => workflowLocation(p.workspace).key !== first.location.key || seen.has(key(p)))) continue;
      let values: Loaded[];
      try { values = await load(members, signal); }
      catch { signal.throwIfAborted(); continue; }
      if (values.some(v => v.location.key !== first.location.key) || !fits([...loaded, ...values])) continue;
      const group = { ...(candidate.assembly === 'reconciled' ? { episode: candidate.id } : {}), parents: members.map(({ extraction, fragment }) => ({ extraction, fragment })) };
      groups.push(group); for (const p of group.parents) seen.add(key(p)); parents.push(...group.parents); loaded.push(...values);
    }
    const identities = loaded.map(v => v.identity), deps = { format: FORMAT, projection: 'task-excerpts-v2', prompt: TASK_RECONSTRUCTION_PROMPT, parents, identities, location: first.location.key };
    const input = payload(loaded), inputKey = learningInputKey(deps, input, model), recipe = digest(TASK_RECONSTRUCTION_PROMPT);
    const previous = db.prepare('SELECT status,run_id FROM episode_reconstructions WHERE input_key=? ORDER BY rowid DESC LIMIT 1').get(inputKey) as { status: string; run_id: number } | undefined;
    if (previous?.run_id === run && previous.status !== 'cancelled') throw Error('Task reconstruction needs an explicit retry');
    const id = digest(JSON.stringify([inputKey, recipe, run, db.prepare('SELECT COUNT(*) n FROM episode_reconstructions WHERE input_key=?').get(inputKey)]));
    db.prepare(`INSERT INTO episode_reconstructions(id,input_key,recipe_version,model,current_extraction,current_fragment,run_id,status,source_dependencies_json,created_at)
      VALUES (?,?,?,?,?,?,?,'running',?,?)`).run(id, inputKey, recipe, model, current.extraction, current.fragment, run, JSON.stringify(deps), new Date().toISOString());
    try {
      verify(await load(parents, signal), identities, first.location.key);
      const raw = await ask(input, TASK_RECONSTRUCTION_PROMPT);
      db.prepare('UPDATE episode_reconstructions SET raw_output=? WHERE id=?').run(raw, id);
      signal.throwIfAborted();
      const result = reconstructTask(raw, input.fragments);
      const members = result.members.map(id => parents[Number(id.slice(1))]), selected = new Set(members.map(key));
      const merged = groups.filter(g => g.episode && g.parents.some(p => selected.has(key(p))));
      if (merged.some(g => g.parents.some(p => !selected.has(key(p))))) throw Error('Task reconstruction split an existing task; review is required');
      verify(await load(parents, signal), identities, first.location.key); signal.throwIfAborted();
      db.transaction(() => {
        if (result.status === 'task') {
          const ids = merged.map(g => g.episode!);
          const existing = ids.length ? db.prepare(`SELECT id,revision FROM work_episodes WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid LIMIT 1`).get(...ids) as { id: string; revision: number } : undefined;
          const episode = existing?.id || digest(JSON.stringify([FORMAT, current.extraction, current.fragment])), revision = existing ? existing.revision + 1 : 1;
          const state = result.coverage.triggerRefs.length && result.coverage.outcomeRefs.length && !result.coverage.gaps.length ? 'completed' : 'partial';
          if (existing) db.prepare("UPDATE work_episodes SET revision=?,state=?,description_json=?,learning_status='pending' WHERE id=?").run(revision, state, JSON.stringify(result), episode);
          else db.prepare("INSERT INTO work_episodes(id,revision,state,description_json,assembly,learning_status) VALUES (?,?,?,?,'reconciled','pending')").run(episode, revision, state, JSON.stringify(result));
          db.prepare('INSERT INTO episode_revisions VALUES (?,?,?)').run(episode, revision, id);
          for (const parent of members) {
            db.prepare('INSERT OR REPLACE INTO episode_memberships VALUES (?,?,?)').run(parent.extraction, parent.fragment, episode);
            db.prepare('INSERT OR IGNORE INTO episode_extractions VALUES (?,?,?)').run(episode, parent.extraction, parent.fragment);
            db.prepare("UPDATE work_episodes SET learning_status='completed' WHERE assembly='fragment' AND id IN (SELECT episode_id FROM episode_extractions WHERE extraction_id=? AND fragment_key=?)").run(parent.extraction, parent.fragment);
          }
          for (const old of ids.filter(value => value !== episode)) db.prepare("UPDATE work_episodes SET superseded_by=?,learning_status='completed' WHERE id=?").run(episode, old);
        } else db.prepare("UPDATE work_episodes SET learning_status='completed' WHERE id=?").run(current.id);
        db.prepare("UPDATE episode_reconstructions SET status='completed',output_json=?,completed_at=? WHERE id=?").run(JSON.stringify(result), new Date().toISOString(), id);
      })();
    } catch (error) {
      db.prepare('UPDATE episode_reconstructions SET status=?,error=?,completed_at=? WHERE id=?').run(signal.aborted ? 'cancelled' : 'failed', cleanText(error instanceof Error ? error.message : 'Task reconstruction failed', 1500), new Date().toISOString(), id);
      throw error;
    }
  }
}
