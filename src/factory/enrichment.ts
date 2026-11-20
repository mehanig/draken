import { digest } from '../sync/normalize';
import { readWorkflowComparison, type LearningRow } from './learning-store';
import { getDb } from '../db/schema';
import { modelCall } from '../sync/model-call';
import type { SyncModels } from '../types';
import { proposeEnrichment, type Capability, type Discovery, type Policy } from '../factory-enrichment';
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

/** Real provider path for a caller that already owns an accounted preparation run. */
export function enrichFactoryWithModel(id: string, policy: Policy, catalog: Capability[],
  owner: { runId: number; table: 'sync_runs' | 'background_runs'; models: SyncModels }, signal: AbortSignal) {
  return proposeFactoryEnrichment(id, policy, catalog, (payload, system) => {
    if (!['sync_runs', 'background_runs'].includes(owner.table)) throw Error('Invalid enrichment owner');
    const run = getDb().prepare(`SELECT status,summary_model,final_model,max_invocations FROM ${owner.table} WHERE id=?`).get(owner.runId) as
      { status: string; summary_model: string; final_model: string; max_invocations: number } | undefined;
    if (!run || run.status !== 'running') throw Error('Enrichment owner is not running');
    if (run.summary_model !== owner.models.summary || run.final_model !== owner.models.final) throw Error('Enrichment owner models changed');
    const models = { ...owner.models, max_invocations: Math.min(owner.models.max_invocations, run.max_invocations) };
    return modelCall(payload, system, { ...owner, models, signal, reserveAnswer: owner.table === 'sync_runs' });
  }, signal);
}

/** Explicit host integration for future preparation callers. Reads never invoke this function.
 * The supplied callback must use its owner's existing invocation accounting and consent. */
export async function proposeFactoryEnrichment(id: string, policy: Policy, catalog: Capability[],
  ask: (payload: unknown, system: string, signal: AbortSignal) => Promise<string>, signal: AbortSignal) {
  const discovery = await readDiscovery(id, signal);
  return proposeEnrichment(discovery, policy, catalog, { ask, assertCurrent: async current => {
    if ((await readDiscovery(id, current)).revision !== discovery.revision) throw Error('Workflow discovery changed during enrichment');
  } }, signal);
}
