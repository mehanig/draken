import { useEffect, useRef, useState } from 'react';
import * as api from '../api';

/** Shared by snapshot citations and the voice source inspector. Never reads the archive. */
export function SnapshotSource({ syncId, reference }: { syncId: number; reference: string }) {
  const [offset, setOffset] = useState(0), [error, setError] = useState('');
  const [excerpt, setExcerpt] = useState<Awaited<ReturnType<typeof api.evidenceExcerpt>> | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setExcerpt(null);
    void api.evidenceExcerpt(syncId, reference, offset, controller.signal).then(value => { if (!controller.signal.aborted) setExcerpt(value); }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [syncId, reference, offset]);
  return <article className="evidence-body">
    {error && <p role="alert">{error}</p>}
    {!excerpt && !error && <p role="status">Reading {reference}…</p>}
    {excerpt && <><h3>{excerpt.item.ref} · {excerpt.item.session_name || excerpt.item.cwd}</h3>
      <dl><dt>Workspace</dt><dd>{excerpt.item.cwd}</dd><dt>Session</dt><dd>{excerpt.item.session_id}</dd>
        <dt>Source</dt><dd>{excerpt.item.source_path}</dd><dt>Entry</dt><dd>{excerpt.item.entry_id} · {excerpt.item.timestamp}</dd></dl>
      {excerpt.item.unavailable ? <p className="alert warning" role="status">{excerpt.item.unavailable}</p> : <>
        <pre>{excerpt.item.text}</pre><p className="small muted">Characters {Math.min(offset + 1, excerpt.total)}–{Math.min(offset + 4000, excerpt.total)} of {excerpt.total}</p>
        {excerpt.total > 4000 && <div className="pagination"><button className="btn btn-secondary" disabled={!offset} onClick={() => { setExcerpt(null); setOffset(offset - 4000); }}>Earlier text</button><button className="btn btn-secondary" disabled={offset + 4000 >= excerpt.total} onClick={() => { setExcerpt(null); setOffset(offset + 4000); }}>Later text</button></div>}
      </>}
    </>}
  </article>;
}

export function EvidenceList({ syncId, active }: { syncId: number; active: boolean }) {
  const root = useRef<HTMLElement>(null);
  const [group, setGroup] = useState('items'), [offset, setOffset] = useState(0), [query, setQuery] = useState('');
  const [selection, setSelection] = useState({ ref: '', revision: 0 });
  const [page, setPage] = useState<Awaited<ReturnType<typeof api.evidencePage>> | null>(null);
  const [error, setError] = useState('');
  const select = (ref: string) => setSelection(old => ({ ref, revision: old.revision + 1 }));
  useEffect(() => {
    const reveal = (event: Event) => {
      select((event as CustomEvent<string>).detail);
      const details = root.current?.closest('details');
      if (details) details.open = true;
      root.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    window.addEventListener('draken:evidence', reveal);
    return () => window.removeEventListener('draken:evidence', reveal);
  }, []);
  useEffect(() => {
    if (!active || selection.ref) return;
    const controller = new AbortController(); setError(''); setPage(null);
    void api.evidencePage(syncId, group, offset, query, controller.signal).then(value => { if (!controller.signal.aborted) setPage(value); }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [active, syncId, group, offset, query, selection.ref]);
  return <section ref={root} className="evidence-section" aria-label="Snapshot evidence">
    <h3>Snapshot evidence</h3>
    {selection.ref ? <>
      <button className="btn btn-secondary" onClick={() => select('')}>Back to evidence list</button>
      {active && <SnapshotSource key={selection.revision} syncId={syncId} reference={selection.ref} />}
    </> : <>
      {error && <p role="alert">{error}</p>}
      <div className="evidence-controls"><select className="input" aria-label="Evidence group" value={group} onChange={event => { setPage(null); setGroup(event.target.value); setOffset(0); }}><option value="items">New evidence in this snapshot</option><option value="context">Earlier context — not new progress</option></select>
        <input className="input" aria-label="Filter evidence metadata" placeholder="Find a workspace, session, or evidence ID…" maxLength={200} value={query} onChange={event => { setPage(null); setQuery(event.target.value); setOffset(0); }} /></div>
      {!page && !error && active && <p role="status">Loading evidence list…</p>}
      {page && <><div className="pagination"><button className="btn btn-secondary" disabled={!offset} onClick={() => { setPage(null); setOffset(Math.max(0, offset - 25)); }}>Previous</button><span>{Math.floor(offset / 25) + 1} / {Math.max(1, Math.ceil(page.total / 25))} · {page.total} entries</span><button className="btn btn-secondary" disabled={offset + 25 >= page.total} onClick={() => { setPage(null); setOffset(offset + 25); }}>Next</button></div>
        <div className="evidence-list">{page.items.map(item => <button className="btn btn-secondary" key={item.ref} onClick={() => select(item.ref)} aria-label={`Read evidence ${item.ref}`}><span className="reference">{item.ref}</span> {item.session_name || item.cwd} · {item.role}</button>)}</div>
      </>}
    </>}
  </section>;
}

export function CitedText({ text }: { text: string }) {
  return <div className="prose">{text.split(/(\[(?:[EC]\d+|H[a-f0-9]{24})\])/g).map((part, index) => {
    const ref = part.slice(1, -1);
    if (/^H[a-f0-9]{24}$/.test(ref)) return <a className="citation" key={index} href={`/history/${ref}`} target="_blank" rel="noopener noreferrer" aria-label={`Inspect historical source ${ref}`}>[history {ref.slice(-6)}]</a>;
    if (!/^\[(E|C)\d+\]$/.test(part)) return <span key={index}>{part}</span>;
    return <button className="citation" key={index} onClick={() => window.dispatchEvent(new CustomEvent('draken:evidence', { detail: ref }))}
      aria-label={`Inspect evidence ${ref}`}>{part}</button>;
  })}</div>;
}
