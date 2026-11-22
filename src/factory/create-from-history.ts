import { getDb } from '../db/schema';
import { readTaskEvidence, type EvidenceResult } from '../evidence';
import { evidenceDependencies, evidenceQuestions, evidenceDiscussion } from '../evidence-adapter';
import { cleanText, digest } from '../sync/normalize';
import { assertConversationActive } from '../sync/conversation';
import { TASK_WORKFLOW_PROMPT, taskWorkflow, CANDIDATE_PROMPT, candidateSelection, CONTRACT_MATCH_PROMPT, validateContractAssessment, decideContractMatch, type ContractMatchInput } from '../workflow-learning';
import { discoveryFromProposal, readDiscovery, readProposal } from './discovery';
import { prepareEnrichment, savedEnrichment } from './enrichment';
import { workflowLocation } from './location';
import { taskDiscoveryId, readTaskProposal } from './task-store';
import type { Discovery } from '../factory-enrichment';
import type { FactoryPage } from './types';

type Selection = NonNullable<Extract<EvidenceResult, { kind: 'ready' }>['workflowCreation']>;
export interface WorkflowCreationResult { kind: 'ready' | 'reused' | 'saved' | 'clarify' | 'insufficient' | 'failed'; message: string; id?: string; url?: string }
function comparison(proposal: FactoryPage['proposals'][number]): ContractMatchInput {
  const workflow = discoveryFromProposal(proposal);
  return { goal: workflow.purpose, context: workflow.appliesWhen, complete: proposal.evidence.every(e => e.complete),
    gaps: proposal.evidence.flatMap(e => e.gaps), limitations: workflow.limitations,
    stages: workflow.method.map((action, i) => ({ id: `W${i + 1}`, action })),
    facts: proposal.evidence.flatMap((e, i) => e.facts.map(f => ({ ...f, id: `${i}:${f.id}`, stage: null }))), secondary: proposal.evidence.flatMap(e => e.secondary) };
}
/** One operation for actual text/voice turns. No provider, scheduler, execution or new allowance. */
export async function createWorkflowFromHistory(input: {
  syncId: number; turn: { kind: 'text' | 'voice'; id: number }; runId: number; model: string;
  selection: Selection; signal: AbortSignal; checkCurrent: () => void;
  ask: (payload: unknown, prompt: string) => Promise<string>;
}): Promise<WorkflowCreationResult> {
  const { syncId, turn, runId, signal } = input, db = getDb();
  const check = () => { signal.throwIfAborted(); input.checkCurrent(); assertConversationActive(syncId); };
  check();
  const user = (turn.kind === 'text'
    ? db.prepare("SELECT content question FROM sync_messages WHERE id=? AND sync_id=? AND role='user'").get(turn.id, syncId)
    : db.prepare("SELECT m.text question FROM live_messages m JOIN live_calls c ON c.id=m.call_id WHERE m.id=? AND c.sync_id=? AND m.role='user' AND m.status='generated'").get(turn.id, syncId)) as { question: string } | undefined;
  const owner = db.prepare('SELECT sync_id,question FROM sync_runs WHERE id=?').get(runId) as { sync_id: number; question: string } | undefined;
  if (!user || !owner || owner.sync_id !== syncId || owner.question !== user.question) throw Error('Workflow creation requires the actual user turn and its accounting owner');
  const turnKey = `${turn.kind}:${turn.id}`, requestId = digest(JSON.stringify([syncId, turnKey]));
  const previous = db.prepare('SELECT * FROM workflow_requests WHERE request_id=?').get(requestId) as { result_json: string | null; workflow_id: string | null; status: string } | undefined;
  if (previous) {
    if (previous.workflow_id) await readDiscovery(previous.workflow_id, signal);
    check();
    if (previous.result_json) {
      const result: WorkflowCreationResult = JSON.parse(previous.result_json);
      if (result.id && !savedEnrichment(await readDiscovery(result.id, signal)).value) return { ...result, kind: 'saved', message: 'The workflow is saved in Factory, but its enrichment is not ready. Prepare it there.' };
      return result;
    }
    return { kind: 'failed', message: previous.status === 'running' ? 'Workflow creation is already in progress.' : 'This creation attempt did not complete. Its usage and any saved workflow are retained.' };
  }
  const request = { question: cleanText(user.question, 4000), turn: turnKey, syncId,
    discussion: evidenceDiscussion(syncId, turn.kind === 'text' ? turn.id : -1, turn.kind === 'voice' ? turn.id : -1),
    previousQuestions: evidenceQuestions(syncId, turn.kind === 'text' ? turn.id : -1, turn.kind === 'voice' ? turn.id : -1) };
  const requestJson = JSON.stringify(request);
  db.prepare("INSERT INTO workflow_requests(request_id,sync_id,turn_key,request_json,run_id,status,created_at) VALUES (?,?,?,?,?,'running',?)")
    .run(requestId, syncId, turnKey, requestJson, runId, new Date().toISOString());
  let savedId: string | undefined;
  const finish = (result: WorkflowCreationResult) => {
    check(); db.prepare("UPDATE workflow_requests SET status='completed',result_json=? WHERE request_id=?").run(JSON.stringify(result), requestId); return result;
  };
  try {
    const packet = await readTaskEvidence({ ...input.selection, signal }, evidenceDependencies);
    const fingerprint = digest(packet.receipt);
    const candidates: { proposal: FactoryPage['proposals'][number]; discovery: Discovery }[] = [];
    const verify = async () => {
      check();
      if (digest((await readTaskEvidence({ ...input.selection, signal }, evidenceDependencies)).receipt) !== fingerprint) throw Error('Task originals changed during workflow creation');
      for (const candidate of candidates) if (JSON.stringify(await readDiscovery(candidate.discovery.id, signal)) !== JSON.stringify(candidate.discovery)) throw Error('A workflow used for comparison changed or lost source access');
      check();
    };
    const ask = async (payload: { task: string; [key: string]: unknown }, prompt: string) => {
      await verify();
      db.prepare('UPDATE sync_runs SET stage=? WHERE id=?').run(payload.task === 'enrich_workflow' ? 'Enriching workflow' : 'Creating workflow', runId);
      const raw = await input.ask(payload, prompt);
      db.prepare("UPDATE workflow_requests SET raw_output=json_insert(COALESCE(raw_output,'[]'),'$[#]',json(?)) WHERE request_id=?")
        .run(JSON.stringify({ task: payload.task, raw }), requestId);
      await verify(); return raw;
    };
    if (!packet.records.length) return finish({ kind: 'insufficient', message: 'I could not reconstruct that task from the permitted prepared history. Which task or source should I use?' });
    const raw = await ask({ task: 'create_workflow_from_history', current_request: request, limitations: packet.limitations,
      records: packet.records.map((r, i) => ({ ...r, ref: `S${i + 1}` })) }, TASK_WORKFLOW_PROMPT);
    const task = taskWorkflow(raw, packet.records);
    if ('kind' in task) return finish(task);
    const source = packet.records.find(r => r.ref === task.repositoryRef)!, location = workflowLocation(source.workspace);
    if (!source.sessionId || location.kind === 'unavailable') return finish({ kind: 'clarify', message: 'Which available repository should this workflow belong to? The selected source does not identify one.' });
    const sourceJson = JSON.stringify({ ...input.selection, fingerprint, location });
    const row = { model: input.model, source_json: sourceJson, output_json: raw, request_json: requestJson };
    const id = taskDiscoveryId(row), createdAt = new Date().toISOString();
    const proposal = await readTaskProposal({ ...row, id, origin: 'requested', created_at: createdAt }, signal);
    const existing = db.prepare('SELECT id FROM workflow_discoveries ORDER BY rowid DESC').all() as { id: string }[];
    for (const entry of existing) {
      if (candidates.length === 24) break;
      try {
        const other = await readProposal(entry.id, signal), discovery = discoveryFromProposal(other);
        if (other.location.key === location.key) candidates.push({ proposal: other, discovery });
      } catch { check(); }
    }
    let reused = false;
    if (candidates.length) {
      const ids = candidates.map((_, i) => `C${i + 1}`);
      const selected = candidateSelection(await ask({ task: 'select_workflow_candidates', current: { goal: task.workflow.purpose, context: task.workflow.appliesWhen },
        candidates: candidates.map((c, i) => ({ id: ids[i], goal: c.discovery.purpose, context: c.discovery.appliesWhen })) }, CANDIDATE_PROMPT), ids);
      for (const selectedId of selected) {
        const candidate = candidates[ids.indexOf(selectedId)], pair = [comparison(proposal), comparison(candidate.proposal)];
        const result = await ask({ task: 'compare_workflow_identity', left: pair[0], right: pair[1] }, CONTRACT_MATCH_PROMPT);
        const value = JSON.parse(result), decision = decideContractMatch(validateContractAssessment(JSON.stringify(value.assessment ?? value), pair), pair);
        if (decision.sameWorkflow) { savedId = candidate.discovery.id; reused = true; break; }
      }
    }
    await verify();
    if (JSON.stringify(workflowLocation(source.workspace)) !== JSON.stringify(location)) throw Error('Task repository changed during creation');
    db.transaction(() => {
      check();
      if (!savedId) {
        db.prepare("INSERT INTO workflow_discoveries(id,origin,model,created_at,source_json,output_json,request_json) VALUES (?,'requested',?,?,?,?,?)")
          .run(id, input.model, createdAt, sourceJson, raw, requestJson);
        savedId = id;
      }
      db.prepare('UPDATE workflow_requests SET workflow_id=? WHERE request_id=?').run(savedId, requestId);
    })();
    const url = `/factory#workflow-${savedId}`;
    try {
      await prepareEnrichment(savedId!, { table: 'sync_runs', id: runId }, input.model,
        (payload, prompt) => ask(payload as { task: string }, prompt), signal);
    } catch (error) {
      check();
      await readDiscovery(savedId!, signal);
      return finish({ kind: 'saved', id: savedId, url, message: 'The workflow is saved in Factory, but enrichment did not complete. Use its preparation/retry button there; the discovery and attempt are retained.' });
    }
    await verify();
    const current = await readDiscovery(savedId!, signal);
    return finish({ kind: reused ? 'reused' : 'ready', id: savedId, url,
      message: `${reused ? 'Reused' : 'Saved'} “${current.purpose}” in Factory${reused ? '' : ', derived from that task'}. Its inputs and checks are prepared. It has not been run.` });
  } catch (error) {
    db.prepare('UPDATE workflow_requests SET status=?,error=? WHERE request_id=?').run(signal.aborted ? 'cancelled' : 'failed', cleanText(error instanceof Error ? error.message : 'Workflow creation failed', 1500), requestId);
    throw error;
  }
}
