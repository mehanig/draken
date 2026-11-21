import { digest } from '../sync/normalize';
import { readWorkflowComparison, type LearningRow } from './learning-store';
import { getDb } from '../db/schema';
import type { Discovery } from '../factory-enrichment';
import type { FactoryPage } from './types';

/** Call only with freshly verified Factory output. No new search or extraction path. */
export function discoveryFromProposal(proposal: FactoryPage['proposals'][number]): Discovery {
  const workflow = proposal.decision.assessment.workflow;
  if (!proposal.decision.sameWorkflow || !workflow || proposal.location.kind === 'unavailable') throw Error('Verified workflow proposal required');
  return { id: proposal.id, revision: digest(JSON.stringify(proposal)), locationKey: proposal.location.key,
    purpose: workflow.purpose, appliesWhen: workflow.appliesWhen, method: [...workflow.method],
    limitations: [...new Set([...proposal.decision.assessment.limitations, ...proposal.evidence.flatMap(input => [...(input.limitations || []), ...input.gaps])])] };
}
export async function readDiscovery(id: string, signal: AbortSignal): Promise<Discovery> {
  const row = getDb().prepare("SELECT * FROM process_extractions WHERE id=? AND kind='comparison' AND status='completed'").get(id) as LearningRow | undefined;
  if (!row) throw Error('Workflow proposal unavailable');
  const { decision, evidence, location } = await readWorkflowComparison(row, signal);
  return discoveryFromProposal({ id: row.id, model: row.model, createdAt: row.created_at, decision, evidence, location });
}
