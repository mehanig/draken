import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { HistoryResults } from '../../../src/memory/types';
import { HistorySource, HistoryMetadata } from '../components/HistorySource';
import { linkClick, type Navigate } from '../navigation';
import { HistoryProgress } from '../components/HistoryProgress';

export function History({ navigate, reference }: { navigate: Navigate; reference?: string }) {
  const [results, setResults] = useState<HistoryResults | null>(null), [question, setQuestion] = useState('');
  const [error, setError] = useState(''), [searching, setSearching] = useState(false);
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  return <main className="sync-home history-page">
    <a className="back-link" href="/" onClick={event => linkClick(event, navigate, '/')}>All syncs</a>
    <h1>{reference ? 'Historical source' : 'Find earlier work.'}</h1>
    <p className="muted">Search retained sessions, sync discussions and explicitly saved notes. Results are historical evidence—not new progress, agreement or proof of execution.</p>
    {reference ? <><HistorySource key={reference} reference={reference} /><p><a href="/history" onClick={event => linkClick(event, navigate, '/history')}>Search history</a></p></> : <>
      <p className="small muted">Draken combines meaning and keyword matches automatically. First use prepares a local model (about 136 MB); later searches reuse it and update changed records. Search text stays on this server. Your source exclusions and history baseline still apply.</p>
      <form className="history-search" onSubmit={async event => {
        event.preventDefault(); setSearching(true); setError(''); setResults(null);
        const controller = new AbortController(); request.current = controller;
        try { const value = await api.searchHistory({ question }, controller.signal); if (!controller.signal.aborted) setResults(value); }
        catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Search failed'); } finally { setSearching(false); }
      }}><label htmlFor="history-question">What do you want to find?</label>
        <textarea id="history-question" rows={3} maxLength={2000} value={question} onChange={event => setQuestion(event.target.value)} placeholder="Why did we change that approach?" />
        <div className="history-actions"><button className="btn btn-primary" disabled={searching || !question.trim()}>{searching ? 'Searching…' : 'Search history'}</button>
          {searching && <button type="button" className="btn btn-secondary" onClick={() => request.current?.abort()}>Cancel search</button>}</div>
        <HistoryProgress enabled={searching} waiting />
      </form>
      {error && <p className="alert error" role="alert">{error}</p>}
      {results && <section aria-label="History search results"><p className="small muted">Meaning + keyword matches</p>
        {!results.results.length && <p>No matches in this search. That does not prove the event never happened; try different wording or a wider scope.</p>}
        {results.results.map(item => <article className="card history-result" key={item.ref}><h2><a href={`/history/${item.ref}`} target="_blank" rel="noopener noreferrer">{item.title}</a></h2><HistoryMetadata record={item} /><pre className="history-excerpt">{item.text}</pre><a href={`/history/${item.ref}`} target="_blank" rel="noopener noreferrer">Read source and surrounding context</a></article>)}
        <p className="small muted">{results.limitations}</p>
      </section>}
    </>}
  </main>;
}
