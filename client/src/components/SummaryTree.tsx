import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Evidence, NodeSummary, TopicGroups, TreeNode, TreeProgress } from '../types';
import { CitedText } from './EvidenceList';

export function SummaryTree({ syncId, progress, evidence, onCancel, onResume, resumeEnabled }: {
  syncId: number; progress: TreeProgress; evidence: Evidence[]; onCancel: () => void;
  onResume?: () => void; resumeEnabled: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{ label: string; output: NodeSummary | TopicGroups; refs: Record<string, string> } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const run = progress.run;
  useEffect(() => { setSelected(null); setExpanded(new Set()); }, [run?.id]);
  if (!run) return null;
  const stopped = !progress.busy && ['failed', 'cancelled', 'interrupted'].includes(run.status);
  const nodes = new Map(progress.nodes.map(node => [node.key, node]));
  const childKeys = new Set(progress.nodes.flatMap(node => node.children));
  const roots = progress.nodes.filter(node => !childKeys.has(node.key));
  const inspect = async (node: TreeNode) => {
    setLoading(true); setError('');
    try { setSelected(await api.treeNode(syncId, node.key)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load summary'); }
    finally { setLoading(false); }
  };
  const renderNode = (node: TreeNode, ancestors = new Set<string>()): React.ReactNode => {
    if (ancestors.has(node.key)) return null;
    const lineage = new Set([...ancestors, node.key]);
    const open = expanded.has(node.key);
    return <li key={node.key}>
      <div className="tree-node">
        <button className="tree-toggle" aria-label={`Expand ${node.label}`} disabled={!node.children.length} onClick={() => setExpanded(old => {
          const next = new Set(old); if (next.has(node.key)) next.delete(node.key); else next.add(node.key); return next;
        })}>{node.children.length ? open ? '▾' : '▸' : '·'}</button>
        <button className="tree-label" disabled={!['done', 'cached'].includes(node.status) || loading} onClick={() => void inspect(node)} title={node.error || node.label}>
          <span className="role-label">{node.kind}</span> {node.label}
        </button>
        <span className={`status ${node.status}`}>{node.status}</span>
      </div>
      {open && <ul>{node.children.map(key => nodes.has(key) ? renderNode(nodes.get(key)!, lineage) : null)}</ul>}
    </li>;
  };
  return <section className="card tree-card">
    <div className="section-heading"><h2>Summary tree</h2><span className={`status ${run.status}`}>{run.status}</span></div>
    <p className="small muted">Session chunks → session outcomes → related workstreams → final verdict</p>
    <progress max={Math.max(1, run.total_entries)} value={run.processed_entries} aria-label="Evidence compression progress" />
    <div className="tree-stats"><span>{run.processed_entries} / {run.total_entries} entries processed</span>
      <span>{run.invocations} / {run.max_invocations} pi invocations</span><span>{run.cache_hits} cached nodes reused</span></div>
    <p className="small">{stopped ? 'Stopped at: ' : ''}{run.stage}</p>
    {run.question && <p className="small muted">Question: {run.question}</p>}
    <p className="small muted">Compression: {run.summary_model} · Final: {run.final_model}. Processed does not mean verified or marked reviewed. Provider retries may add requests; this is not a dollar-cost meter.</p>
    {run.error && <div className="alert error" role="alert"><strong>Last run’s error:</strong> {run.error}</div>}
    {stopped && <div className="alert warning">
      <strong>Generation stopped. No model calls are running.</strong>
      <p className="small">{run.processed_entries < run.total_entries
        ? `${run.total_entries - run.processed_entries} entries still need compression.`
        : 'Raw chunks were processed, but reconciliation or the final reply did not finish.'} Successful chunks are cached; nothing was marked reviewed.</p>
      {onResume && <><p className="small">Authorize model access above, then resume. Cached chunks will be reused instead of being generated again.</p>
        <button className="btn btn-primary" disabled={!resumeEnabled} onClick={onResume}>Resume generation</button></>}
    </div>}
    {progress.busy && <button className="btn btn-secondary" onClick={onCancel}>Cancel generation</button>}
    <details className="tree-browser"><summary>Inspect {progress.nodes.length} summary nodes</summary><ul>{roots.map(node => renderNode(node))}</ul></details>
    {error && <p role="alert" className="error">{error}</p>}
    {selected && <div className="node-inspector"><div className="section-heading"><h3>{selected.label}</h3><button className="btn btn-ghost" onClick={() => setSelected(null)}>Close</button></div>
      {'observations' in selected.output ? <>
        {selected.output.observations.map((observation, index) => <div className="node-observation" key={index}>
          <strong>{observation.topic}</strong> <span className="status">{observation.state}</span>
          <CitedText text={`${observation.summary} ${observation.evidence.map(key => selected.refs[key] ? `[${selected.refs[key]}]` : '[source unavailable]').join(' ')}`} evidence={evidence} />
        </div>)}
        {selected.output.limitations.map((limitation, index) => <p className="muted small" key={index}>{limitation}</p>)}
      </> : selected.output.groups.map((group, index) => <p className="small" key={index}>{group.topic} · {group.members.length} related observations</p>)}
    </div>}
  </section>;
}
