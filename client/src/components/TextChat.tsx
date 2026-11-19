import { useEffect, useRef } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import type { CallReadiness, SyncDetail } from '../types';
import { CitedText } from './EvidenceList';
import { ConversationInfo } from './ConversationInfo';
import { InfoDisclosure } from './InfoDisclosure';

export function TextChat({ sync, readiness, draft, setDraft, disabled, sending, onSend, onCancel, onPrepareHistory, onVoice, updatesUnavailable = false }: {
  sync: SyncDetail; readiness: CallReadiness | null; draft: string; setDraft: (text: string) => void;
  disabled: boolean; sending: boolean; onSend: (text?: string) => void; onCancel: () => void;
  onPrepareHistory: () => void; onVoice: () => void; updatesUnavailable?: boolean;
}) {
  const run = sync.tree.run, ended = Boolean(sync.conversation?.ended_at), open = sync.status === 'open' && !ended;
  const pending = sync.busy && run?.status === 'running' && Boolean(run.question);
  const failed = !sync.busy && Boolean(run?.question) && ['failed', 'cancelled', 'interrupted'].includes(run?.status || '');
  const question = sending ? draft : pending || failed ? run?.question : null;
  const thinking = pending || sending;
  const stage = sending ? 'Sending your message…' : run?.stage.includes('Planning evidence') ? 'Planning history search…' : run?.stage.includes('Searching') ? 'Searching your prepared history…' : run?.stage.includes('Selecting evidence') ? 'Selecting relevant evidence…' : run?.stage.includes('Checking evidence') ? 'Checking source references…' : run?.stage.includes('Thinking') ? 'Draken is thinking…' : 'Reading the snapshot context…';
  const thread = useRef<HTMLDivElement>(null), bottom = useRef(true);
  useEffect(() => { if (bottom.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight; }, [sync.messages.length, question, thinking, stage]);
  const prepared = Boolean(sync.briefing && sync.tree.complete && (sync.conversation?.history_before || readiness?.ready));
  const sendDisabled = disabled || !open || !prepared;
  return <section className="card text-chat" aria-label="Chat with Draken">
    <header className="chat-heading"><img className="chat-avatar" src="/persona/chat-avatar.webp" alt="Draken" width="52" height="52" />
      <div><h2>Chat with Draken</h2><ConversationInfo state={sync.conversation} unavailable={updatesUnavailable} /></div>
      <button type="button" className="btn btn-ghost" onClick={onVoice}>Voice &amp; call history</button>
    </header>
    <InfoDisclosure label="About chat">
      <p>Ask about your projects, decisions or next steps. Prepared updates are used on your next turn.</p>
      <p>Messages are saved here. Chat does not use your microphone, save decisions or mark work reviewed.</p>
    </InfoDisclosure>
    <div className="chat-thread" ref={thread} onScroll={() => { const element = thread.current; if (element) bottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
      {!sync.messages.length && !question && <div className="chat-welcome"><h3>What would you like to pick up?</h3><p>Ask about your work or what to do next.</p></div>}
      {sync.messages.map(message => <article className={`chat-message ${message.role}`} key={message.id}>
        {message.role === 'assistant' && <img className="chat-avatar" src="/persona/chat-avatar.webp" alt="" width="36" height="36" />}
        <div className="chat-bubble"><div className="chat-author"><strong>{message.role === 'user' ? 'You' : 'Draken'}</strong><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></div><CitedText text={message.content} /></div>
      </article>)}
      {question && !(run?.request_id && (pending || (failed && !sending))) && <article className="chat-message user"><div className="chat-bubble"><strong>You</strong><p className="prose">{question}</p></div></article>}
      {thinking && <div className="chat-message assistant"><img className="chat-avatar" src="/persona/chat-avatar.webp" alt="" width="36" height="36" /><div className="chat-bubble chat-thinking" role="status" aria-label="Chat status" aria-live="polite"><span className="spinner" aria-hidden="true" />{stage}</div></div>}
      {failed && <div className="alert warning" role="alert"><strong>{run?.status === 'failed' ? 'Reply failed.' : 'Reply stopped.'}</strong><p>{run?.error || 'The question is retained. Nothing was marked reviewed.'}</p><button className="btn btn-secondary" disabled={sendDisabled} onClick={() => onSend(run?.question || '')}>Retry chat reply</button></div>}
    </div>
    {open && <>
      {!thinking && !prepared && <p className="small muted" role="status">{sync.busy ? 'Preparing the briefing and history for chat…' : readiness?.briefingReady ? 'Prepare history before sending a message.' : 'Prepare the briefing and history first.'}</p>}
      {readiness?.error && <p role="alert" className="small">{readiness.error}</p>}
      <form className="chat-compose" onSubmit={event => { event.preventDefault(); if (!sendDisabled && draft.trim()) { bottom.current = true; onSend(); } }}>
        <label htmlFor="chat-question" className="sr-only">Message Draken</label>
        <textarea id="chat-question" rows={3} maxLength={4000} value={draft} disabled={sendDisabled} onChange={event => setDraft(event.target.value)} placeholder="Ask Draken…" onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.trim() && !sendDisabled) event.currentTarget.form?.requestSubmit(); }
        }} />
        <div className="chat-compose-footer"><span className="small muted">Enter to send · Shift+Enter for a new line</span>
          {pending ? <button type="button" className="btn btn-secondary" onClick={onCancel}><Square size={14} />Stop reply</button> : <button className="btn btn-primary" disabled={sendDisabled || !draft.trim()}><ArrowUp size={16} />Send message</button>}
        </div>
      </form>
      {readiness?.briefingReady && !readiness.preparing && !thinking && <button className="btn btn-secondary chat-refresh" disabled={disabled} onClick={onPrepareHistory}>{prepared ? 'Refresh history' : 'Prepare history'}</button>}
    </>}
    {!open && <p className="small muted">{ended && sync.status === 'open' ? 'Session ended after 30 minutes without a user message. Your chat is preserved; start a new sync to continue. Nothing was marked reviewed.' : 'This sync is closed. Its chat is preserved; start a new sync to continue.'}</p>}
    {!open && draft.trim() && <div className="chat-compose"><label htmlFor="ended-chat-draft">Unsent message — copy it into a new sync</label><textarea id="ended-chat-draft" rows={3} readOnly value={draft} /></div>}
  </section>;
}
