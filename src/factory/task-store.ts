import { readTaskEvidence } from '../evidence';
import { evidenceDependencies } from '../evidence-adapter';
import { digest } from '../sync/normalize';
import { taskWorkflow, contractMatchInput } from '../workflow-learning';
import { workflowLocation } from './location';
import type { FactoryPage } from './types';

export interface DiscoveryRow { id: string; origin: 'recurring' | 'requested'; model: string; created_at: string; source_json: string; output_json: string; request_json: string }
export function taskDiscoveryId(row: Pick<DiscoveryRow, 'model' | 'source_json' | 'output_json' | 'request_json'>) {
  return digest(JSON.stringify([row.model, row.source_json, row.output_json, row.request_json]));
}
export async function readTaskProposal(row: DiscoveryRow, signal: AbortSignal): Promise<FactoryPage['proposals'][number]> {
  if (taskDiscoveryId(row) !== row.id) throw Error('Task discovery receipt changed');
  const sources = JSON.parse(row.source_json);
  const packet = await readTaskEvidence({ before: sources.before, selections: sources.selections, signal }, evidenceDependencies);
  if (digest(packet.receipt) !== sources.fingerprint) throw Error('Task discovery originals changed');
  const task = taskWorkflow(row.output_json, packet.records);
  if ('kind' in task) throw Error('Task discovery is incomplete');
  const record = packet.records.find(r => r.ref === task.repositoryRef)!;
  const location = workflowLocation(record.workspace);
  if (location.kind === 'unavailable' || JSON.stringify(location) !== JSON.stringify(sources.location)) throw Error('Task repository changed or is unavailable');
  signal.throwIfAborted();
  const request = JSON.parse(row.request_json);
  return { id: row.id, model: row.model, createdAt: row.created_at, location, decision: null,
    task: { workflow: task.workflow, limitations: task.process.limitations, reason: task.message, request: request.question },
    evidence: [{ ...contractMatchInput(task.process.fragments.find(f => f.key === task.fragment)!), limitations: [...packet.limitations, ...task.process.limitations] }] };
}
