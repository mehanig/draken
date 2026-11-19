import { useEffect, useRef, useState } from 'react';
import { ActivityWindow } from './ActivityWindow';
import { RefreshCw } from 'lucide-react';
import * as api from '../api';
import type { Overview, ScanResult } from '../types';

const date = (value: string) => new Date(value).toLocaleString();
const formats = { pi: 'pi v3 JSONL', codex: 'Rollout JSONL', claude: 'Transcript JSONL' };

/** Recorded session inventory and bounded directory-presence metadata. */
export function AgentSources({ open }: { open: boolean }) {
  const [expanded, setExpanded] = useState(false), [sources, setSources] = useState<Overview | null>(null);
  const [showIgnored, setShowIgnored] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(true), [working, setWorking] = useState(false);
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [scan, setScan] = useState<ScanResult | null>(null);
  const mounted = useRef(true), operating = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open || !expanded || working) return;
    let alive = true;
    const refresh = async () => {
      try {
        const [value, home] = await Promise.all([api.overview(), api.home()]);
        if (alive && !operating.current) { setSources(value); setBusy(home.busy || home.active_call); setReadError(''); }
      } catch (error) { if (alive && !operating.current) setReadError(error instanceof Error ? error.message : 'Could not read session sources'); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [open, expanded, working]);
  const perform = async (operation: () => Promise<Overview>, optimistic?: Overview) => {
    if (!sources || busy || readError || operating.current) return;
    const previous = sources;
    operating.current = true; setWorking(true); setError('');
    if (optimistic) setSources(optimistic);
    try { const value = await operation(); if (mounted.current) setSources(value); }
    catch (error) { if (mounted.current) { if (optimistic) setSources(previous); setError(error instanceof Error ? error.message : 'Could not update session sources'); } }
    finally { operating.current = false; if (mounted.current) setWorking(false); }
  };
  const disabled = !sources || busy || working || Boolean(readError);
  return <details className="source-settings" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Agents &amp; sessions</summary>
    <p className="small muted">Directory presence is not an installation check. Opening this panel reads recorded metadata; it does not scan transcripts, index embeddings or call a model.</p>
    <p className="small muted">Enable each history source before importing it. Codex and Claude history start off; existing pi choices are preserved. Enabling a source allows its logs into the next scan, sync or enabled background batch. Automatic local indexing is on by default for new installations; turn it off separately if you prefer manual indexing. It does not create syncs or generate briefings. New sessions from enabled agents are selected by default. Summarization still runs through pi, regardless of which agent produced the history.</p>
    <ActivityWindow active={open && expanded} disabled={disabled} onChanged={async () => { const next = await api.overview(); if (mounted.current) setSources(next); }} />
    {!sources && <p className="small muted" role="status">Loading session inventory…</p>}
    <button type="button" className="btn btn-secondary" disabled={disabled || !sources?.agents.some(agent => agent.enabled)} onClick={() => void perform(async () => {
      const result = await api.scan(); if (mounted.current) setScan(result); return api.overview();
    })}><RefreshCw size={15} aria-hidden="true" />Scan enabled agents</button>
    {busy && sources && <p className="small muted">Source changes are paused while a call or sync preparation is active.</p>}
    {working && <p className="small muted" role="status">Updating session sources…</p>}
    {sources?.agents.map(agent => {
      const sessions = sources.sessions.filter(item => item.agent === agent.id);
      const ignored = (item: Overview['sessions'][number]) => !agent.enabled || !item.included || Boolean(item.missing) || item.within_activity_window === false;
      const ignoredCount = sessions.filter(ignored).length;
      const visible = showIgnored[agent.id] ? sessions : sessions.filter(item => !ignored(item));
      return <section key={agent.id} className="agent-source" aria-labelledby={`${agent.id}-source-title`}>
        <div className="section-heading"><h3 id={`${agent.id}-source-title`}>{agent.name}</h3><span className="status">{formats[agent.id]}</span></div>
        <label className="index-toggle"><input type="checkbox" role="switch" aria-label={`Enable ${agent.name} history`} checked={agent.enabled} disabled={disabled} onChange={event => {
          const enabled = event.target.checked;
          void perform(() => api.enableAgent(agent.id, enabled), { ...sources, agents: sources.agents.map(row => row.id === agent.id ? { ...row, enabled } : row) });
        }} /><span><strong>Include {agent.name} history</strong><span className="small muted">{agent.enabled ? 'Enabled for scanning and future syncs' : 'Off — transcripts are not scanned or indexed'}</span></span></label>
        {agent.roots.map(root => <div key={root.path}><p className="small muted">{root.status === 'present' ? 'Directory found' : root.status === 'missing' ? 'Directory not found' : 'Directory unavailable'}</p><code className="source-path">{root.path}</code></div>)}
        <p className="small muted">{sessions.length} recorded sessions · {sessions.length - ignoredCount} eligible · {sessions.filter(item => item.missing).length} unavailable at last scan</p>
        {!sessions.length && <p className="small muted">No {agent.name} sessions recorded yet.{agent.enabled ? ' Scan enabled agents to discover them.' : ' Enable this source before scanning.'}</p>}
        {ignoredCount > 0 && <p className="small muted">{ignoredCount} ignored {ignoredCount === 1 ? 'session' : 'sessions'}{showIgnored[agent.id] ? '' : ' hidden'}.</p>}
        <div id={`${agent.id}-sessions`} className="session-list" aria-label={`Discovered ${agent.name} sessions`}>{visible.map(item => <label className={`session-source${ignored(item) ? ' session-ignored' : ''}`} key={item.id}>
          <input type="checkbox" checked={Boolean(item.included)} disabled={disabled || !agent.enabled || Boolean(item.missing)} aria-label={`Include ${item.name || 'session'} (${item.id})`} onChange={event => {
            const included = event.target.checked;
            void perform(() => api.include(item.id, included), { ...sources, sessions: sources.sessions.map(row => row.id === item.id ? { ...row, included: Number(included) } : row) });
          }} />
          <span><strong>{item.name || item.cwd.split(/[\\/]/).filter(Boolean).pop() || item.id}</strong>
            <span className="source-cwd" title={item.cwd}>{item.cwd || 'Workspace unavailable'}</span>
            <span className="small">{!agent.enabled ? 'Agent disabled' : !item.included ? 'Manually excluded' : item.missing ? 'Unavailable' : item.within_activity_window === false ? item.last_message_at ? 'Outside activity window' : 'Activity date unknown' : 'Included'} · {item.pending} unreviewed {item.pending === 1 ? 'entry' : 'entries'}{item.missing ? ' · unavailable at last scan' : ''}</span>
            <span className="source-session-meta small muted">First message: {item.first_message_at ? date(item.first_message_at) : 'Unknown'} · Last message: {item.last_message_at ? date(item.last_message_at) : 'Unknown'}</span>
            {item.last_message_preview && <span className="source-last-message small">{item.last_message_preview}</span>}
            <span className="source-session-meta small muted">Session {item.external_id || item.id}</span><code className="source-path">{item.path}</code>
          </span>
        </label>)}</div>
        {ignoredCount > 0 && <button type="button" className="btn btn-secondary" aria-expanded={Boolean(showIgnored[agent.id])} aria-controls={`${agent.id}-sessions`} onClick={() => setShowIgnored(previous => ({ ...previous, [agent.id]: !previous[agent.id] }))}>
          {showIgnored[agent.id] ? 'Hide ignored sessions' : 'Show ignored sessions'}
        </button>}
      </section>;
    })}
    {sources && <p className="small muted">{sources.history_initialized && sources.history_since ? `Existing history baseline: ${date(sources.history_since)}. It is preserved.` : 'The activity window determines which sessions are prepared.'} Source choices do not edit existing frozen syncs or mark evidence reviewed. Scanning does not generate summaries or start a call. Keep the original logs: evidence is verified from them, not copied into Draken.</p>}
    {scan && <p className="small muted" role="status">Last requested scan: {scan.files} candidate log files checked · {scan.added} new records recorded.</p>}
    {scan && scan.warnings.length > 0 && <ul className="source-warnings small" aria-label="Scan warnings">{scan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {(error || readError) && <p className="small" role="alert">{error || readError}</p>}
  </details>;
}
