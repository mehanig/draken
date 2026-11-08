import { useEffect, useRef } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import type { CallReadiness, SyncDetail } from '../types';
import { CitedText } from './EvidenceList';

export function TextChat({ sync, readiness, draft, setDraft, disabled, sending, onSend, onCancel, onPrepareHistory, onVoice }: {
  sync: SyncDetail; readiness: CallReadiness | null; draft: string; setDraft: (text: string) => void;
  disabled: boolean; sending: boolean; onSend: (text?: string) => void; onCancel: () => void;
  onPrepareHistory: () => void; onVoice: () => void;
}) {
  const run = sync.tree.run, open = sync.status === 'open';
  const pending = sync.busy && run?.status === 'running' && Boolean(run.question);
  const failed = !sync.busy && Boolean(run?.question) && ['failed', 'cancelled', 'interrupted'].includes(run?.status || '');
  const question = sending ? draft : pending || failed ? run?.question : null;
  const thinking = pending || sending;
  const stage = sending ? 'Sending your message…' : run?.stage.includes('Searching') ? 'Searching your prepared history…' : run?.stage.includes('Thinking') ? 'Draken is thinking…' : 'Reading the snapshot context…';
  const thread = useRef<HTMLDivElement>(null), bottom = useRef(true);
  useEffect(() => { if (bottom.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight; }, [sync.messages.length, question, thinking, stage]);
  const evidence = [...sync.items, ...sync.context];
  const sendDisabled = disabled || !open || !readiness?.ready;
  return <section className="card text-chat" aria-label="Chat with Draken">
    <header className="chat-heading"><img className="chat-avatar" src="/persona/chat-avatar.webp" alt="Draken" width="52" height="52" />
      <div><h2>Chat with Draken</h2><p className="small muted">Same history. No microphone or audio.</p></div>
      <button type="button" className="btn btn-ghost" onClick={onVoice}>Voice &amp; call history</button>
    </header>
    <div className="chat-thread" ref={thread} onScroll={() => { const element = thread.current; if (element) bottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
      {!sync.messages.length && !question && <div className="chat-welcome"><h3>What would you like to pick up?</h3><p>Ask about a project, a decision, or what still needs your attention. Draken will use the snapshot and prepared original history.</p></div>}
      {sync.messages.map(message => <article className={`chat-message ${message.role}`} key={message.id}>
        {message.role === 'assistant' && <img className="chat-avatar" src="/persona/chat-avatar.webp" alt="" width="36" height="36" />}
        <div className="chat-bubble"><div className="chat-author"><strong>{message.role === 'user' ? 'You' : 'Draken'}</strong><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></div><CitedText text={message.content} evidence={evidence} /></div>
      </article>)}
      {question && !(run?.request_id && (pending || (failed && !sending))) && <article className="chat-message user"><div className="chat-bubble"><strong>You</strong><p className="prose">{question}</p></div></article>}
      {thinking && <div className="chat-message assistant"><img className="chat-avatar" src="/persona/chat-avatar.webp" alt="" width="36" height="36" /><div className="chat-bubble chat-thinking" role="status" aria-label="Chat status" aria-live="polite"><span className="spinner" aria-hidden="true" />{stage}<span className="small muted">Your answer will appear here when it’s ready.</span></div></div>}
      {failed && <div className="alert warning" role="alert"><strong>{run?.status === 'failed' ? 'Reply failed.' : 'Reply stopped.'}</strong><p>{run?.error || 'The question is retained. Nothing was marked reviewed.'}</p><button className="btn btn-secondary" disabled={sendDisabled} onClick={() => onSend(run?.question || '')}>Retry chat reply</button></div>}
    </div>
    {open && <>
      {!thinking && <p className="small muted" role="status">{readiness?.ready ? `History cutoff: ${readiness.before ? new Date(readiness.before).toLocaleString() : 'prepared snapshot'}. Refresh for later work.` : sync.busy ? 'Preparing the briefing and history for chat…' : readiness?.briefingReady ? 'Prepare history before sending a message.' : 'Prepare the briefing and history first.'}</p>}
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
      {readiness?.briefingReady && !readiness.preparing && !thinking && <button className="btn btn-secondary chat-refresh" disabled={disabled} onClick={onPrepareHistory}>{readiness.ready ? 'Refresh history' : 'Prepare history'}</button>}
    </>}
    {!open && <p className="small muted">This sync is closed. Its chat is preserved; start a new sync to continue.</p>}
    <p className="small muted chat-boundary">Messages stay with this sync. Calls remain in call history. Chatting never marks anything reviewed or saves decisions for you.</p>
  </section>;
}
