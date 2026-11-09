import { useEffect, useRef, useState } from 'react';
import { ArrowRight, MessageSquare, Phone } from 'lucide-react';
import * as api from '../api';
import { requestId as newRequestId } from '../request-id';
import { voiceRequest, type VoiceStatus } from '../voice/api';
import type { HomeOverview } from '../types';
import { SyncCost } from '../components/SyncCost';
import { SetupPanel } from '../components/SetupPanel';
import { AutomaticPreparation } from '../components/AutomaticPreparation';

export type Navigate = (path: string, call?: boolean) => void;
export const linkClick = (event: React.MouseEvent<HTMLAnchorElement>, navigate: Navigate, path: string) => {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(path);
};
const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Home({ navigate }: { navigate: Navigate }) {
  const [home, setHome] = useState<HomeOverview | null>(null);
  const [work, setWork] = useState('');
  const [error, setError] = useState('');
  const [secureUrl, setSecureUrl] = useState('');
  const [setupReady, setSetupReady] = useState(false), [textReady, setTextReady] = useState(false);
  const alive = useRef(true), starting = useRef(false), requestId = useRef<string>();
  const refresh = async () => { const data = await api.home(); if (alive.current) setHome(current => current && current.syncs.length > 20 ? { ...data, syncs: [...data.syncs, ...current.syncs.filter(item => item.id < data.syncs[data.syncs.length - 1]?.id)], next_cursor: current.next_cursor } : data); };
  useEffect(() => {
    alive.current = true; void refresh().catch(error => setError(error.message));
    if (!window.isSecureContext) void voiceRequest<VoiceStatus>('/status').then(status => {
      if (alive.current && status.httpsPort) { const url = new URL('/', location.href); url.protocol = 'https:'; url.port = String(status.httpsPort); setSecureUrl(url.href); }
    }).catch(() => {});
    const timer = setInterval(() => { if (!starting.current) void refresh().catch(() => {}); }, 4000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);
  const start = async (mode: 'call' | 'chat' = 'call') => {
    if (starting.current) return;
    starting.current = true; setWork('Collecting new activity…'); setError('');
    requestId.current ||= newRequestId();
    try {
      if (mode === 'call') {
        const voice = await voiceRequest<VoiceStatus>('/status');
        if (!voice.installed) throw new Error('Voice is not ready on this server. Complete voice setup before starting a sync call.');
        if (voice.activeCall) throw new Error('End the existing call before starting another sync.');
      }
      const result = await (mode === 'chat' ? api.startChat : api.startCall)(requestId.current);
      if (alive.current) navigate(`/syncs/${result.sync.id}${mode === 'chat' ? '/chat' : ''}`, mode === 'call');
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'Could not start the sync'); }
    finally { starting.current = false; if (alive.current) setWork(''); }
  };
  const disabled = Boolean(!setupReady || work || home?.busy || home?.active_call);
  return <main className="sync-home">
    <div className="page-heading"><div><h1>Pick up where you left off.</h1>
      <p className="muted">New activity. A little memory. One conversation.</p></div>
      <div className="conversation-actions"><button className="btn btn-secondary" disabled={!home || !textReady || Boolean(work || home?.busy || home?.active_call)} onClick={() => void start('chat')}><MessageSquare size={17} />Chat instead</button>
      {secureUrl ? <a className="btn btn-primary" href={secureUrl}>Open secure Draken<ArrowRight size={17} /></a> : <button className="btn btn-primary" disabled={!home || disabled || !window.isSecureContext} onClick={() => void start()}><Phone size={17} />Sync with Draken</button>}</div></div>
    {!window.isSecureContext && <p className="small muted">Use trusted HTTPS or localhost for the combined sync and call.</p>}
    <p className="home-hint muted small">With automatic preparation enabled, new history becomes a ready briefing before you arrive. Join the prepared conversation, or catch up the newest entries in one final preparation. Nothing is marked reviewed until you confirm it.</p>
    <div className="home-counts" aria-label="Sync tracking"><span><strong>{home?.available ?? '—'}</strong> awaiting preparation</span><span><strong>{home?.included_unreviewed ?? '—'}</strong> included, not reviewed</span><span><strong>{home?.covered ?? '—'}</strong> reviewed</span></div>
    <AutomaticPreparation />
    <details className="home-preparation-info">
      <summary>Automatic preparation and cost tracking</summary>
      <p><strong>Automatic compaction:</strong> turn on <strong>Settings → Automatically prepare conversations</strong> to index history, summarize new work and prepare a briefing while the server runs. It is off by default and uses your configured models within the saved invocation limit. Cached summaries and ready briefings are reused when their inputs match.</p>
      <p>Compaction creates derived summaries; it does not edit or delete original agent logs. It never starts a call, saves decisions or marks work reviewed automatically.</p>
      <p><strong>Preparation spending estimates:</strong> open <strong>Settings → Preparation usage</strong> for estimated USD cost, completed batches and model requests over time. Manual and automatic preparation, retries and failed work are included; missing prices remain unavailable or partial.</p>
      <p className="small muted">Not total spending, a provider invoice or account quota. Chat, voice, standalone post-conversation recaps and local machine/network costs are excluded. Opening this explanation or the usage dashboard does not start preparation.</p>
    </details>
    {work && <p role="status" className="working"><span className="spinner" />{work}</p>}
    {home?.busy && !work && <p className="small muted" role="status">Draken is updating a sync. Open its card to follow progress.</p>}
    {home?.active_call && <p className="small muted">A call is active. End it before starting another sync.</p>}
    {error && <div className="alert error" role="alert">{error}</div>}
    <SetupPanel firstRun={Boolean(home && !home.syncs.length)} onReady={setSetupReady} onTextReady={setTextReady} />
    <section className="sync-feed" aria-label="Sync history">
      {home?.syncs.map(item => <a className="card sync-tile" key={item.id} href={`/syncs/${item.id}`} onClick={event => linkClick(event, navigate, `/syncs/${item.id}`)}>
        <div className="sync-tile-heading"><strong>Sync #{item.id}</strong><span className={`status ${item.status}`}>{item.busy ? 'working' : item.active_call ? 'in call' : item.needs_retry ? 'needs retry' : item.status === 'completed' ? 'reviewed' : item.status === 'open' ? 'open' : 'discarded'}</span><ArrowRight size={17} aria-hidden="true" /></div>
        <div className="small muted">{date(item.created_at)} · {item.item_count} {item.item_count === 1 ? 'entry' : 'entries'} · {item.calls} {item.calls === 1 ? 'call' : 'calls'}{item.aggregation_cost && <> · <SyncCost cost={item.aggregation_cost} /></>}</div>
        <p className="sync-tile-preview">{item.preview || (item.needs_retry ? 'Preparation stopped. Open this sync to retry; its entries and cached work are retained.' : item.busy ? 'Bringing the new activity together. Open this sync to follow preparation.' : 'No recap yet. Open this sync to continue the conversation.')}</p>
        <span className="sync-tile-kind small muted">{item.preview_kind === 'recap' ? 'Conversation recap · not saved decisions' : item.preview_kind === 'previous_recap' ? 'Earlier recap · conversation changed' : item.preview_kind === 'briefing' ? 'Briefing preview' : 'Frozen snapshot'}</span>
      </a>)}
      {home && !home.syncs.length && <div className="card welcome"><h2>Your next conversation starts here.</h2><p>Draken keeps track of the work you’ve already brought into a sync. Start above; the details can wait until you need them.</p></div>}
    </section>
    {home?.next_cursor && <button className="btn btn-secondary" onClick={async () => {
      try { const older = await api.home(home.next_cursor!); setHome(current => current ? { ...current, syncs: [...current.syncs, ...older.syncs.filter(item => !current.syncs.some(old => old.id === item.id))], next_cursor: older.next_cursor } : older); }
      catch (error) { setError(error instanceof Error ? error.message : 'Could not load history'); }
    }}>Older syncs</button>}
  </main>;
}
