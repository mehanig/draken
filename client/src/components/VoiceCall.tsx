import { useEffect, useRef, useState } from 'react';
import { AudioLines, ArrowUp, ExternalLink, Headphones, Keyboard, Mic, MicOff, Phone, PhoneOff, Square, X } from 'lucide-react';
import type { SyncDetail } from '../types';
import { CitedText } from './EvidenceList';
import { INITIAL_CALL, VoiceSession, voiceRequest, voiceHeaders, type CallState, type CallHistory, type VoiceStatus } from '../voice/session';

const labels = {
  connecting: 'Getting ready', listening: 'Your turn', hearing: 'Listening to you', transcribing: 'Hearing you',
  thinking: 'Thinking it through', speaking: 'Draken is speaking', paused: 'Sound paused', ended: 'Call ended',
};
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function VoiceCall({ sync, disabled, beforeStart, onActiveChange, onClosed }: {
  sync: SyncDetail; disabled: boolean; beforeStart: () => Promise<void>;
  onActiveChange: (active: boolean) => void; onClosed: () => Promise<void>;
}) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [setupError, setSetupError] = useState('');
  const [open, setOpen] = useState(false);
  const [call, setCall] = useState<CallState>(INITIAL_CALL);
  const [elapsed, setElapsed] = useState(0);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [transcript, setTranscript] = useState<{ id: number; question: string; answer: string; refs: string[] }[]>([]);
  const [history, setHistory] = useState<CallHistory[] | null>(null);
  const [source, setSource] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const meter = useRef<HTMLDivElement>(null);
  const session = useRef<VoiceSession | null>(null);
  const mounted = useRef(true);
  const closing = useRef(false);
  const evidence = [...sync.items, ...sync.context];
  const selected = evidence.find(item => item.ref === source);
  const prepared = sync.status === 'open' && (sync.tree.complete || !sync.items.length);
  const secure = window.isSecureContext;
  const httpsUrl = new URL('/', window.location.href);
  httpsUrl.protocol = 'https:'; httpsUrl.port = String(status?.httpsPort || 443);

  const refreshStatus = async () => {
    try { const value = await voiceRequest<VoiceStatus>('/status'); if (mounted.current) { setStatus(value); setSetupError(''); } }
    catch (error) { if (mounted.current) setSetupError(error instanceof Error ? error.message : 'Could not check local audio'); }
  };
  useEffect(() => {
    mounted.current = true; void refreshStatus();
    const timer = setInterval(() => { if (!session.current) void refreshStatus(); }, 15000);
    return () => { clearInterval(timer); mounted.current = false; void session.current?.end(); };
  }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open) dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!open || !call.startedAt || call.phase === 'ended') return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000)));
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [open, call.startedAt, call.phase === 'ended']);

  const start = async () => {
    if (session.current || closing.current) return;
    setCall({ ...INITIAL_CALL }); setElapsed(0); setTranscript([]); setDraft(''); setSource(''); setTyping(false); setOpen(true); onActiveChange(true);
    try {
      const controller = new VoiceSession({
        onState: state => { if (mounted.current) { setCall(state); if (!state.microphone && state.muted) setTyping(true); } },
        onLevel: level => { meter.current?.style.setProperty('--voice-level', String(level)); },
        onTurn: (question, answer, refs, id) => {
          if (mounted.current) setTranscript(old => old.some(turn => turn.id === id)
            ? old.map(turn => turn.id === id ? { id, question, answer, refs } : turn)
            : [...old, { id, question, answer, refs }]);
        },
      });
      session.current = controller;
      await beforeStart();
      if (session.current === controller) await controller.start(sync.id);
    } catch (error) {
      await session.current?.end();
      if (mounted.current) setCall(old => ({ ...old, phase: 'ended', error: error instanceof Error ? error.message : 'The call could not start' }));
    }
  };
  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    await session.current?.end(); session.current = null;
    if (mounted.current) { setOpen(false); setHistory(null); onActiveChange(false); }
    try { await onClosed(); await refreshStatus(); }
    finally { closing.current = false; }
  };
  const loadHistory = async () => {
    try { setHistory(await voiceRequest<CallHistory[]>(`/syncs/${sync.id}/history`)); }
    catch (error) { setSetupError(error instanceof Error ? error.message : 'Could not load call history'); }
  };
  const downloadCertificate = async () => {
    try {
      const response = await fetch('/api/voice/certificate', { headers: voiceHeaders(false) });
      if (!response.ok) throw new Error('Could not download the local certificate. Check your dashboard login.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'draken-local-root.crt'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setSetupError(error instanceof Error ? error.message : 'Certificate download failed'); }
  };
  const send = () => {
    if (!draft.trim()) return;
    const text = draft.trim(); setDraft(''); void session.current?.sendText(text);
  };

  return <>
    <section className="card voice-entry" aria-label="Voice calls">
      <div className="voice-entry-main">
        <div className="voice-entry-icon" aria-hidden="true"><Phone size={22} /></div>
        <div><h2>Talk it through. Out loud.</h2><p className="muted small">Local audio. Your existing pi login. No separate voice API.</p></div>
        {!secure && status?.httpsPort ? <a className="btn btn-primary" href={httpsUrl.href}>Open secure call page <ExternalLink size={15} /></a> :
          <button className="btn btn-primary" disabled={disabled || !prepared || !status?.installed || Boolean(status?.activeCall) || !secure} onClick={() => void start()}><Phone size={16} />Call Draken</button>}
      </div>
      {!secure && <p className="small muted">The microphone needs trusted HTTPS. {status?.httpsPort ? 'The secure page uses your existing dashboard login. Install the local certificate once on this device before opening it.' : 'Use localhost, or enable HTTPS on the server.'}</p>}
      {status?.certificateAvailable && <details className="voice-history"><summary>First-time browser setup</summary>
        <p className="small">Trust only your own Draken server’s certificate. This is a one-time device setup, not another account or voice subscription.</p>
        <button className="btn btn-secondary" onClick={() => void downloadCertificate()}>Download local certificate</button>
        <ul className="small"><li><strong>Windows:</strong> open the downloaded certificate → Install Certificate → Current User → place in Trusted Root Certification Authorities.</li>
          <li><strong>macOS:</strong> import into Keychain Access → login keychain. Open its Trust section and choose Always Trust.</li>
          <li><strong>Firefox/Linux:</strong> Settings → Privacy &amp; Security → Certificates → View Certificates → Authorities → Import. Trust it to identify websites.</li></ul>
        <p className="small muted">Restart the browser if needed, open the secure page, sign in, and allow the microphone when you start a call. Keep the server’s private keys private. See <code>VOICE.md</code> for an SSH-tunnel alternative.</p>
      </details>}
      {sync.status === 'open' && !prepared && <p className="small muted">Prepare the briefing first so the call starts with the full picture.</p>}
      {sync.status !== 'open' && <p className="small muted">This sync is closed. Start a new sync for another call.</p>}
      {status && !status.installed && <p className="small muted">Local speech models are not installed yet. On the server, run <code>npm run voice:setup</code>.</p>}
      {setupError && <p className="small" role="alert">{setupError} <button className="btn btn-secondary" onClick={() => void refreshStatus()}>Retry</button></p>}
      {status?.activeCall && !open && <div className="small voice-reconnect">A call is still open in another tab or device.
        <button className="btn btn-secondary" disabled={disabled} onClick={() => {
          if (window.confirm('End the existing voice call? Its completed transcript is kept.'))
            void voiceRequest(`/calls/${status.activeCall!.id}/end`, 'POST', {}).then(refreshStatus).catch(error => setSetupError(error.message));
        }}>End previous call</button></div>}
      <details className="voice-history" onToggle={event => { if (event.currentTarget.open) void loadHistory(); }}>
        <summary>Call history</summary>
        {history?.length === 0 && <p className="muted small">No calls yet. Transcripts are saved here; raw audio is not recorded.</p>}
        {history?.map(item => <details key={item.id} className="voice-history-call"><summary>{new Date(item.started_at).toLocaleString()} · {item.turns.length} turns · {item.status}</summary>
          <p className="small muted">{item.end_reason || 'Call in progress'}</p>
          {item.turns.map(turn => <div className="voice-history-turn" key={turn.id}><strong className="message-author">You</strong><p className="prose">{turn.question}</p>
            <strong className="message-author">Draken · {turn.status}</strong>
            <CitedText text={`${turn.answer || turn.error || 'No reply generated.'} ${JSON.parse(turn.evidence_json).map((ref: string) => `[${ref}]`).join(' ')}`} evidence={evidence} />
            {turn.status !== 'completed' && <p className="small muted">Generated text is shown above. {turn.heard_text ? `Confirmed played: ${turn.heard_text}` : 'Playback was not confirmed.'}</p>}
          </div>)}
        </details>)}
      </details>
    </section>

    <dialog ref={dialog} className="voice-dialog" aria-labelledby="voice-title" onCancel={event => { event.preventDefault(); void close(); }}>
      <div className="voice-dialog-header"><div><span className="eyebrow">DRAKEN / VOICE SYNC</span><h2 id="voice-title">Sync #{sync.id}</h2></div>
        <span className="voice-clock" aria-label="Call duration">{clock(elapsed)}</span>
        <button className="icon-button" aria-label="Close call" onClick={() => void close()}><X size={18} /></button>
      </div>
      <div className={`voice-stage phase-${call.phase}`}>
        <div className="voice-signal" ref={meter} aria-hidden="true"><span /><span /><span /><span /><span /></div>
        <h3 role="status" aria-live="polite">{call.muted && call.phase === 'listening' ? 'Microphone muted' : labels[call.phase]}</h3>
        {call.question && <p className="voice-heard"><span>You</span> {call.question}</p>}
        <p className="voice-answer">{call.answer || (call.phase === 'connecting' ? 'Preparing local speech. Your microphone is only used for this call.' : call.phase === 'ended' ? 'Your call transcript stays with this sync.' : call.error ? 'Retry this question, or ask another. The call is still open.' : call.phase === 'thinking' ? 'Preparing your reply…' : 'Ask about progress, blockers, or what to do next.')}</p>
        {call.evidence.length > 0 && <div className="voice-sources">{call.evidence.map(ref => <button className="citation" key={ref} onClick={() => setSource(source === ref ? '' : ref)}>Source {ref}</button>)}</div>}
      </div>
      {call.notice && <p className="small muted voice-notice">{call.notice}</p>}
      {call.error && <div className="alert error" role="alert">{call.error}</div>}
      {call.error && call.question && call.phase === 'listening' && <button className="btn btn-primary" onClick={() => void session.current?.sendText(call.question)}>Retry question</button>}
      {call.phase === 'paused' && <button className="btn btn-primary" onClick={() => void session.current?.resumeSound()}>Resume sound</button>}
      {selected && <section className="voice-source"><div className="section-heading"><strong>{selected.ref} · {selected.session_name || selected.cwd}</strong><button className="icon-button" aria-label="Close source" onClick={() => setSource('')}><X size={16} /></button></div><pre>{selected.text}</pre></section>}
      <div className="voice-controls">
        <button className={`btn btn-secondary ${call.muted ? 'is-muted' : ''}`} disabled={call.phase === 'connecting' || call.phase === 'ended'} onClick={() => void session.current?.toggleMute()}>{call.muted ? <MicOff size={18} /> : <Mic size={18} />}{call.muted ? call.microphone ? 'Unmute' : 'Enable mic' : 'Mute'}</button>
        <button className="btn btn-secondary" disabled={!['thinking', 'transcribing', 'speaking', 'paused'].includes(call.phase)} onClick={() => void session.current?.interrupt().catch(() => {})}><Square size={15} />Stop reply</button>
        <button className="btn btn-danger" onClick={() => void close()}><PhoneOff size={18} />{call.phase === 'ended' ? 'Close' : 'End call'}</button>
      </div>
      <p className="voice-hint small muted">{call.phase === 'speaking' ? call.voiceInterruption ? 'Speak to interrupt. Use headphones to avoid speaker feedback.' : 'Listening pauses during replies to prevent echo. Tap Stop reply to speak.' : 'Speak naturally. A short pause sends your question.'}</p>
      <button className="voice-keyboard-toggle" aria-pressed={call.voiceInterruption} disabled={call.phase === 'connecting' || call.phase === 'ended'} onClick={() => session.current?.setVoiceInterruption(!call.voiceInterruption)}><Headphones size={16} />Headphone mode</button>
      <button className="voice-keyboard-toggle" onClick={() => setTyping(value => !value)} aria-expanded={typing}><Keyboard size={16} />{typing ? 'Hide keyboard' : 'Type a question'}</button>
      {typing && <form className="voice-compose" onSubmit={event => { event.preventDefault(); send(); }}>
        <input className="input" aria-label="Type a question for this call" placeholder="Or ask here…" maxLength={4000} disabled={call.phase === 'connecting' || call.phase === 'ended'} value={draft} onChange={event => setDraft(event.target.value)} />
        <button className="btn btn-primary" aria-label="Send voice-call question" disabled={!draft.trim() || call.phase === 'connecting' || call.phase === 'ended'}><ArrowUp size={18} /></button>
      </form>}
      {transcript.length > 0 && <details className="voice-transcript"><summary>Conversation text</summary>{transcript.map((turn, index) => <div key={index}><strong>You</strong><p>{turn.question}</p><strong>Draken · generated reply</strong><p>{turn.answer}</p></div>)}<p className="small muted">Interrupted replies may not have played in full. Call history records playback confirmations.</p></details>}
      <div className="voice-footer"><AudioLines size={14} /><span>Local audio · English prototype · Text uses pi · 30-minute call limit</span></div>
    </dialog>
  </>;
}
