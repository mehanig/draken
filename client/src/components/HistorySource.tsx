import { useEffect, useState } from 'react';
import { readHistory } from '../api';
import { HISTORY_PAGE_CHARACTERS, type HistoryPage, type HistoryRecord } from '../../../src/memory/types';

const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Edit date not retained';
export function HistoryMetadata({ record }: { record: HistoryRecord }) {
  return <><p className="small muted">{date(record.at)} · {record.role} · {record.kind}{record.sync_id ? ` · Sync #${record.sync_id}` : ''}</p>
    <p className="small muted">{record.qualification}</p></>;
}
export function HistorySource({ reference }: { reference: string }) {
  return <SourcePage key={reference} reference={reference} />;
}
function SourcePage({ reference }: { reference: string }) {
  const [page, setPage] = useState<HistoryPage | null>(null), [offset, setOffset] = useState(0), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setError(''); setPage(null);
    void readHistory(reference, offset, controller.signal).then(value => { if (!controller.signal.aborted) setPage(value); }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [reference, offset]);
  return <section className="history-source" aria-label="Historical source">
    {error && <p role="alert">{error}</p>}
    {!page && !error && <p role="status">Reading historical source…</p>}
    {page && <><h2>{page.record.title}</h2><HistoryMetadata record={page.record} />
      {page.record.workspace && <p className="source-path">{page.record.workspace}</p>}
      <pre className="history-excerpt">{page.record.text}</pre>
      <p className="small muted">Characters {Math.min(offset + 1, page.total)}–{Math.min(offset + HISTORY_PAGE_CHARACTERS, page.total)} of {page.total} in the retained record. Source logs may contain more.</p>
      {page.total > HISTORY_PAGE_CHARACTERS && <div className="pagination"><button className="btn btn-secondary" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - HISTORY_PAGE_CHARACTERS))}>Earlier text</button><button className="btn btn-secondary" disabled={offset + HISTORY_PAGE_CHARACTERS >= page.total} onClick={() => setOffset(offset + HISTORY_PAGE_CHARACTERS)}>Later text</button></div>}
      {page.record.sync_id && <p><a href={`/syncs/${page.record.sync_id}`} target="_blank" rel="noopener noreferrer">Open original sync #{page.record.sync_id}</a>{page.record.origin_ref && ` · original reference ${page.record.origin_ref}`}</p>}
      {page.neighbors.length > 0 && <details><summary>Surrounding retained records</summary><p className="small muted">Nearby records in this session or discussion—not necessarily the full conversation.</p>{page.neighbors.map(item => <article key={item.ref}><h3><a href={`/history/${item.ref}`} target="_blank" rel="noopener noreferrer">{item.title}</a></h3><HistoryMetadata record={item} /><pre className="history-excerpt">{item.text}</pre></article>)}</details>}
    </>}
  </section>;
}
