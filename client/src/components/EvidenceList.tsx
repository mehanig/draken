import type { Evidence } from '../types';

export function EvidenceList({ items, title }: { items: Evidence[]; title: string }) {
  if (!items.length) return null;
  return <section className="evidence-section">
    <h3>{title} <span className="count">{items.length}</span></h3>
    <div className="evidence-list">
      {items.map(item => <details className="evidence" id={`evidence-${item.ref}`} key={item.ref}>
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
    return <button className="citation" key={index} onClick={() => {
      const target = document.getElementById(`evidence-${ref}`) as HTMLDetailsElement | null;
      if (target) { target.open = true; target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }} aria-label={`Inspect evidence ${ref}`}>{part}</button>;
  })}</div>;
}
