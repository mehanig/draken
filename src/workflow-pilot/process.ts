import type Database from 'better-sqlite3';
import { digest } from '../sync/normalize';
import { PLAIN_ENGLISH } from '../plain-english';
import { PROCESS_RECIPE, PROCESS_PROMPT, MATCH_PROMPT, validateProcess, validateProcessEvidence, validateProcessMatch, processMatchInput, type ProcessExtraction, type ProcessFragment, type ProcessMatch } from '../workflow-learning';
import { readPilotBatch, type PilotCapture } from './evidence-host';
import type { PilotModel } from './backfill';

export const PROCESS_PILOT_LIMIT = 7;

interface Dependencies { source: string; captures: PilotCapture[]; parents?: string[] }
interface Row { id: string; status: string; output_json: string | null; source_dependencies_json: string; model: string }
async function read(source: Database.Database, dependencies: Dependencies, signal: AbortSignal) {
  if (dependencies.source !== source.name) throw Error('Process sample belongs to another source database');
  const packets = [];
  for (const capture of dependencies.captures) {
    if (!capture.originals.length || capture.originals.length > 24) throw Error('Process sample requires 1–24 originals');
    for (let i = 0; i < capture.originals.length; i += 8) packets.push(await readPilotBatch(source, capture, capture.originals.slice(i, i + 8), signal));
  }
  signal.throwIfAborted();
  return packets;
}
/** Experiment only: dedicated store, exclusive ownership by caller, at most SEVEN invocations total (five initial calls plus two explicit source-audit correction calls).
 * Failed/interrupted rows never automatically retry. The next iteration needs explicit retry policy. */
async function invoke<T>(source: Database.Database, store: Database.Database, dependencies: Dependencies, model: string,
  kind: 'summary' | 'comparison', payload: unknown, prompt: string, validate: (raw: string) => T, ask: PilotModel, signal: AbortSignal) {
  const before = JSON.stringify(await read(source, dependencies, signal));
  const recipe = digest(JSON.stringify([PROCESS_RECIPE, prompt, PLAIN_ENGLISH]));
  const inputKey = digest(JSON.stringify([dependencies, payload]));
  const id = digest(JSON.stringify([kind, inputKey, recipe, model]));
  const cached = store.prepare('SELECT * FROM process_extractions WHERE id=?').get(id) as Row | undefined;
  if (cached) {
    if (cached.status !== 'completed' || !cached.output_json) throw Error('This attempt failed or was interrupted; no automatic retry. Inspect the stored attempt.');
    return { id, output: validate(cached.output_json), cached: true };
  }
  signal.throwIfAborted();
  store.transaction(() => {
    const count = (store.prepare('SELECT COUNT(*) n FROM process_extractions').get() as { n: number }).n;
    if (count >= PROCESS_PILOT_LIMIT) throw Error('Process v2 experiment reached its lifetime limit of seven invocations');
    store.prepare(`INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,created_at)
      VALUES (?,?,?,?,?,'running',?,?)`).run(id, kind, inputKey, recipe, model, JSON.stringify(dependencies), new Date().toISOString());
  })();
  try {
    const raw = await ask(JSON.stringify(payload), { model, system: prompt, signal,
      onAccounting: usage => store.prepare('UPDATE process_extractions SET usage_json=? WHERE id=?').run(JSON.stringify(usage), id) });
    signal.throwIfAborted();
    const output = validate(raw);
    if (JSON.stringify(await read(source, dependencies, signal)) !== before) throw Error('Process evidence changed during inference');
    signal.throwIfAborted();
    store.transaction(() => {
      store.prepare("UPDATE process_extractions SET status='completed',output_json=?,completed_at=? WHERE id=?")
        .run(JSON.stringify(output), new Date().toISOString(), id);
      if (kind === 'summary') for (const fragment of (output as ProcessExtraction).fragments) {
        const episode = digest(JSON.stringify([id, fragment.key]));
        store.prepare('INSERT INTO work_episodes(id,state,description_json) VALUES (?,?,?)').run(episode, fragment.state, JSON.stringify(fragment));
        store.prepare('INSERT INTO episode_extractions(episode_id,extraction_id,fragment_key) VALUES (?,?,?)').run(episode, id, fragment.key);
      }
    })();
    return { id, output, cached: false };
  } catch (error) {
    store.prepare('UPDATE process_extractions SET status=?,completed_at=? WHERE id=?').run(signal.aborted ? 'cancelled' : 'failed', new Date().toISOString(), id);
    throw error;
  }
}
export async function summarizeProcessSample(source: Database.Database, store: Database.Database, capture: PilotCapture, model: string, ask: PilotModel, signal: AbortSignal) {
  const dependencies = { source: source.name, captures: [capture] };
  const packets = await read(source, dependencies, signal);
  const records = packets.flatMap(p => p.records);
  return invoke(source, store, dependencies, model, 'summary', {
    task: 'summarize_with_process', records,
    limitations: [...packets.flatMap(p => p.limitations), `Explicit sample: ${capture.originals.length} of ${capture.eligibleRecords} eligible records; not a complete episode by default.`],
  }, PROCESS_PROMPT, raw => validateProcessEvidence(validateProcess(raw, records.map(r => r.ref)), records), ask, signal);
}
export async function compareProcessSamples(source: Database.Database, store: Database.Database, selections: { extraction: string; fragment: string }[], model: string, ask: PilotModel, signal: AbortSignal) {
  if (selections.length !== 2 || new Set(selections.map(s => `${s.extraction}:${s.fragment}`)).size !== 2) throw Error('Select two distinct process fragments');
  const captures: PilotCapture[] = [], inputs: (ReturnType<typeof processMatchInput> & { limitations: string[] })[] = [];
  for (const selection of selections) {
    const row = store.prepare("SELECT * FROM process_extractions WHERE id=? AND kind='summary' AND status='completed'").get(selection.extraction) as Row | undefined;
    if (!row?.output_json) throw Error('Missing completed process extraction');
    const deps = JSON.parse(row.source_dependencies_json) as Dependencies;
    const packets = await read(source, deps, signal);
    const records = packets.flatMap(p => p.records);
    const value = validateProcessEvidence(validateProcess(row.output_json, records.map(r => r.ref)), records);
    const fragment: ProcessFragment | undefined = value.fragments.find(f => f.key === selection.fragment);
    if (!fragment) throw Error('Unknown process fragment');
    captures.push(...deps.captures);
    inputs.push({ ...processMatchInput(fragment), limitations: value.limitations });
  }
  const dependencies = { source: source.name, captures, parents: selections.map(s => `${s.extraction}:${s.fragment}`) };
  return invoke<ProcessMatch>(source, store, dependencies, model, 'comparison', { task: 'compare_processes', candidates: inputs }, MATCH_PROMPT, raw => validateProcessMatch(raw, inputs), ask, signal);
}
