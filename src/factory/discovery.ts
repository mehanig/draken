import { digest } from '../sync/normalize';
import { readWorkflowComparison, type LearningRow } from './learning-store';
import { getDb } from '../db/schema';
import type { Discovery } from '../factory-enrichment';
import type { FactoryPage } from './types';
import { taskProposal, assertTaskSourceAccess, type DiscoveryRow } from './task-store';
import { consolidationReader } from './consolidation';
import { taskWorkflow } from '../workflow-learning';
import { assertLearningParents, type LearningParent } from './episode-store';

/** Derive execution identity from the saved definition and its recorded evidence. */
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
    signal.throwIfAborted();
    const saved = getDb().prepare('SELECT display_json FROM workflow_discoveries WHERE id=?').get(id) as { display_json: string | null } | undefined;
    if (saved?.display_json) {
      await assertSavedAccess(id, signal);
      return JSON.parse(saved.display_json);
    }
    return await consolidated(id) || readOriginalProposal(id, signal);
  }
  return read;
}
export async function readProposal(id: string, signal: AbortSignal): Promise<FactoryPage['proposals'][number]> {
  return proposalReader(signal)(id);
}
/** Walk only stored dependency metadata to check access, not to rebuild or verify content. */
async function assertSavedAccess(id: string, signal: AbortSignal): Promise<void> {
  const db = getDb(), seen = new Set<string>(), parents: LearningParent[] = [];
  async function workflow(id: string): Promise<void> {
    signal.throwIfAborted();
    if (seen.has(id)) return; seen.add(id);
    const batch = db.prepare('SELECT b.source_json FROM workflow_consolidations c JOIN workflow_consolidation_batches b ON b.id=c.batch_id WHERE c.workflow_id=?').get(id) as { source_json: string } | undefined;
    if (batch) {
      const sources = JSON.parse(batch.source_json);
      parents.push(...sources.tasks);
      for (const source of sources.proposals) await workflow(source.id);
      return;
    }
    const row = db.prepare('SELECT id,origin,source_json,source_refs_json FROM workflow_discoveries WHERE id=?').get(id) as DiscoveryRow | undefined;
    if (!row) throw Error('Workflow proposal unavailable');
    if (row.origin === 'requested') {
      await assertTaskSourceAccess(row, signal);
    } else {
      const comparison = db.prepare('SELECT source_dependencies_json FROM process_extractions WHERE id=?').get(id) as { source_dependencies_json: string };
      if (!comparison) throw Error('Workflow comparison unavailable');
      parents.push(...JSON.parse(comparison.source_dependencies_json).parents);
    }
  }
  await workflow(id);
  assertLearningParents(parents, signal);
}
async function readOriginalProposal(id: string, signal: AbortSignal): Promise<FactoryPage['proposals'][number]> {
  const saved = getDb().prepare('SELECT * FROM workflow_discoveries WHERE id=?').get(id) as DiscoveryRow | undefined;
  if (!saved) throw Error('Workflow proposal unavailable');
  if (saved.origin === 'requested') {
    const packet = await assertTaskSourceAccess(saved, signal);
    // First-time legacy display construction translates the model's S references.
    const task = taskWorkflow(saved.output_json, packet.records);
    if ('kind' in task) throw Error('Task discovery is incomplete');
    return taskProposal(saved, task, packet);
  }
  const row = getDb().prepare("SELECT * FROM process_extractions WHERE id=? AND kind='comparison' AND status='completed'").get(id) as LearningRow | undefined;
  if (!row) throw Error('Workflow proposal unavailable');
  const { decision, evidence, location } = await readWorkflowComparison(row, signal);
  return { id: row.id, model: row.model, createdAt: row.created_at, decision, evidence, location };
}
