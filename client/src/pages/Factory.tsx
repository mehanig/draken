import { useCallback, useEffect, useRef, useState } from 'react';
import { factory } from '../api';
import { FactoryWorkspace, useFactoryWorkspaces } from '../components/FactoryWorkspace';
import { FactoryExecutionPanel, useFactoryExecution } from '../components/FactoryExecution';
import type { FactoryPage } from '../../../src/factory/types';
import '../styles/factory.css';

export function Factory() {
  const workspaces = useFactoryWorkspaces();
  const { execution, executionError, refreshExecution } = useFactoryExecution();
  const [data, setData] = useState<FactoryPage | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => { if (executionError) setData(null); }, [executionError]);
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
  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);
  const groups = new Map<string, { location: FactoryPage['proposals'][number]['location']; proposals: FactoryPage['proposals'] }>();
  for (const proposal of data?.proposals || []) {
    if (!groups.has(proposal.location.key)) groups.set(proposal.location.key, { location: proposal.location, proposals: [] });
    groups.get(proposal.location.key)!.proposals.push(proposal);
  }
  return <main className="factory-page" aria-label="Factory" aria-busy={loading}>
    <div className="factory-heading"><h1>Factory</h1>
      <button type="button" disabled={loading} onClick={() => { void load(); void refreshExecution(); void workspaces.refresh(); }}>Refresh</button></div>
    {error && <p role="alert">{error}</p>}
    {executionError && <p role="alert">Execution unavailable: {executionError}</p>}
    {loading && <p role="status">Loading…</p>}
    <FactoryWorkspace state={workspaces} />
    {data && !executionError && <>
      {data.learning === 'paused' && <p className="muted small" role="status">Learning paused</p>}
      {data.learning === 'error' && <p role="status">Learning stopped. <a href="/settings">Retry in Settings</a>.</p>}
      {data.unavailable > 0 && <p className="muted small" role="status">{data.unavailable} saved {data.unavailable === 1 ? 'result' : 'results'} unavailable</p>}
      {!data.proposals.length && <section className="factory-card"><h2>No workflows yet</h2></section>}
      {[...groups.values()].map(group => <section className="factory-group" key={group.location.key} aria-label={group.location.path}>
        <header className="factory-group-heading"><div className="factory-line"><h2>{group.location.name}</h2>
          <span className="muted small">{group.location.kind === 'repository' ? 'Git repository' : group.location.kind === 'folder' ? 'Not a Git repository' : 'Location unavailable'}</span>
          <span className="muted small factory-group-count">{group.proposals.length} {group.proposals.length === 1 ? 'proposal' : 'proposals'}</span></div>
          <p className="muted small factory-location-path">{group.location.path}</p></header>
      {group.proposals.map(proposal => {
        const workflow = proposal.decision.assessment.workflow;
        if (!workflow) return null;
        return <article className="factory-card" key={proposal.id}>
          <h2>{workflow.purpose}</h2><p className="muted">{workflow.appliesWhen}</p>
          <ol>{workflow.method.map((step, i) => <li key={i}>{step}</li>)}</ol>
          {!!proposal.decision.assessment.limitations.length && <><h3>Limitations</h3><ul>{proposal.decision.assessment.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
          <FactoryWorkspace state={workspaces} workflowId={proposal.id} locationKey={group.location.key} purpose={workflow.purpose} />
          {!workspaces.data?.agentAvailable && execution?.proposalId === proposal.id && <FactoryExecutionPanel data={execution} refresh={refreshExecution} />}
          <details><summary>Evidence</summary>
            <p>{proposal.decision.assessment.reason}</p>
            {proposal.evidence.map((input, i) => <section className="factory-evidence" key={i}>
              <h3>{input.goal}</h3><p>{input.context}</p>
              <p>{input.complete ? 'Episode boundaries recorded.' : 'Episode coverage is incomplete.'}</p>
              {!!input.limitations?.length && <ul>{input.limitations.map((limit, j) => <li key={j}>{limit}</li>)}</ul>}
              {!!input.gaps.length && <ul>{input.gaps.map((gap, j) => <li key={j}>{gap}</li>)}</ul>}
              <ul>{input.facts.map(fact => <li key={fact.id}><strong>{fact.basis}:</strong> {fact.description}<small className="factory-refs">{fact.id} · {fact.refs.join(', ')}</small></li>)}</ul>
            </section>)}
            <p className="muted small">Model: {proposal.model} · Saved {new Date(proposal.createdAt).toLocaleString()}</p>
          </details>
        </article>;
      })}</section>)}
      {data.nextCursor !== null && <button type="button" disabled={loading} onClick={() => void load(data.nextCursor!)}>Load more</button>}
    </>}
  </main>;
}
