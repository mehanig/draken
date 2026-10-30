import { useEffect, useState } from 'react';
import type { Evidence } from '../types';

const PAGE_SIZE = 25;
export function EvidenceList({ items, title }: { items: Evidence[]; title: string }) {
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState('');
  useEffect(() => {
    const reveal = (event: Event) => {
      const ref = (event as CustomEvent<string>).detail;
      const index = items.findIndex(item => item.ref === ref);
      if (index < 0) return;
      setQuery(''); setPage(Math.floor(index / PAGE_SIZE)); setFocus(ref);
    };
    window.addEventListener('draken:evidence', reveal);
    return () => window.removeEventListener('draken:evidence', reveal);
  }, [items]);
  useEffect(() => {
    if (!focus) return;
    const target = document.getElementById(`evidence-${focus}`) as HTMLDetailsElement | null;
    if (target) { target.open = true; target.scrollIntoView({ behavior: 'smooth', block: 'center' }); setFocus(''); }
  }, [focus, page, query]);
  if (!items.length) return null;
  const needle = query.toLocaleLowerCase();
  const filtered = needle ? items.filter(item => `${item.ref} ${item.session_name} ${item.cwd} ${item.text}`.toLocaleLowerCase().includes(needle)) : items;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  return <section className="evidence-section">
    <h3>{title} <span className="count">{items.length}</span></h3>
    {items.length > PAGE_SIZE && <div className="evidence-controls"><input className="input" aria-label={`Search ${title}`} placeholder="Find a topic, workspace, or evidence ID…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
      <div className="pagination"><button className="btn btn-secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button><span>{current + 1} / {pages} · {filtered.length} entries</span><button className="btn btn-secondary" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</button></div></div>}
    <div className="evidence-list">
      {filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(item => <details className="evidence" id={`evidence-${item.ref}`} key={item.ref}>
        <summary>
          <span className="reference">{item.ref}</span>
          <span className="evidence-title"><strong>{item.session_name || item.cwd.split('/').filter(Boolean).pop() || item.cwd}</strong>
            <span>{item.text.slice(0, 130)}</span></span>
          <span className="role-label">{item.role}</span>
        </summary>
        <div className="evidence-body">
          <dl><dt>Workspace</dt><dd>{item.cwd}</dd><dt>Session</dt><dd>{item.session_id}</dd>
            <dt>Source</dt><dd>{item.source_path}</dd><dt>Entry</dt><dd>{item.entry_id} · {item.timestamp}</dd></dl>
          <pre>{item.text}</pre>
        </div>
      </details>)}
    </div>
  </section>;
}

export function CitedText({ text, evidence }: { text: string; evidence: Evidence[] }) {
  const refs = new Set(evidence.map(item => item.ref));
  return <div className="prose">{text.split(/(\[(?:E|C)\d+\])/g).map((part, index) => {
    const ref = part.slice(1, -1);
    if (!/^\[(E|C)\d+\]$/.test(part) || !refs.has(ref)) return <span key={index}>{part}</span>;
    return <button className="citation" key={index} onClick={() => window.dispatchEvent(new CustomEvent('draken:evidence', { detail: ref }))}
      aria-label={`Inspect evidence ${ref}`}>{part}</button>;
  })}</div>;
}
