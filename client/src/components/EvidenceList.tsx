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

export function SourceInspector({ syncId }: { syncId: number }) {
  const root = useRef<HTMLDetailsElement>(null), [reference, setReference] = useState('');
  useEffect(() => {
    const reveal = (event: Event) => {
      setReference((event as CustomEvent<string>).detail);
      if (root.current) { root.current.open = true; root.current.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    };
    window.addEventListener('draken:evidence', reveal);
    return () => window.removeEventListener('draken:evidence', reveal);
  }, []);
  return <details ref={root} className="detail-section"><summary>Cited source</summary>
    {reference ? <SnapshotSource key={reference} syncId={syncId} reference={reference} /> : <p>Click a citation to inspect its original source.</p>}
  </details>;
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
