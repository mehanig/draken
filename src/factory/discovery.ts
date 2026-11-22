import { digest } from '../sync/normalize';
import { readWorkflowComparison, type LearningRow } from './learning-store';
import { getDb } from '../db/schema';
import type { Discovery } from '../factory-enrichment';
import type { FactoryPage } from './types';
import { readTaskProposal, type DiscoveryRow } from './task-store';
import { consolidationReader } from './consolidation';

/** Call only with freshly verified Factory output. No new search or extraction path. */
export function discoveryFromProposal(proposal: FactoryPage['proposals'][number]): Discovery {
  const workflow = proposal.task?.workflow || proposal.decision?.assessment.workflow;
  if ((!proposal.task && !proposal.decision?.sameWorkflow) || !workflow || proposal.location.kind === 'unavailable') throw Error('Verified workflow proposal required');
  const { id, model, createdAt, decision, evidence, location } = proposal;
  return { id: proposal.id, revision: digest(JSON.stringify({ id, model, createdAt, decision, evidence, location, ...(proposal.task ? { task: proposal.task } : {}) })), locationKey: proposal.location.key,
    purpose: workflow.purpose, appliesWhen: workflow.appliesWhen, method: [...workflow.method],
    limitations: [...new Set([...(proposal.task?.limitations || proposal.decision!.assessment.limitations), ...proposal.evidence.flatMap(input => [...(input.limitations || []), ...input.gaps])])] };
}
export async function readDiscovery(id: string, signal: AbortSignal): Promise<Discovery> {
  return discoveryFromProposal(await readProposal(id, signal));
}
export function proposalReader(signal: AbortSignal) {
  const consolidated = consolidationReader(signal, read, proposal => discoveryFromProposal(proposal).revision);
  async function read(id: string): Promise<FactoryPage['proposals'][number]> {
    return await consolidated(id) || readOriginalProposal(id, signal);
  }
  return read;
}
export async function readProposal(id: string, signal: AbortSignal): Promise<FactoryPage['proposals'][number]> {
  return proposalReader(signal)(id);
}
async function readOriginalProposal(id: string, signal: AbortSignal): Promise<FactoryPage['proposals'][number]> {
  const saved = getDb().prepare('SELECT * FROM workflow_discoveries WHERE id=?').get(id) as DiscoveryRow | undefined;
  if (saved?.origin === 'requested') return readTaskProposal(saved, signal);
  const row = getDb().prepare("SELECT * FROM process_extractions WHERE id=? AND kind='comparison' AND status='completed'").get(id) as LearningRow | undefined;
  if (!row) throw Error('Workflow proposal unavailable');
  const { decision, evidence, location } = await readWorkflowComparison(row, signal);
  return { id: row.id, model: row.model, createdAt: row.created_at, decision, evidence, location };
}
