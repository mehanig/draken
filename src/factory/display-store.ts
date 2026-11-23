import { getDb } from '../db/schema';
import { assembledTaskInput, contractMatchInput, type ContractMatchInput, type ProcessExtraction } from '../workflow-learning';
import { independentTasks, type LearningParent, type EpisodeParent } from './episode-store';
import type { FactoryPage, SavedEnrichment, WorkflowLocation } from './types';

type Proposal = FactoryPage['proposals'][number];

export function saveWorkflowDisplay(proposal: Proposal): void {
  const { enrichment: _enrichment, ...saved } = proposal;
  getDb().prepare('UPDATE workflow_discoveries SET display_json=? WHERE id=?').run(JSON.stringify(saved), proposal.id);
}

/** Preparation/migration only. Reconstruct presentation from already stored results, never original files. */
export function saveMissingWorkflowDisplays(ids?: readonly string[]): void {
  const db = getDb(), proposals = new Map<string, Proposal>(), parents = new Map<string, ContractMatchInput>();
  const process = (extraction: string, fragment: string) => {
    const row = db.prepare('SELECT output_json FROM process_extractions WHERE id=?').get(extraction) as { output_json: string };
    const value: ProcessExtraction = JSON.parse(row.output_json);
    return { fragment: value.fragments.find(f => f.key === fragment)!, limitations: value.limitations };
  };
  function input(parent: LearningParent): ContractMatchInput {
    const key = JSON.stringify(parent);
    if (!parents.has(key)) {
      if ('extraction' in parent) {
        const saved = process(parent.extraction, parent.fragment);
        parents.set(key, { ...contractMatchInput(saved.fragment), limitations: saved.limitations });
      } else {
        const row = db.prepare(`SELECT r.output_json,json_extract(r.source_dependencies_json,'$.parents') parents,v.assembly_index
          FROM episode_revisions v JOIN episode_reconstructions r ON r.id=v.reconstruction_id WHERE v.episode_id=? AND v.revision=?`).get(parent.episode, parent.revision) as { output_json: string; parents: string; assembly_index: number | null };
        const output = JSON.parse(row.output_json), task = row.assembly_index === null ? output : output.tasks[row.assembly_index];
        const sources = JSON.parse(row.parents);
        parents.set(key, assembledTaskInput(task, task.members.map((id: string) => { const p = sources[Number(id.slice(1))]; return process(p.extraction, p.fragment); })));
      }
    }
    return parents.get(key)!;
  }
  function proposal(id: string): Proposal {
    if (proposals.has(id)) return proposals.get(id)!;
    const row = db.prepare('SELECT * FROM workflow_discoveries WHERE id=?').get(id) as { id: string; model: string; created_at: string; display_json: string | null; origin: string; source_json: string; output_json: string; request_json: string };
    if (row.display_json) return JSON.parse(row.display_json);
    const base = { id, model: row.model, createdAt: row.created_at };
    const consolidated = db.prepare(`SELECT c.group_index,c.task_parents_json,b.output_json,b.request
      FROM workflow_consolidations c JOIN workflow_consolidation_batches b ON b.id=c.batch_id WHERE c.workflow_id=?`).get(id) as { group_index: number; task_parents_json: string; output_json: string; request: string } | undefined;
    let result: Proposal;
    if (consolidated) {
      const group = JSON.parse(consolidated.output_json).groups[consolidated.group_index];
      const originals: Proposal[] = group.members.map(proposal), tasks: EpisodeParent[] = JSON.parse(consolidated.task_parents_json), evidence = tasks.map(input);
      result = { ...base, decision: null, location: originals[0].location, aliases: [...new Set(originals.flatMap(p => [p.id, ...(p.aliases || [])]))], evidence,
        task: { workflow: group.workflow, reason: group.reason, request: consolidated.request,
          exampleCount: tasks.every((a, i) => tasks.slice(i + 1).every(b => independentTasks(a, b))) ? tasks.length : null,
          limitations: [...new Set(evidence.flatMap(e => [...(e.limitations || []), ...e.gaps]))] } };
    } else if (row.origin === 'requested') {
      const output = JSON.parse(row.output_json), sources = JSON.parse(row.source_json);
      result = { ...base, decision: null, location: sources.location, task: { workflow: output.workflow, limitations: output.process.limitations, reason: output.message, request: JSON.parse(row.request_json).question },
        evidence: [{ ...contractMatchInput(output.process.fragments.find((f: { key: string }) => f.key === output.fragment)), limitations: output.process.limitations }] };
    } else {
      const saved = db.prepare(`SELECT output_json,json_extract(source_dependencies_json,'$.location') location,
        json_extract(source_dependencies_json,'$.parents') parents,json_extract(source_dependencies_json,'$.pair') pair FROM process_extractions WHERE id=?`).get(id) as { output_json: string; location: string; parents: string; pair: string };
      const sourceParents = JSON.parse(saved.parents);
      const location: WorkflowLocation = saved.location ? JSON.parse(saved.location) : { kind: 'unavailable', key: '', path: '', name: 'Location not recorded' };
      result = { ...base, location, decision: JSON.parse(saved.output_json), evidence: JSON.parse(saved.pair).map((i: number) => input(sourceParents[i])) };
    }
    proposals.set(id, result); saveWorkflowDisplay(result); return result;
  }
  const missing = ids || (db.prepare('SELECT id FROM workflow_discoveries WHERE display_json IS NULL ORDER BY rowid').all() as { id: string }[]).map(row => row.id);
  for (const id of missing) proposal(id);
}

export function displayEnrichment(id: string): SavedEnrichment {
  const row = getDb().prepare(`SELECT e.status,e.output_json,e.run_table,CASE e.run_table WHEN 'sync_runs' THEN s.status ELSE b.status END owner_status
    FROM workflow_enrichments e LEFT JOIN sync_runs s ON e.run_table='sync_runs' AND s.id=e.run_id
    LEFT JOIN background_runs b ON e.run_table='background_runs' AND b.id=e.run_id WHERE e.workflow_id=? ORDER BY e.id DESC LIMIT 1`)
    .get(id) as { status: string; output_json: string | null; owner_status: string | null; run_table: string } | undefined;
  if (!row || (row.status === 'cancelled' && row.run_table === 'background_runs')) return { status: 'pending' };
  return row.status === 'completed' ? { status: 'ready', value: JSON.parse(row.output_json!) } : { status: row.status === 'running' && row.owner_status === 'running' ? 'running' : 'failed' };
}
