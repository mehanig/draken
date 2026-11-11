import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check } from 'lucide-react';
import * as api from '../api';
import type { CallReadiness, SyncDetail } from '../types';
import { CitedText, EvidenceList } from '../components/EvidenceList';
import { SummaryTree } from '../components/SummaryTree';
import { VoiceCall } from '../components/VoiceCall';
import { TextChat } from '../components/TextChat';
import { requestId } from '../request-id';
import { HistoryProgress } from '../components/HistoryProgress';
import { SyncCost } from '../components/SyncCost';
import { linkClick, type Navigate } from '../navigation';

export function Sync({ id, chat = false, callIntent, consumeIntent, navigate, setGuard }: {
  id: number; chat?: boolean; callIntent: boolean; consumeIntent: () => void; navigate: Navigate; setGuard: (guard: (() => boolean) | null) => void;
}) {
  const [sync, setSync] = useState<SyncDetail | null>(null);
  const [readiness, setReadiness] = useState<CallReadiness | null>(null);
  const [work, setWork] = useState(''), [error, setError] = useState('');
  const [voiceActive, setVoiceActive] = useState(false), [callAfterPreparation, setCallAfterPreparation] = useState(false);
  const [decisions, setDecisions] = useState(''), [carry, setCarry] = useState(''), [question, setQuestion] = useState('');
  const alive = useRef(true), chatRequest = useRef<{ text: string; id: string } | null>(null);
  const show = (value: SyncDetail) => { if (alive.current) { setSync(value); setDecisions(value.decisions); setCarry(value.carry_forward); } };
  const run = async (label: string, action: () => Promise<void>) => {
    setWork(label); setError('');
    try { await action(); } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'Something went wrong'); }
    finally { if (alive.current) setWork(''); }
  };
  useEffect(() => {
    alive.current = true; void api.sync(id).then(show).catch(error => { if (alive.current) setError(error.message); });
    return () => { alive.current = false; };
  }, [id]);
  useEffect(() => {
    if (!sync?.busy) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const progress = await api.progress(id);
        if (stopped) return;
        if (progress.busy) setSync(current => current ? { ...current, tree: progress } : current);
        else { const value = await api.sync(id); if (!stopped) show(value); return; }
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : 'Could not refresh progress'); }
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [id, sync?.busy]);
  useEffect(() => {
    setReadiness(null);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await (chat ? api.chatReadiness : api.callReadiness)(id, controller.signal); if (!controller.signal.aborted) setReadiness(value); }
      catch { if (!controller.signal.aborted) setReadiness(null); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), sync?.busy ? 1000 : 3000);
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id, sync?.busy, sync?.briefing, sync?.status, voiceActive, chat]);
  const dirty = Boolean(sync && (decisions !== sync.decisions || carry !== sync.carry_forward));
  const draftDirty = Boolean(question.trim());
  useEffect(() => {
    const guard = () => !(dirty || draftDirty || voiceActive) || window.confirm(voiceActive ? 'Leave this page and end the call?' : 'Leave with unsaved notes or an unsent message?');
    setGuard(guard);
    const warn = (event: BeforeUnloadEvent) => { if (dirty || draftDirty || voiceActive) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { setGuard(null); window.removeEventListener('beforeunload', warn); };
  }, [dirty, draftDirty, voiceActive, setGuard]);
  const consume = () => { consumeIntent(); setCallAfterPreparation(false); };
  const disabled = Boolean(work || sync?.busy || voiceActive), open = sync?.status === 'open';
  const evidence = sync ? [...sync.items, ...sync.context] : [];
  const missing = evidence.some(item => item.unavailable);
  const prepare = () => void run('Preparing your conversation…', async () => {
    if (!sync) return;
    if (chat && dirty) throw new Error('Save or undo your note edits before preparing chat.');
    setCallAfterPreparation(!chat);
    if (dirty) await api.notes(id, decisions, carry);
    show(await api.brief(id));
  });
  const prepareHistory = () => void run('Preparing history for your conversation…', async () => {
    if (chat && dirty) throw new Error('Save or undo your note edits before refreshing history.');
    consume(); setReadiness(null);
    if (dirty) await api.notes(id, decisions, carry);
    show(await api.prepareCall(id));
  });
  const discuss = (text = question) => void run('Starting discussion…', async () => {
    if (dirty) await api.notes(id, decisions, carry);
    show(await api.discuss(id, text));
  });
  const sendChat = (text = question) => void run('Sending message…', async () => {
    consume();
    if (dirty) throw new Error('Save your note edits, or undo them, before sending a message. Chat does not save decisions for you.');
    const pending = chatRequest.current?.text === text ? chatRequest.current : { text, id: requestId() };
    chatRequest.current = pending;
    let value: SyncDetail;
    try { value = await api.chat(id, text, pending.id); }
    catch (error) {
      // Recover an accepted job after a lost response; never silently resend it.
      const recovered = await api.sync(id).catch(() => null);
      if (recovered?.tree.run?.request_id !== pending.id) throw error;
      value = recovered;
    }
    show(value); setQuestion(''); chatRequest.current = null;
  });
  const resume = () => sync?.tree.run?.question ? (chat || sync.tree.run.request_id ? sendChat(sync.tree.run.question) : discuss(sync.tree.run.question)) : prepare();
  const cancel = () => { consume(); void run('Stopping preparation…', async () => { await api.cancel(id); }); };
  const preparationFailed = !sync?.busy && sync?.tree.run && ['failed', 'cancelled', 'interrupted'].includes(sync.tree.run.status);
  useEffect(() => { if (preparationFailed || readiness?.error) consume(); }, [preparationFailed, readiness?.error]);

  return <main className="sync-detail">
    <a className="back-link" href="/" onClick={event => linkClick(event, navigate, '/')}><ArrowLeft size={16} />All syncs</a>
    {error && <div className="alert error" role="alert">{error}</div>}
    {!sync && !error && <p role="status">Opening sync…</p>}
    {sync && <>
      <div className="page-heading"><div><span className="eyebrow">FROZEN CONVERSATION</span><h1>Sync #{id}</h1><p className="muted">Snapshot created {new Date(sync.snapshot_at).toLocaleString()} · {sync.item_count} entries · <span className={`status ${sync.status}`}>{sync.status === 'completed' ? 'reviewed' : sync.status}</span></p><SyncCost cost={sync.aggregation_cost} /></div>
        {open && <button className="btn btn-secondary" disabled={disabled || missing || Boolean(sync.tree.run && !sync.tree.complete)} onClick={() => {
          if (!window.confirm(`Mark these ${sync.item_count} snapshot entries reviewed? Later activity is not affected. This does not mean every spoken suggestion was agreed.`)) return;
          void run('Marking snapshot reviewed…', async () => { show(await api.finish(id, decisions, carry)); });
        }}><Check size={16} />Mark reviewed</button>}
      </div>
      {missing && <div className="alert warning" role="alert"><strong>Original session evidence unavailable.</strong><p>Restore the original session files to inspect the missing excerpts, prepare replies, call or mark this snapshot reviewed. Your conversation and saved notes are still available; Draken keeps pointers, not copies of original session text.</p></div>}
      {(work || sync.busy) && !(chat && (work === 'Sending message…' || (sync.tree.run?.question && sync.tree.run.status === 'running'))) && <div className="working" role="status"><span className="spinner" />{work || (sync.recap_state === 'running' ? 'Making a short conversation recap…' : readiness?.preparing ? 'Preparing searchable history…' : sync.tree.run?.stage || 'Preparing your conversation…')}
        {sync.busy && <button className="btn btn-secondary" onClick={cancel}>Cancel preparation</button>}</div>}
      <HistoryProgress enabled={sync.busy} />
      {sync.busy && !sync.tree.run?.question && sync.recap_state !== 'running' && <p className="small muted">The complete new snapshot is being reconciled. Large histories can take a while. Leaving or reloading will not start your microphone.</p>}
      {preparationFailed && !(chat && sync.tree.run?.question) && <div className="alert warning" role="alert"><strong>{sync.tree.run?.question ? 'Reply stopped.' : 'Preparation stopped.'}</strong><p>{sync.tree.run?.error || 'Your snapshot is retained. Nothing was marked reviewed.'}</p><button className="btn btn-primary" disabled={disabled || missing} onClick={resume}>{sync.tree.run?.question ? 'Retry reply' : chat ? 'Retry preparation' : 'Retry preparation & call'}</button></div>}
      {open && !sync.briefing && !sync.busy && !preparationFailed && sync.snapshot_version === 2 && <button className="btn btn-primary" disabled={disabled || missing} onClick={prepare}>{chat ? 'Prepare for chat' : 'Prepare & call'}</button>}
      {chat ? <TextChat sync={sync} readiness={readiness} draft={question} setDraft={setQuestion} disabled={disabled || missing} sending={work === 'Sending message…'} onSend={sendChat} onCancel={cancel} onPrepareHistory={prepareHistory} onVoice={() => navigate(`/syncs/${id}`)} /> : <VoiceCall key={id} sync={sync} readiness={readiness} onPrepareHistory={prepareHistory} disabled={disabled || missing} onActiveChange={setVoiceActive}
        onChat={() => { consume(); navigate(`/syncs/${id}/chat`); }}
        autoStart={(callIntent || callAfterPreparation) && !preparationFailed && !missing} onAutoStartHandled={consume}
        beforeStart={async () => {
          if (dirty) show(await api.notes(id, decisions, carry));
          const value = await api.callReadiness(id); setReadiness(value);
          if (!value.ready) throw new Error('History needs preparation before calling. Use Prepare history first.');
        }}
        onClosed={async () => { await run('Saving a short recap…', async () => { show(await api.recap(id)); }); }} />}
      <section className="card recap-card"><div className="section-heading"><h2>At a glance</h2><button className="btn btn-secondary" disabled={disabled} onClick={() => void run('Summarizing the conversation…', async () => show(await api.recap(id)))}>{sync.recap ? 'Refresh recap' : 'Make recap'}</button></div>
        <p className="prose">{sync.recap || 'Use Make recap to condense this conversation. Ending a call also requests a recap. The full briefing and original history remain below.'}</p>
        <p className="small muted">Automatic summary, not saved decisions or proof of agreement.</p>{sync.recap_error && <p role="alert" className="small">{sync.recap_error}</p>}
      </section>
      {sync.memory.length > 0 && <details className="detail-section"><summary>Previous sync recaps</summary>{sync.memory.map(item => <article key={item.sync_id} className="memory-recap"><a href={`/syncs/${item.sync_id}`} onClick={event => linkClick(event, navigate, `/syncs/${item.sync_id}`)}>Sync #{item.sync_id}</a> <span className="small muted">{item.status === 'open' ? 'not marked reviewed' : item.status || 'historical'}</span><p className="prose">{item.recap || 'No automatic recap in this older snapshot.'}</p>{item.decisions && <p className="small prose">Saved decisions: {item.decisions}</p>}{item.carry_forward && <p className="small prose">Carried forward: {item.carry_forward}</p>}</article>)}</details>}
      <details className="detail-section" open={!sync.messages.length && Boolean(sync.briefing)}><summary>Full briefing</summary><section className="briefing-card">
        <p className="small muted">This snapshot contains the entries captured during preparation, not a live view. Check the original source dates in the evidence.</p>
        {readiness?.before && <p className="small muted">Conversation history cutoff: {new Date(readiness.before).toLocaleString()}. Later activity waits for another preparation.</p>}
        {sync.briefing ? <CitedText text={sync.briefing} evidence={evidence} /> : <p>No briefing yet.</p>}
        {sync.snapshot_version < 2 && <div className="alert warning">This is a historical capped snapshot. Notes and discussion are preserved.
          {open && <button className="btn btn-secondary" disabled={disabled} onClick={() => { if (window.confirm('Expand this legacy snapshot to currently eligible history? Existing notes and citations are retained.')) void run('Expanding snapshot…', async () => show((await api.expand(id)).sync)); }}>Expand to full history</button>}</div>}
      </section></details>
      {!chat && <details className="detail-section"><summary>Saved text conversation ({sync.messages.length})</summary><section className="discussion">
        {sync.messages.map(message => <div className={`message ${message.role}`} key={message.id}><span className="message-author">{message.role === 'user' ? 'You' : 'Draken'}</span><CitedText text={message.content} evidence={evidence} /></div>)}
        <button className="btn btn-secondary" disabled={voiceActive} onClick={() => { consume(); navigate(`/syncs/${id}/chat`); }}>Open chat</button>
      </section></details>}
      <details className="detail-section"><summary>Decisions &amp; carry-forward{dirty ? ' · unsaved' : ''}</summary><section className="notes-card"><div className="notes-grid"><div><label htmlFor="decisions">Decisions</label><textarea id="decisions" rows={4} maxLength={4000} disabled={!open || disabled} value={decisions} onChange={event => setDecisions(event.target.value)} /></div><div><label htmlFor="carry-forward">Carry into the next sync</label><textarea id="carry-forward" rows={4} maxLength={4000} disabled={!open || disabled} value={carry} onChange={event => setCarry(event.target.value)} /></div></div><p className="small muted">Only these explicitly saved notes are decisions. A call or its automatic recap does not mark anything agreed or reviewed.</p>{open && <button className="btn btn-secondary" disabled={disabled || !dirty} onClick={() => void run('Saving notes…', async () => show(await api.notes(id, decisions, carry)))}>Save notes</button>}</section></details>
      <details className="detail-section"><summary>Evidence &amp; preparation details</summary>
        <SummaryTree syncId={id} progress={sync.tree} evidence={evidence} onResume={open ? resume : undefined} resumeEnabled={!disabled && !missing} onCancel={cancel} />
        <EvidenceList items={sync.items} title="New evidence in this snapshot" /><EvidenceList items={sync.context} title="Earlier context — not new progress" />
      </details>
      {open && <div className="detail-footer"><p className="small muted">Included does not mean reviewed. You can return to this sync at this URL, or start a separate one for new activity.</p><button className="btn btn-ghost" disabled={disabled} onClick={() => {
        if (window.confirm('Discard this sync and release its unreviewed entries? Its history is retained.')) void run('Discarding sync…', async () => show(await api.discard(id)));
      }}>Discard sync</button></div>}
    </>}
  </main>;
}
