import { getDb } from '../db/schema';
import { digest } from '../sync/normalize';
import { consolidatedWorkflows } from '../workflow-learning';
import { readLearningParents, independentTasks, type EpisodeParent } from './episode-store';
import type { FactoryPage } from './types';

type Proposal = FactoryPage['proposals'][number];
interface Batch { id: string; run_id: number; model: string; source_json: string; output_json: string; request: string; created_at: string }
interface Sources {
  format: 'workflow-consolidation-v1';
  proposals: { id: string; revision: string; tasks: EpisodeParent[] }[];
  tasks: (EpisodeParent & { identity: string })[];
}
const taskKey = (parent: EpisodeParent) => JSON.stringify([parent.episode, parent.revision]);
export const consolidationBatchId = (batch: Omit<Batch, 'id' | 'output_json'>) => digest(JSON.stringify([batch.source_json, batch.model, batch.request, batch.created_at, batch.run_id]));
export const consolidatedWorkflowId = (batch: Pick<Batch, 'id' | 'output_json'>, index: number, parentsJson: string) => digest(JSON.stringify([batch.id, index, parentsJson, batch.output_json]));

export function consolidationReader(signal: AbortSignal, read: (id: string) => Promise<Proposal>, revision: (proposal: Proposal) => string) {
  async function load(id: string) {
    signal.throwIfAborted();
    const db = getDb(), batch = db.prepare('SELECT * FROM workflow_consolidation_batches WHERE id=?').get(id) as Batch | undefined;
    if (!batch || consolidationBatchId(batch) !== id) throw Error('Consolidation receipt changed');
    const sources: Sources = JSON.parse(batch.source_json);
    if (sources.format !== 'workflow-consolidation-v1' || !Array.isArray(sources.proposals) || !Array.isArray(sources.tasks) || !sources.tasks.length || sources.tasks.length > 64) throw Error('Invalid consolidation sources');
    const groups = consolidatedWorkflows(batch.output_json, sources.proposals.map(p => p.id));
    const first = db.prepare('SELECT MIN(d.rowid) n FROM workflow_consolidations c JOIN workflow_discoveries d ON d.id=c.workflow_id WHERE c.batch_id=?').get(id) as { n: number };
    let location: Proposal['location'] | undefined;
    const aliases = new Map<string, string[]>();
    for (const source of sources.proposals) {
      const row = db.prepare('SELECT rowid n FROM workflow_discoveries WHERE id=?').get(source.id) as { n: number } | undefined;
      if (!row || row.n >= first.n) throw Error('Invalid consolidation lineage');
      const proposal = await read(source.id);
      if (revision(proposal) !== source.revision) throw Error('Consolidation workflow source changed');
      if (location && location.key !== proposal.location.key) throw Error('Consolidation spans different locations');
      location = proposal.location;
      aliases.set(source.id, [source.id, ...(proposal.aliases || [])]);
    }
    const tasks = await readLearningParents(sources.tasks, signal);
    if (tasks.some((task, i) => task.identity !== sources.tasks[i].identity || task.location.key !== location?.key)) throw Error('Consolidation task sources changed');
    signal.throwIfAborted();
    return { batch, sources, groups, tasks, aliases, location: location! };
  }
  const cache = new Map<string, ReturnType<typeof load>>();
  return async (id: string): Promise<Proposal | null> => {
    const row = getDb().prepare('SELECT * FROM workflow_consolidations WHERE workflow_id=?').get(id) as { batch_id: string; group_index: number; task_parents_json: string } | undefined;
    if (!row) return null;
    if (!cache.has(row.batch_id)) cache.set(row.batch_id, load(row.batch_id));
    const { batch, sources, groups, tasks, aliases, location } = await cache.get(row.batch_id)!;
    if (consolidatedWorkflowId(batch, row.group_index, row.task_parents_json) !== id) throw Error('Consolidated workflow receipt changed');
    const group = groups[row.group_index];
    if (!group) throw Error('Consolidation group unavailable');
    const expected = new Map(sources.proposals.filter(p => group.members.includes(p.id)).flatMap(p => p.tasks).map(p => [taskKey(p), p]));
    const parents: EpisodeParent[] = JSON.parse(row.task_parents_json);
    if (!parents.length || new Set(parents.map(taskKey)).size !== parents.length || parents.length !== expected.size || parents.some(p => !expected.has(taskKey(p)))) throw Error('Consolidation task membership changed');
    const evidence = parents.map(parent => {
      const index = sources.tasks.findIndex(p => taskKey(p) === taskKey(parent));
      if (index < 0) throw Error('Consolidation task unavailable');
      return tasks[index].input;
    });
    const independent = parents.every((left, i) => parents.slice(i + 1).every(right => independentTasks(left, right)));
    return { id, model: batch.model, createdAt: batch.created_at, location, decision: null, aliases: [...new Set(group.members.flatMap(member => aliases.get(member)!))],
      task: { workflow: group.workflow, reason: group.reason, request: batch.request, exampleCount: independent ? parents.length : null,
        limitations: [...new Set(evidence.flatMap(input => [...(input.limitations || []), ...input.gaps]))] }, evidence };
  };
}
