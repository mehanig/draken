import { useCallback, useEffect, useRef, useState } from 'react';
import { factoryWorkspaces, runWorkspace, cancelWorkspace, workspaceLog, saveFactoryExecutionSettings } from '../api';
import { requestId } from '../request-id';
import type { Guidance } from '../../../src/factory-enrichment';
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
export function FactoryExecutionSettings({ state }: { state: ReturnType<typeof useFactoryWorkspaces> }) {
  const [limit, setLimit] = useState(16), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  useEffect(() => { if (state.data) setLimit(state.data.maxCalls); }, [state.data?.maxCalls]);
  if (!state.data?.agentAvailable) return null;
  return <details><summary>Execution settings</summary><form className="factory-run-form" onSubmit={async event => {
    event.preventDefault(); setSaving(true); setError('');
    try { await saveFactoryExecutionSettings(limit); await state.refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save execution settings.'); } finally { setSaving(false); }
  }}><label>Model call limit per run<input className="input" type="number" min={1} max={64} required value={limit} onChange={event => setLimit(Number(event.target.value))} /></label><button type="submit" disabled={saving}>Save</button></form>
    <p className="muted small">Applies to new runs, including publication or deployment steps in the selected workflow.</p>{error && <p role="alert">{error}</p>}
  </details>;
}
export function FactoryWorkspace({ state, workflowId, aliases = [], locationKey, inputs }: { state: ReturnType<typeof useFactoryWorkspaces>; workflowId: string; aliases?: string[]; locationKey: string; inputs: Guidance['inputs'] }) {
  const { data, refresh } = state;
  const [error, setError] = useState(''), [ref, setRef] = useState('HEAD'), [values, setValues] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const pending = useRef<{ id: string; ref: string; inputs: string; maxCalls: number } | null>(null);
  useEffect(() => { if (!data) setLogs({}); }, [data]);
  async function start() {
    setBusy(true); setError('');
    const encoded = JSON.stringify(values);
    if (!pending.current || pending.current.ref !== ref || pending.current.inputs !== encoded || pending.current.maxCalls !== data!.maxCalls) pending.current = { id: requestId(), ref, inputs: encoded, maxCalls: data!.maxCalls };
    try { await runWorkspace(ref, pending.current.id, { workflowId, inputs: values }); pending.current = null; await refresh(); }
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
  if (!data?.agentAvailable || locationKey !== data.locationKey) return null;
  const blocked = busy || data.runs.some(run => ['running', 'interrupted'].includes(run.status));
  const runs = data.runs.filter(run => run.workflowId === workflowId || !!run.workflowId && aliases.includes(run.workflowId));
  return <section className="factory-execution" aria-label="Agent workflow execution">
    <form className="factory-run-form" onSubmit={event => { event.preventDefault(); void start(); }}>
      {inputs.map(input => <label key={input.name}>{input.label}<input className="input" value={values[input.name] || ''} onChange={event => setValues(previous => ({ ...previous, [input.name]: event.target.value }))} title={input.description} required={input.required} maxLength={2000} disabled={blocked} /></label>)}
      <label>Commit or branch<input className="input" value={ref} onChange={event => setRef(event.target.value)} required maxLength={200} disabled={blocked} /></label>
      <button className="btn btn-primary" type="submit" disabled={blocked}>Run</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <div aria-live="polite">{runs.map(run => <section key={run.id} className="factory-run">
      <div className="factory-line"><strong>{run.commit ? run.commit.slice(0, 12) : run.ref}</strong><span className={`factory-run-status factory-run-${run.status}`}>{run.status}</span>
        <time className="muted small" dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time>
        {run.status === 'running' && <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void cancel(run.id)}>Cancel run</button>}
      </div>
      {run.inputs ? Object.entries(run.inputs).map(([name, value]) => <p key={name}>{inputs.find(input => input.name === name)?.label || name}: {value}</p>) : run.task && <p>{run.task}</p>}
      <p>{run.status === 'completed' ? run.detail : run.status === 'running' ? run.stages.find(stage => stage.status === 'running')?.name || 'Preparing workspace…' : run.detail}</p>
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
