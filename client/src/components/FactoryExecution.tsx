import { useCallback, useEffect, useRef, useState } from 'react';
import { requestId } from '../request-id';
import { cancelFactoryRun, factoryExecution, runFactory } from '../api';
import type { FactoryExecution } from '../../../src/factory/execution-types';

const labels: Record<string, string> = {
  input: 'Check request', prepare: 'Prepare container', registry: 'Read npm release', 'check-registry': 'Verify npm metadata',
  install: 'Install package', 'check-install': 'Verify package contents', audit: 'Audit dependencies', 'check-audit': 'Verify audit',
  release: 'Check release and website', 'check-release': 'Verify deployment', complete: 'Final verification',
};
const label = (id: string) => labels[id] || id;

export function useFactoryExecution() {
  const [execution, setExecution] = useState<FactoryExecution | null>(null);
  const [executionError, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const refreshExecution = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    try {
      const value = await factoryExecution(controller.signal);
      if (!controller.signal.aborted) { setExecution(typeof value.available === 'boolean' ? value : null); setError(''); }
    } catch (error) {
      if (!controller.signal.aborted) { setExecution(null); setError(error instanceof Error ? error.message : 'Could not read executions.'); }
    }
  }, []);
  useEffect(() => { void refreshExecution(); return () => request.current?.abort(); }, [refreshExecution]);
  const running = execution?.runs.some(run => run.status === 'running');
  useEffect(() => { const timer = setInterval(() => void refreshExecution(), running ? 1500 : 15000); return () => clearInterval(timer); }, [running, refreshExecution]);
  return { execution, executionError, refreshExecution };
}

export function FactoryExecutionPanel({ data, refresh }: { data: FactoryExecution; refresh(): Promise<void> }) {
  const [version, setVersion] = useState(''), [regenerate, setRegenerate] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<{ id: string; version: string; regenerate: boolean } | null>(null);
  const blocked = data.runs.some(run => run.status === 'running' || run.status === 'interrupted');
  async function start() {
    const generate = regenerate || !data.hasPlan;
    setBusy(true); setError('');
    // Keep the same ID after an uncertain HTTP response; do not accidentally start a second paid job.
    if (!pending.current || pending.current.version !== version || pending.current.regenerate !== generate)
      pending.current = { id: requestId(), version, regenerate: generate };
    try { await runFactory(version, generate, pending.current.id); pending.current = null; await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start the run.'); }
    finally { setBusy(false); }
  }
  async function cancel(id: string) {
    setBusy(true); setError('');
    try { await cancelFactoryRun(id); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not cancel the run.'); }
    finally { setBusy(false); }
  }
  return <section className="factory-execution" aria-label="Workflow execution">
    <h3>Run workflow</h3>
    <p className="muted small">Release verification only. Does not publish or deploy.</p>
    {!data.available ? <p role="status">{data.reason}</p> : <>
      {data.bindings.length > 0 && <details><summary>Generated plan</summary><ol>{data.bindings.map(binding =>
        <li key={binding.step}>{label(binding.action)} → {label(binding.verify)}</li>)}</ol></details>}
      <form onSubmit={event => { event.preventDefault(); void start(); }} className="factory-run-form">
        <label>Release version<input className="input" value={version} onChange={event => setVersion(event.target.value)} placeholder="0.10.0" required pattern="[0-9]+\.[0-9]+\.[0-9]+" maxLength={40} disabled={busy || blocked} /></label>
        {data.hasPlan && <label className="factory-plan-choice"><input type="checkbox" checked={regenerate} onChange={event => setRegenerate(event.target.checked)} disabled={busy || blocked} />Generate a new plan (1 model call)</label>}
        {!data.hasPlan && <p className="small">Generates a plan with one model call, then runs it in Docker.</p>}
        <button className="btn btn-primary" type="submit" disabled={busy || blocked}>{busy ? 'Starting…' : regenerate || !data.hasPlan ? 'Generate & run' : 'Run'}</button>
      </form>
    </>}
    {error && <p role="alert">{error}</p>}
    <div aria-live="polite">{data.runs.map(run => <section className="factory-run" key={run.id} aria-label={`Release ${run.version} run`}>
      <div className="factory-line"><strong>v{run.version}</strong><span className={`factory-run-status factory-run-${run.status}`}>{run.status}</span>
        <time className="muted small" dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time>
        {run.status === 'running' && <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void cancel(run.id)}>Cancel run</button>}
      </div>
      <p>{run.status === 'running' ? label(run.phase) : run.status === 'completed' ? 'Release checks passed.' : run.detail}</p>
      <p className="muted small">{run.reused ? 'Saved LLM plan · no new model call' : run.modelCalls === null ? 'Model accounting pending' : `${run.modelCalls} model call${run.modelCalls === 1 ? '' : 's'}`}</p>
      {run.steps.length > 0 && <details open={run.status === 'running'}><summary>{run.steps.filter(step => step.status === 'passed').length} stages passed</summary>
        <ol className="factory-run-steps">{run.steps.map((step, index) => <li key={index}><span>{label(step.capability)}</span><span>{step.status}</span></li>)}</ol></details>}
    </section>)}</div>
  </section>;
}
