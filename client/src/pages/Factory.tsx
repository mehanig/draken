import { useCallback, useEffect, useRef, useState } from 'react';
import { factory, prepareFactoryWorkflow } from '../api';
import { requestId } from '../request-id';
import { FactoryWorkspace, FactoryExecutionSettings, useFactoryWorkspaces } from '../components/FactoryWorkspace';
import type { FactoryPage } from '../../../src/factory/types';
import '../styles/factory.css';

export function Factory() {
  const workspaces = useFactoryWorkspaces();
  const [data, setData] = useState<FactoryPage | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null), preparation = useRef<AbortController | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null), [preparationError, setPreparationError] = useState('');
  const load = useCallback(async (before?: number) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    if (before === undefined) setData(null);
    try {
      const page = await factory(before, controller.signal);
      if (!controller.signal.aborted) setData(previous => before !== undefined && previous
        ? { ...page, proposals: [...previous.proposals, ...page.proposals], unavailable: previous.unavailable + page.unavailable } : page);
    } catch (cause) {
      if (!controller.signal.aborted) { setData(null); setError(cause instanceof Error ? cause.message : 'Could not read workflow proposals.'); }
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => { request.current?.abort(); preparation.current?.abort(); }; }, [load]);
  useEffect(() => {
    const target = window.location.hash.slice(1);
    if (!/^workflow-[a-f0-9]{64}$/.test(target) || !data || loading) return;
    const element = document.getElementById(target);
    if (element) {
      const details = element.querySelector<HTMLDetailsElement>(':scope > details');
      if (details) details.open = true;
      element.scrollIntoView({ block: 'start' });
    }
    else if (data.nextCursor !== null) void load(data.nextCursor);
  }, [data, loading, load]);
  async function prepare(id: string, retry: boolean) {
    const controller = new AbortController(); preparation.current = controller; setPreparing(id); setPreparationError('');
    try { await prepareFactoryWorkflow(id, requestId(), retry, controller.signal); }
    catch (cause) { if (!controller.signal.aborted) setPreparationError(cause instanceof Error ? cause.message : 'Enrichment did not complete.'); }
    finally { if (!controller.signal.aborted) { setPreparing(null); await load(); } }
  }
  const groups = new Map<string, { location: FactoryPage['proposals'][number]['location']; proposals: FactoryPage['proposals'] }>();
  for (const proposal of data?.proposals || []) {
    if (!groups.has(proposal.location.key)) groups.set(proposal.location.key, { location: proposal.location, proposals: [] });
    groups.get(proposal.location.key)!.proposals.push(proposal);
  }
  return <main className="factory-page" aria-label="Factory" aria-busy={loading}>
    <div className="factory-heading"><h1>Factory</h1>
      <button type="button" disabled={loading} onClick={() => { void load(); void workspaces.refresh(); }}>Refresh</button></div>
    <FactoryExecutionSettings state={workspaces} />
    {error && <p role="alert">{error}</p>}
    {preparationError && <p role="alert">{preparationError}</p>}
    {workspaces.error && <p role="alert">{workspaces.error}</p>}
    {loading && <p role="status">Loading…</p>}
    {data && <>
      {data.learning === 'paused' && <p className="muted small" role="status">Learning paused</p>}
      {data.learning === 'error' && <p role="status">Learning stopped. <a href="/settings">Retry in Settings</a>.</p>}
      {data.unavailable > 0 && <p className="muted small" role="status">{data.unavailable} saved {data.unavailable === 1 ? 'result' : 'results'} unavailable</p>}
      {!data.proposals.length && <section className="factory-card"><h2>No workflows yet</h2></section>}
      {[...groups.values()].map(group => <section className="factory-group" key={group.location.key} aria-label={group.location.path}>
        <header className="factory-group-heading"><div className="factory-line"><h2>{group.location.name}</h2>
          <span className="muted small">{group.location.kind === 'repository' ? 'Git repository' : group.location.kind === 'folder' ? 'Not a Git repository' : 'Location unavailable'}</span>
          <span className="muted small factory-group-count">{group.proposals.length} {group.proposals.length === 1 ? 'proposal' : 'proposals'}</span></div>
          <p className="muted small factory-location-path">{group.location.path}</p></header>
      {group.proposals.map((proposal, index) => {
        const workflow = proposal.task?.workflow || proposal.decision?.assessment.workflow;
        const limitations = proposal.task?.limitations || proposal.decision?.assessment.limitations || [];
        if (!workflow) return null;
        return <article className="factory-card" key={proposal.id} id={`workflow-${proposal.id}`}>
          <details className="factory-workflow" open={expanded.has(proposal.id)} onToggle={event => {
            const open = event.currentTarget.open;
            setExpanded(previous => {
              if (previous.has(proposal.id) === open) return previous;
              const next = new Set(previous);
              if (open) next.add(proposal.id); else next.delete(proposal.id);
              return next;
            });
          }}>
          <summary className="factory-workflow-summary">
            <span className="factory-workflow-number">{index + 1}.</span>
            <h3>{workflow.purpose}</h3>
            <span className="factory-workflow-status muted">{preparing === proposal.id || proposal.enrichment?.status === 'running' ? 'Preparing' : proposal.enrichment?.status === 'ready' ? 'Ready' : proposal.enrichment?.status === 'failed' ? 'Preparation failed' : 'Needs preparation'}</span>
          </summary>
          <div className="factory-workflow-body"><p className="muted">{workflow.appliesWhen}</p>
          <ol>{workflow.method.map((step, i) => <li key={i}>{step}</li>)}</ol>
          {proposal.task && <p className="muted small">Derived from one task</p>}
          {!!limitations.length && <><h3>Limitations</h3><ul>{limitations.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
          {proposal.enrichment?.status === 'ready' && proposal.enrichment.value ? <>
            <h3>Execution guidance</h3><p className="muted small">Draken additions, separate from historical observations.</p>
            <ol>{proposal.enrichment.value.guidance.steps.map(step => <li key={step.step}><p>{step.approach}</p><ul>{step.checks.map((check, i) => <li key={i}>{check}</li>)}</ul></li>)}</ol>
            <h3>Review</h3><ul>{proposal.enrichment.value.guidance.review.map((item, i) => <li key={i}>{item}</li>)}</ul>
            <h3>Completion</h3><ul>{proposal.enrichment.value.guidance.completion.map((item, i) => <li key={i}>{item}</li>)}</ul>
            {!!proposal.enrichment.value.guidance.risks.length && <><h3>Execution risks</h3><ul>{proposal.enrichment.value.guidance.risks.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
            <details><summary>Host requirements</summary><ul>{proposal.enrichment.value.requirements.map((item, i) => <li key={i}>{item}</li>)}</ul></details>
            <FactoryWorkspace state={workspaces} workflowId={proposal.id} locationKey={group.location.key} inputs={proposal.enrichment.value.guidance.inputs} />
          </> : <section aria-label="Workflow preparation"><p role="status">{preparing === proposal.id || proposal.enrichment?.status === 'running' ? 'Preparing workflow…' : proposal.enrichment?.status === 'failed' ? 'Enrichment failed. The attempt is retained.' : 'Awaiting enrichment — not ready to run.'}</p>
            <button type="button" disabled={!!preparing || proposal.enrichment?.status === 'running'} onClick={() => void prepare(proposal.id, proposal.enrichment?.status === 'failed')}>{proposal.enrichment?.status === 'failed' ? 'Retry enrichment' : 'Enrich workflow'}</button>
            <p className="muted small">One preparation call. Saved guidance is reused across tasks.</p>
          </section>}
          <details><summary>Evidence</summary>
            <p>{proposal.task?.reason || proposal.decision?.assessment.reason}</p>
            {proposal.task && <p>Requested scope: {proposal.task.request}</p>}
            {proposal.evidence.map((input, i) => <section className="factory-evidence" key={i}>
              <h3>{input.goal}</h3><p>{input.context}</p>
              <p>{input.complete ? 'Episode boundaries recorded.' : 'Episode coverage is incomplete.'}</p>
              {!!input.limitations?.length && <ul>{input.limitations.map((limit, j) => <li key={j}>{limit}</li>)}</ul>}
              {!!input.gaps.length && <ul>{input.gaps.map((gap, j) => <li key={j}>{gap}</li>)}</ul>}
              <ul>{input.facts.map(fact => <li key={fact.id}><strong>{fact.basis}:</strong> {fact.description}<small className="factory-refs">{fact.id} · {fact.refs.join(', ')}</small></li>)}</ul>
            </section>)}
            <p className="muted small">Model: {proposal.model} · Saved {new Date(proposal.createdAt).toLocaleString()}</p>
          </details>
          </div></details>
        </article>;
      })}</section>)}
      {data.nextCursor !== null && <button type="button" disabled={loading} onClick={() => void load(data.nextCursor!)}>Load more</button>}
    </>}
  </main>;
}
