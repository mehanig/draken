import { enrich } from './enrich';
import type { Enrichment, Invocation, Outcome, RunEvent, RunnerHost, Task } from './contracts';

/** Serial first-run harness. No implicit resume or automatic retry of uncertain external effects. */
export async function runWorkflow(plan: Enrichment, task: Task, host: RunnerHost, signal: AbortSignal): Promise<{ status: 'completed' | 'failed' | 'cancelled'; detail: string }> {
  const frozen = structuredClone(plan), input = structuredClone(task);
  if (frozen.format !== 'factory-enrichment-v1') throw Error('Unsupported enrichment format');
  const compiled = enrich(frozen.discovery, frozen.policy, frozen.configuration, host.capabilities);
  if (!compiled.ready || JSON.stringify(compiled) !== JSON.stringify(frozen)) throw Error('Enrichment is incomplete or capabilities changed');
  if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id) || input.locationKey !== frozen.policy.locationKey
    || !input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs) || Object.entries(input.inputs).length > 32
    || Object.entries(input.inputs).some(([key, value]) => !key || typeof value !== 'string' || value.length > 1600)) throw Error('Invalid task or repository');
  signal.throwIfAborted();
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; abort(); }, frozen.policy.timeoutMs), current = controller.signal;
  let sequence = 0, claimed = false, recordingFailed = false;
  const emit = async (event: Omit<RunEvent, 'sequence'>) => {
    try { await host.record(structuredClone({ ...event, sequence: ++sequence })); }
    catch (error) { recordingFailed = true; throw error; }
  };
  const authorize = async () => {
    current.throwIfAborted();
    if (JSON.stringify(enrich(frozen.discovery, frozen.policy, frozen.configuration, host.capabilities)) !== JSON.stringify(frozen)) throw Error('Execution capabilities changed');
    await host.authorize(structuredClone(frozen), structuredClone(input), current); current.throwIfAborted();
  };
  async function invoke(id: string, invocation: Omit<Invocation, 'task'>): Promise<Outcome> {
    await authorize();
    const request = { ...invocation, task: input };
    await emit({ type: 'requested', capability: id, invocation: request });
    // Recording may yield: recheck permission at the actual execution boundary.
    await authorize();
    const received = await host.invoke(id, structuredClone(request), current);
    const outcome: Outcome = received && { ok: received.ok, detail: received.detail, evidence: Array.isArray(received.evidence) ? [...received.evidence] : received.evidence };
    current.throwIfAborted();
    if (!outcome || typeof outcome.ok !== 'boolean' || typeof outcome.detail !== 'string' || outcome.detail.length > 2000
      || !Array.isArray(outcome.evidence) || outcome.evidence.length > 32 || outcome.evidence.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)
      || (outcome.ok && !outcome.evidence.length)) throw Error('Capability returned an invalid or unsupported result');
    await authorize();
    await emit({ type: 'result', capability: id, invocation: request, outcome });
    return outcome;
  }
  const requireSuccess = (outcome: Outcome) => { if (!outcome.ok) throw Error(outcome.detail || 'Verification failed'); };
  try {
    await authorize(); await host.claim(structuredClone(input), structuredClone(frozen)); claimed = true;
    await emit({ type: 'started' });
    requireSuccess(await invoke(frozen.configuration.inputCheck!, { phase: 'input', attempt: 1 }));
    requireSuccess(await invoke(frozen.configuration.prepare!, { phase: 'prepare', attempt: 1 }));
    for (const binding of frozen.configuration.bindings) {
      for (let attempt = 1; attempt <= frozen.policy.maxAttempts; attempt++) {
        let outcome = await invoke(binding.action, { phase: 'action', step: binding.step, attempt });
        if (outcome.ok) outcome = await invoke(binding.verify, { phase: 'verify', step: binding.step, attempt, previous: outcome });
        if (outcome.ok) break;
        if (!binding.repair || attempt === frozen.policy.maxAttempts) requireSuccess(outcome);
        requireSuccess(await invoke(binding.repair!, { phase: 'repair', step: binding.step, attempt, previous: outcome }));
      }
    }
    requireSuccess(await invoke(frozen.configuration.completionCheck!, { phase: 'completion', attempt: 1 }));
    await authorize(); await emit({ type: 'completed' });
    return { status: 'completed', detail: 'Configured endpoint verified' };
  } catch (error) {
    // A failed claim must never write into another run's journal.
    if (!claimed || recordingFailed) throw error;
    const status = current.aborted ? 'cancelled' : 'failed';
    const detail = current.aborted ? (timedOut ? 'Execution deadline reached' : 'Run cancelled') : error instanceof Error ? error.message.slice(0, 2000) : 'Execution failed';
    await emit({ type: status, detail });
    return { status, detail };
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
}
