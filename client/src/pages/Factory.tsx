import { useCallback, useEffect, useRef, useState } from 'react';
import { factory } from '../api';
import { InfoDisclosure } from '../components/InfoDisclosure';
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
    <div className="factory-heading"><div className="factory-line"><h1>Factory</h1>
      <InfoDisclosure label="About workflow learning"><p>New summaries retain process records. Background learning compares them and saves workflow proposals here. No manual sync or page visit is needed.</p><p>Proposals need comparable records; waiting alone does not guarantee a match. Existing cached summaries are not reprocessed. Refresh only reads saved results.</p></InfoDisclosure></div>
      <button type="button" disabled={loading} onClick={() => void load()}>Refresh saved results</button></div>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">Checking saved proposals and their source access…</p>}
    {data && <>
      <div className="factory-line" role="status"><span>{data.learning === 'enabled' ? 'Background learning enabled' : data.learning === 'paused' ? 'Background learning paused' : 'Preparation stopped'}</span>
        <InfoDisclosure label="About background learning"><p>{data.learning === 'enabled' ? 'Learning uses automatic summarization and its existing limits. Enabled does not mean a model call is running now.' : data.learning === 'paused' ? 'Automatic preparation is disabled. Saved proposals remain available.' : 'Preparation stopped after an error. Completed work is retained. Retry automatic preparation in Settings.'}</p></InfoDisclosure></div>
      {data.failedExtractions > 0 && <div className="factory-line" role="status"><span>{data.failedExtractions} failed {data.failedExtractions === 1 ? 'attempt' : 'attempts'}</span><InfoDisclosure label="About process extraction failures"><p>Failed extraction attempts are kept for diagnosis, even when a later attempt succeeds. Ordinary summaries are retained. Failed records are not used for matching.</p></InfoDisclosure></div>}
      {data.unavailable > 0 && <div className="factory-line" role="status"><span>{data.unavailable} saved {data.unavailable === 1 ? 'result' : 'results'} unavailable</span><InfoDisclosure label="About unavailable results"><p>Source access or saved evidence could not be verified. Those results are not shown.</p></InfoDisclosure></div>}
      {!data.proposals.length && <section className="factory-card"><h2>No workflows yet</h2></section>}
      {data.proposals.map(proposal => {
        const workflow = proposal.decision.assessment.workflow;
        if (!workflow) return null;
        return <article className="factory-card" key={proposal.id}>
          <div className="factory-line muted small"><span>Proposal</span><InfoDisclosure label="About workflow proposals"><p>This is a proposed workflow, not approval to execute it. Factory does not run workflows.</p></InfoDisclosure></div>
          <h2>{workflow.purpose}</h2><h3>When it applies</h3><p>{workflow.appliesWhen}</p>
          <h3>Method</h3><ol>{workflow.method.map((step, i) => <li key={i}>{step}</li>)}</ol>
          {!!proposal.decision.assessment.limitations.length && <><h3>What is uncertain</h3><ul>{proposal.decision.assessment.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
          <details><summary>Compared records and supporting evidence</summary>
            <p>{proposal.decision.assessment.reason}</p>
            <InfoDisclosure label="About record coverage"><p>Complete episode coverage is not proof of success. Failed attempts can follow the same workflow. A shared subprocedure does not make its parent jobs the same workflow.</p></InfoDisclosure>
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
