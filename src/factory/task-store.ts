import { readTaskEvidence } from '../evidence';
import { evidenceDependencies } from '../evidence-adapter';
import { getDb } from '../db/schema';
import { digest } from '../sync/normalize';
import { contractMatchInput, type TaskWorkflow } from '../workflow-learning';
import { workflowLocation } from './location';
import type { FactoryPage } from './types';

export interface DiscoveryRow { id: string; origin: 'recurring' | 'requested'; model: string; created_at: string; source_json: string; output_json: string; request_json: string; source_refs_json?: string | null }
export function taskDiscoveryId(row: Pick<DiscoveryRow, 'model' | 'source_json' | 'output_json' | 'request_json'>) {
  return digest(JSON.stringify([row.model, row.source_json, row.output_json, row.request_json]));
}
export async function assertTaskSourceAccess(row: DiscoveryRow, signal: AbortSignal) {
  const source = JSON.parse(row.source_json);
  const packet = await readTaskEvidence({ ...source, requiredRefs: row.source_refs_json ? JSON.parse(row.source_refs_json) : undefined, signal }, evidenceDependencies);
  if (!row.source_refs_json) {
    // Migrate old permission scopes once without changing their original receipts.
    if (digest(packet.receipt) !== source.fingerprint) throw Error('Legacy task source scope changed before migration');
    getDb().prepare('UPDATE workflow_discoveries SET source_refs_json=? WHERE id=? AND source_refs_json IS NULL').run(JSON.stringify(packet.references), row.id);
  }
  return packet;
}
export function taskProposal(row: DiscoveryRow, task: TaskWorkflow, packet: Awaited<ReturnType<typeof readTaskEvidence>>): FactoryPage['proposals'][number] {
  const sources = JSON.parse(row.source_json);
  const record = packet.records.find(r => r.ref === task.repositoryRef)!;
  const location = workflowLocation(record.workspace);
  if (location.kind === 'unavailable' || JSON.stringify(location) !== JSON.stringify(sources.location)) throw Error('Task repository changed or is unavailable');
  const request = JSON.parse(row.request_json);
  return { id: row.id, model: row.model, createdAt: row.created_at, location, decision: null,
    task: { workflow: task.workflow, limitations: task.process.limitations, reason: task.message, request: request.question },
    evidence: [{ ...contractMatchInput(task.process.fragments.find(f => f.key === task.fragment)!), limitations: [...packet.limitations, ...task.process.limitations] }] };
}
