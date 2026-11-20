import { useCallback, useEffect, useRef, useState } from 'react';
import { factoryWorkspaces, runWorkspace, cancelWorkspace, workspaceLog } from '../api';
import { requestId } from '../request-id';
import type { WorkspacePage } from '../../../src/factory/workspace-types';

export function useFactoryWorkspaces() {
  const [data, setData] = useState<WorkspacePage | null>(null), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    try { const state = await factoryWorkspaces(controller.signal); if (!controller.signal.aborted) { setData(state.available ? state : null); setError(''); } }
    catch (cause) { if (!controller.signal.aborted) { setData(null); setError(cause instanceof Error ? cause.message : 'Workspace status is unavailable.'); } }
    finally { if (request.current === controller) request.current = null; }
  }, []);
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, [refresh]);
  const active = data?.runs.some(run => run.status === 'running');
  useEffect(() => { const timer = setInterval(() => { if (!request.current) void refresh(); }, active ? 1500 : 15000); return () => clearInterval(timer); }, [active, refresh]);
  return { data, error, refresh };
}
export function FactoryWorkspace({ state, workflowId, locationKey, purpose }: { state: ReturnType<typeof useFactoryWorkspaces>; workflowId?: string; locationKey?: string; purpose?: string }) {
  const { data, refresh } = state;
  const [error, setError] = useState(''), [ref, setRef] = useState('HEAD'), [task, setTask] = useState(''), [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const pending = useRef<{ id: string; ref: string; task: string } | null>(null);
  useEffect(() => { if (!data) setLogs({}); }, [data]);
  async function start() {
    setBusy(true); setError('');
    if (!pending.current || pending.current.ref !== ref || pending.current.task !== task) pending.current = { id: requestId(), ref, task };
    try { await runWorkspace(ref, pending.current.id, workflowId ? { workflowId, task } : undefined); pending.current = null; await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start workspace.'); } finally { setBusy(false); }
  }
  async function cancel(id: string) {
    setBusy(true); setError(''); try { await cancelWorkspace(id); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not cancel workspace.'); } finally { setBusy(false); }
  }
  async function showLog(id: string) {
    try { const result = await workspaceLog(id); setLogs(previous => ({ ...previous, [id]: result.text })); }
    catch (cause) { setLogs({}); setError(cause instanceof Error ? cause.message : 'Log unavailable.'); }
  }
  if (!data) return !workflowId && state.error ? <p role="alert">{state.error}</p> : null;
  if (workflowId && (!data.agentAvailable || locationKey !== data.locationKey)) return null;
  const blocked = busy || data.runs.some(run => ['running', 'interrupted'].includes(run.status));
  const runs = data.runs.filter(run => run.workflowId === workflowId);
  return <section className="factory-execution" aria-label={workflowId ? 'Agent workflow execution' : 'Repository checks'}>
    {workflowId ? <h3>Run workflow</h3> : <><h2>Repository checks</h2><p className="muted small">{data.repository}</p></>}
    <p>{workflowId ? 'One agent session runs the whole workflow in a separate workspace, using at most 16 model calls. Changes are retained as a patch, not published.' : 'Build and test committed code in a separate workspace. Uncommitted changes are not included.'}</p>
    <form className="factory-run-form" onSubmit={event => { event.preventDefault(); void start(); }}>
      {workflowId && <label className="factory-task">Task<textarea className="input" value={task} onChange={event => setTask(event.target.value)} placeholder={purpose} required maxLength={4000} disabled={blocked} /></label>}
      <label>Commit or branch<input className="input" value={ref} onChange={event => setRef(event.target.value)} required maxLength={200} disabled={blocked} /></label>
      <button className="btn btn-primary" type="submit" disabled={blocked}>Run</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <div aria-live="polite">{runs.map(run => <section key={run.id} className="factory-run">
      <div className="factory-line"><strong>{run.commit ? run.commit.slice(0, 12) : run.ref}</strong><span className={`factory-run-status factory-run-${run.status}`}>{run.status}</span>
        <time className="muted small" dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time>
        {run.status === 'running' && <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void cancel(run.id)}>Cancel run</button>}
      </div>
      {run.task && <p>{run.task}</p>}
      <p>{run.status === 'completed' ? workflowId ? run.detail : 'Repository checks passed.' : run.status === 'running' ? run.stages.find(stage => stage.status === 'running')?.name || 'Preparing workspace…' : run.detail}</p>
      {run.patchBytes > 0 && <p>Changes retained as a patch; not applied to your checkout.</p>}
      <details open={run.status === 'running'}><summary>{run.stages.filter(stage => stage.status === 'passed').length} stages passed</summary>
        <ol className="factory-run-steps">{run.stages.map((stage, i) => <li key={i}><span>{stage.name}</span><span>{stage.status}</span></li>)}</ol>
        <p className="muted small">{run.modelCalls === null ? 'Model accounting pending' : `${run.modelCalls} model calls`}{run.sessionId ? ` · Session ${run.sessionId}` : ''}</p>
      </details>
      <button className="btn btn-secondary" type="button" onClick={() => void showLog(run.id)}>View log</button>
      {logs[run.id] && <pre className="factory-workspace-log">{logs[run.id]}</pre>}
    </section>)}</div>
  </section>;
}
