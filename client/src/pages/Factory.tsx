import { useCallback, useEffect, useRef, useState } from 'react';
import { factory } from '../api';
import type { FactoryPage } from '../../../src/factory/types';
import '../styles/factory.css';

export function Factory() {
  const [data, setData] = useState<FactoryPage | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
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
  return <main className="factory-page" aria-label="Factory" aria-busy={loading}>
    <div className="factory-heading"><div><p className="muted small">Workflow learning · No execution</p><h1>Factory</h1></div>
      <button type="button" disabled={loading} onClick={() => void load()}>Refresh saved results</button></div>
    <p>Reusable ways of doing a job, learned from its purpose, method and conditions—not just matching tools or words.</p>
    <aside className="factory-notice">Process records are saved alongside normal summaries. Background summarization compares them and saves workflow proposals without a manual sync or Factory visit. This page only reads saved results; it never starts inference.</aside>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">Checking saved proposals and their source access…</p>}
    {data && <>
      <p role="status">{data.learning === 'enabled' ? 'Background learning is enabled with automatic summarization.' : data.learning === 'paused' ? 'Background learning is paused because automatic preparation is disabled. Saved proposals remain available.' : 'Automatic preparation stopped after an error. Completed work is retained; use the existing preparation retry in Settings.'}</p>
      {data.failedExtractions > 0 && <p role="status">Some summaries could not retain valid process records. Their normal summaries remain available; those failures are not treated as empty matches.</p>}
      {data.unavailable > 0 && <p role="status">Some saved results could not be verified against permitted application history and are not shown.</p>}
      {!data.proposals.length && <section className="factory-card"><h2>No verified workflow proposals yet</h2><p>Proposals appear as newly summarized history provides comparable process records. Existing summaries are not automatically regenerated for workflow backfill, and historical experiments are not imported.</p></section>}
      {data.proposals.map(proposal => {
        const workflow = proposal.decision.assessment.workflow;
        if (!workflow) return null;
        return <article className="factory-card" key={proposal.id}>
          <p className="muted small">Proposed workflow · Not approved for execution</p>
          <h2>{workflow.purpose}</h2><h3>When it applies</h3><p>{workflow.appliesWhen}</p>
          <h3>Method</h3><ol>{workflow.method.map((step, i) => <li key={i}>{step}</li>)}</ol>
          <p>{proposal.decision.assessment.reason}</p>
          {!!proposal.decision.assessment.limitations.length && <><h3>What is uncertain</h3><ul>{proposal.decision.assessment.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
          <details><summary>Compared records and supporting evidence</summary>
            <p className="muted">Complete episode coverage is not proof of success. A failed attempt can follow the same workflow. Shared parts alone do not merge different jobs.</p>
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
      })}
      {data.nextCursor !== null && <button type="button" disabled={loading} onClick={() => void load(data.nextCursor!)}>Load older saved results</button>}
    </>}
  </main>;
}
