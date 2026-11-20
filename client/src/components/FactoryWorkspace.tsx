import { useCallback, useEffect, useRef, useState } from 'react';
import { factoryWorkspaces, runWorkspace, cancelWorkspace, workspaceLog } from '../api';
import { requestId } from '../request-id';
import type { WorkspacePage } from '../../../src/factory/workspace-types';

export function FactoryWorkspace() {
  const [data, setData] = useState<WorkspacePage | null>(null), [error, setError] = useState('');
  const [ref, setRef] = useState('HEAD'), [propose, setPropose] = useState(false), [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const pending = useRef<{ id: string; ref: string; propose: boolean } | null>(null), request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    try { const state = await factoryWorkspaces(controller.signal); if (!controller.signal.aborted) { setData(state.available ? state : null); if (!state.available) setLogs({}); } }
    catch (cause) { if (!controller.signal.aborted) { setData(null); setLogs({}); setError(cause instanceof Error ? cause.message : 'Workspace status is unavailable.'); } }
  }, []);
  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);
  const active = data?.runs.some(run => run.status === 'running');
  useEffect(() => { const timer = setInterval(() => void load(), active ? 1500 : 15000); return () => clearInterval(timer); }, [active, load]);
  async function start() {
    setBusy(true); setError('');
    if (!pending.current || pending.current.ref !== ref || pending.current.propose !== propose) pending.current = { id: requestId(), ref, propose };
    try { await runWorkspace(ref, propose, pending.current.id); pending.current = null; await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start workspace.'); } finally { setBusy(false); }
  }
  async function cancel(id: string) {
    setBusy(true); setError(''); try { await cancelWorkspace(id); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not cancel workspace.'); } finally { setBusy(false); }
  }
  async function showLog(id: string) {
    try { const result = await workspaceLog(id); setLogs(previous => ({ ...previous, [id]: result.text })); }
    catch (cause) { setLogs({}); setError(cause instanceof Error ? cause.message : 'Log unavailable.'); }
  }
  if (!data) return error ? <p role="alert">{error}</p> : null;
  const blocked = busy || data.runs.some(run => ['running', 'interrupted'].includes(run.status));
  return <section className="factory-execution" aria-label="Repository checks">
    <h2>Repository checks</h2><p className="muted small">{data.repository}</p>
    <p>Build and test committed code in a separate workspace. Uncommitted changes are not included.</p>
    <form className="factory-run-form" onSubmit={event => { event.preventDefault(); void start(); }}>
      <label>Commit or branch<input className="input" value={ref} onChange={event => setRef(event.target.value)} required maxLength={200} disabled={blocked} /></label>
      <label className="factory-plan-choice"><input type="checkbox" checked={propose} onChange={event => setPropose(event.target.checked)} disabled={blocked} />Propose an environment if missing (1 model call)</label>
      <button className="btn btn-primary" type="submit" disabled={blocked}>Run</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <div aria-live="polite">{data.runs.map(run => <section key={run.id} className="factory-run">
      <div className="factory-line"><strong>{run.commit ? run.commit.slice(0, 12) : run.ref}</strong><span className={`factory-run-status factory-run-${run.status}`}>{run.status}</span>
        <time className="muted small" dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time>
        {run.status === 'running' && <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void cancel(run.id)}>Cancel run</button>}
      </div>
      <p>{run.status === 'completed' ? 'Repository checks passed.' : run.status === 'running' ? run.stages.find(stage => stage.status === 'running')?.name || 'Preparing workspace…' : run.detail}</p>
      {run.patchBytes > 0 && <p>Changes retained as a patch; not applied to your checkout.</p>}
      <details open={run.status === 'running'}><summary>{run.stages.filter(stage => stage.status === 'passed').length} stages passed</summary>
        <ol className="factory-run-steps">{run.stages.map((stage, i) => <li key={i}><span>{stage.name}</span><span>{stage.status}</span></li>)}</ol>
        <p className="muted small">{run.modelCalls === null ? 'Model accounting pending' : `${run.modelCalls} model calls`}</p>
      </details>
      <button className="btn btn-secondary" type="button" onClick={() => void showLog(run.id)}>View log</button>
      {logs[run.id] && <pre className="factory-workspace-log">{logs[run.id]}</pre>}
    </section>)}</div>
  </section>;
}
