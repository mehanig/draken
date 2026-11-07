import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import type { HistoryPage, HistoryRecord, HistoryResults } from '../../../src/memory/types';
import { linkClick, type Navigate } from './Home';
import { HistoryProgress } from '../components/HistoryProgress';

const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Edit date not retained';
function Metadata({ record }: { record: HistoryRecord }) {
  return <><p className="small muted">{date(record.at)} · {record.role} · {record.kind}{record.sync_id ? ` · Sync #${record.sync_id}` : ''}</p>
    <p className="small muted">{record.qualification}</p></>;
}
export function HistorySource({ reference }: { reference: string }) {
  const [page, setPage] = useState<HistoryPage | null>(null), [offset, setOffset] = useState(0), [error, setError] = useState('');
  useEffect(() => { setOffset(0); }, [reference]);
  useEffect(() => {
    let alive = true; setError(''); setPage(null);
    void api.readHistory(reference, offset).then(value => { if (alive) setPage(value); }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [reference, offset]);
  return <section className="history-source" aria-label="Historical source">
    {error && <p role="alert">{error}</p>}
    {!page && !error && <p role="status">Reading historical source…</p>}
    {page && <><h2>{page.record.title}</h2><Metadata record={page.record} />
      {page.record.workspace && <p className="source-path">{page.record.workspace}</p>}
      <pre className="history-excerpt">{page.record.text}</pre>
      <p className="small muted">Characters {Math.min(offset + 1, page.total)}–{Math.min(offset + 4000, page.total)} of {page.total} in the retained record. Source logs may contain more.</p>
      {page.total > 4000 && <div className="pagination"><button className="btn btn-secondary" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 4000))}>Earlier text</button><button className="btn btn-secondary" disabled={offset + 4000 >= page.total} onClick={() => setOffset(offset + 4000)}>Later text</button></div>}
      {page.record.sync_id && <p><a href={`/syncs/${page.record.sync_id}`} target="_blank" rel="noopener noreferrer">Open original sync #{page.record.sync_id}</a>{page.record.origin_ref && ` · original reference ${page.record.origin_ref}`}</p>}
      {page.neighbors.length > 0 && <details><summary>Surrounding retained records</summary><p className="small muted">Nearby records in this session or discussion—not necessarily the full conversation.</p>{page.neighbors.map(item => <article key={item.ref}><h3><a href={`/history/${item.ref}`} target="_blank" rel="noopener noreferrer">{item.title}</a></h3><Metadata record={item} /><pre className="history-excerpt">{item.text}</pre></article>)}</details>}
    </>}
  </section>;
}
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
        {results.results.map(item => <article className="card history-result" key={item.ref}><h2><a href={`/history/${item.ref}`} target="_blank" rel="noopener noreferrer">{item.title}</a></h2><Metadata record={item} /><pre className="history-excerpt">{item.text}</pre><a href={`/history/${item.ref}`} target="_blank" rel="noopener noreferrer">Read source and surrounding context</a></article>)}
        <p className="small muted">{results.limitations}</p>
      </section>}
    </>}
  </main>;
}
