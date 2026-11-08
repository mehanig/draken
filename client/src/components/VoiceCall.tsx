import { useEffect, useRef, useState } from 'react';
import { AudioLines, ArrowUp, ExternalLink, Headphones, Keyboard, MessageSquare, Mic, MicOff, Phone, PhoneOff, Square, X } from 'lucide-react';
import type { CallReadiness, SyncDetail } from '../types';
import { CitedText } from './EvidenceList';
import { HistorySource } from '../pages/History';
import { HistoryProgress } from './HistoryProgress';
import { VoiceCaptions } from './VoiceCaptions';
import { PersonaStage } from '../persona/PersonaStage';
import type { PlaybackCue } from '../audio/playback';
import { LiveVoiceSession } from '../voice/live-session';
import { INITIAL_CALL, voiceRequest, voiceHeaders, type CallState, type CallHistory, type VoiceStatus } from '../voice/api';

const labels = {
  connecting: 'Getting ready', listening: 'Your turn', hearing: 'Listening to you',
  thinking: 'Preparing your answer', speaking: 'Draken is speaking', paused: 'Sound paused', ended: 'Call ended',
};
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function VoiceCall({ sync, readiness, onPrepareHistory, disabled, beforeStart, onActiveChange, onClosed, onChat, autoStart = false, onAutoStartHandled }: {
  sync: SyncDetail; readiness: CallReadiness | null; onPrepareHistory: () => void; disabled: boolean; beforeStart: () => Promise<void>;
  onActiveChange: (active: boolean) => void; onClosed: () => Promise<void>; onChat: () => void;
  autoStart?: boolean; onAutoStartHandled?: () => void;
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
  const [showDetails, setShowDetails] = useState(false);
  const [historyLookup, setHistoryLookup] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const detailsPane = useRef<HTMLDivElement>(null);
  const sourcePanel = useRef<HTMLElement>(null);
  const playback = useRef<PlaybackCue | null>(null);
  const session = useRef<LiveVoiceSession | null>(null);
  const mounted = useRef(true);
  const closing = useRef(false), starting = useRef(false);
  const [checking, setChecking] = useState(false);
  const evidence = [...sync.items, ...sync.context];
  const selected = evidence.find(item => item.ref === source);
  const prepared = readiness?.ready === true;
  const secure = window.isSecureContext;
  const httpsUrl = new URL(window.location.href);
  httpsUrl.protocol = 'https:'; httpsUrl.port = String(status?.httpsPort || 443);

  useEffect(() => {
    if (source && detailsPane.current && sourcePanel.current) {
      detailsPane.current.scrollTop += sourcePanel.current.getBoundingClientRect().top - detailsPane.current.getBoundingClientRect().top;
    }
  }, [source]);

  const refreshStatus = async () => {
    try { const value = await voiceRequest<VoiceStatus>('/status'); if (mounted.current) { setStatus(value); setSetupError(''); } }
    catch (error) { if (mounted.current) setSetupError(error instanceof Error ? error.message : 'Could not check ChatGPT voice'); }
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
    if (session.current || closing.current || starting.current || !prepared) return;
    starting.current = true; setChecking(true); setSetupError('');
    try {
      await beforeStart();
      if (!mounted.current || document.visibilityState !== 'visible') return;
      setCall({ ...INITIAL_CALL }); setElapsed(0); setTranscript([]); setDraft(''); setSource(''); setTyping(false); setShowDetails(false); setHistoryLookup(false); setOpen(true); onActiveChange(true);
      const controller = new LiveVoiceSession({
        onState: state => { if (mounted.current) { setCall(state); if (!state.microphone && state.muted) setTyping(true); } },
        onLevel: () => {}, // Captions replace the old standalone input meter.
        onPlayback: cue => { playback.current = cue; },
        onTurn: (question, answer, refs, id) => {
          if (mounted.current) setTranscript(old => old.some(turn => turn.id === id)
            ? old.map(turn => turn.id === id ? { id, question, answer, refs } : turn)
            : [...old, { id, question, answer, refs }]);
        },
      });
      session.current = controller;
      if (session.current === controller) await controller.start(sync.id);
    } catch (error) {
      await session.current?.end();
      if (mounted.current) {
        const message = error instanceof Error ? error.message : 'The call could not start';
        setSetupError(message);
        if (session.current) setCall(old => ({ ...old, phase: 'ended', error: message }));
      }
    } finally { starting.current = false; if (mounted.current) setChecking(false); }
  };
  useEffect(() => {
    if (!autoStart || disabled || !prepared || !status) return;
    onAutoStartHandled?.();
    if (status.installed && !status.activeCall && secure && document.visibilityState === 'visible') void start();
    else setSetupError('Your snapshot is ready. Start the call explicitly when audio is available and this page is visible.');
  }, [autoStart, disabled, prepared, status]);

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
        <div><h2>Talk it through. Out loud.</h2><p className="muted small">Live voice through ChatGPT. Audio goes to OpenAI; replies may paraphrase.</p></div>
        <div className="conversation-actions"><button className="btn btn-secondary" disabled={open || checking} onClick={onChat}><MessageSquare size={16} />Chat instead</button>
        {!secure && status?.httpsPort ? <a className="btn btn-primary" href={httpsUrl.href}>Open secure call page <ExternalLink size={15} /></a> :
          <button className="btn btn-primary" disabled={disabled || checking || !prepared || !status?.installed || Boolean(status?.activeCall) || !secure} onClick={() => void start()}><Phone size={16} />Call Draken</button>}</div>
      </div>
      <p className="small muted">Relevant earlier history is found automatically. Retrieved excerpts go to ChatGPT, separately from this frozen snapshot; no review or saved decisions change.</p>
      {!secure && <p className="small muted">The microphone needs trusted HTTPS. {status?.httpsPort ? 'The secure page uses your existing dashboard login. Install the local certificate once on this device before opening it.' : 'Use localhost, or enable HTTPS on the server.'}</p>}
      {status?.certificateAvailable && <details className="voice-history"><summary>First-time browser setup</summary>
        <p className="small">Trust only your own Draken server’s certificate. This is a one-time device setup, not another account or voice subscription.</p>
        <button className="btn btn-secondary" onClick={() => void downloadCertificate()}>Download local certificate</button>
        <ul className="small"><li><strong>Windows:</strong> open the downloaded certificate → Install Certificate → Current User → place in Trusted Root Certification Authorities.</li>
          <li><strong>macOS:</strong> import into Keychain Access → login keychain. Open its Trust section and choose Always Trust.</li>
          <li><strong>Firefox/Linux:</strong> Settings → Privacy &amp; Security → Certificates → View Certificates → Authorities → Import. Trust it to identify websites.</li></ul>
        <p className="small muted">Restart the browser if needed, open the secure page, sign in, and allow the microphone when you start a call. Keep the server’s private keys private. See <code>VOICE.md</code> for an SSH-tunnel alternative.</p>
      </details>}
      {sync.status === 'open' && <p className="small muted" role="status">{prepared ? `Ready to call. History cutoff: ${readiness?.before ? new Date(readiness.before).toLocaleString() : 'prepared snapshot'}. Refresh history for later work.` : !readiness ? 'Checking call readiness…' : readiness.preparing ? 'Preparing history before calling. Your microphone is off.' : !readiness.briefingReady ? 'Prepare the briefing first.' : 'History needs preparation before you can call.'}</p>}
      {sync.status === 'open' && readiness?.briefingReady && !readiness.preparing && <button className="btn btn-secondary" disabled={disabled || checking} onClick={onPrepareHistory}>{prepared ? 'Refresh history' : 'Prepare history'}</button>}
      {readiness?.error && !prepared && <p className="small" role="alert">{readiness.error}</p>}
      {sync.status !== 'open' && <p className="small muted">This sync is closed. Start a new sync for another call.</p>}
      {status && !status.installed && <p className="small muted">ChatGPT voice needs server setup and sign-in: <code>npm run voice:realtime:setup</code>, then <code>npm run voice:realtime:login</code>.</p>}
      {setupError && <p className="small" role="alert">{setupError} <button className="btn btn-secondary" onClick={() => void refreshStatus()}>Retry</button></p>}
      {status?.activeCall && !open && <div className="small voice-reconnect">A call is still open in another tab or device.
        <button className="btn btn-secondary" disabled={disabled} onClick={() => {
          if (window.confirm('End the existing voice call? Its completed transcript is kept.'))
            void voiceRequest(`/live/calls/${status.activeCall!.id}/end`, { method: 'POST', body: '{}' }).then(refreshStatus).catch(error => setSetupError(error.message));
        }}>End previous call</button></div>}
      <details className="voice-history" onToggle={event => { if (event.currentTarget.open) void loadHistory(); }}>
        <summary>Call history</summary>
        {history?.length === 0 && <p className="muted small">No calls yet. Transcripts are saved here; raw audio is not recorded.</p>}
        {history?.map(item => <details key={item.id} className="voice-history-call"><summary>{new Date(item.started_at).toLocaleString()} · {item.turns.length} {item.mode === 'native' ? 'messages' : 'turns'} · {item.status}</summary>
          <p className="small muted">{item.end_reason || 'Call in progress'}</p>
          {item.mode === 'native' ? <p className="small muted">Ordered live transcripts, not verified question–answer pairs. Sources are supplied context, not verified citations. Exact playback is not confirmed.</p> : <p className="small muted">Historical call from the retired local speech engine. These records are preserved; this engine cannot start new calls.</p>}
          {item.turns.map(turn => <div className="voice-history-turn" key={turn.id}>
            {turn.question && <><strong className="message-author">You</strong><p className="prose">{turn.question}</p></>}
            {(turn.answer || !turn.question || item.mode !== 'native') && <><strong className="message-author">Draken · {turn.status}</strong>
            <CitedText text={`${turn.answer || turn.error || 'No reply generated.'} ${JSON.parse(turn.evidence_json).map((ref: string) => `[${ref}]`).join(' ')}`} evidence={evidence} />
            {turn.status !== 'completed' && <p className="small muted">Generated text is shown above. {turn.heard_text ? `Confirmed played: ${turn.heard_text}` : 'Playback was not confirmed.'}</p>}</>}
          </div>)}
        </details>)}
      </details>
    </section>

    <dialog ref={dialog} className="voice-dialog" aria-labelledby="voice-title" onCancel={event => { event.preventDefault(); void close(); }}>
      <div className="voice-dialog-header"><div><span className="eyebrow">DRAKEN / VOICE SYNC</span><h2 id="voice-title">Sync #{sync.id}</h2></div>
        <span className="voice-clock" aria-label="Call duration">{clock(elapsed)}</span>
        <button className="icon-button" aria-label="Close call" onClick={() => void close()}><X size={18} /></button>
      </div>
      <div className="voice-call-body">
        {!call.historyReady ? <section className="voice-preparation" aria-label="Call preparation">
          <h3>{call.phase === 'ended' ? 'Call could not start' : 'Connecting your call'}</h3>
          <p className="small muted">Your microphone is off until the call is ready.</p>
        </section> : <div className="voice-scene">{open && call.phase !== 'ended' ? <PersonaStage playback={playback}
          mode={call.phase === 'speaking' ? 'speaking' : call.phase === 'hearing' ? 'listening' : call.replyPendingSince && !call.error ? 'thinking' : 'idle'} />
          : <img loading="lazy" className="voice-scene-poster" src="/persona/call-poster.webp" alt="Draken’s workshop" />}
          <VoiceCaptions call={call} historyLookup={historyLookup} />
        </div>}
        <p className="sr-only" role="status" aria-label="Call state" aria-live="polite">{call.muted && call.phase === 'listening' ? 'Microphone muted' : labels[call.phase]}</p>
      </div>
      {call.error && <div className="alert error" role="alert">{call.error}</div>}
      {call.error && call.question && call.phase === 'listening' && <button className="btn btn-primary" onClick={() => void session.current?.sendText(call.question)}>Retry question</button>}
      {call.phase === 'paused' && <button className="btn btn-primary" onClick={() => void session.current?.resumeSound()}>Resume sound</button>}
      <div className="voice-controls">
        <button className={`btn btn-secondary ${call.muted ? 'is-muted' : ''}`} disabled={call.phase === 'connecting' || call.phase === 'ended'} onClick={() => void session.current?.toggleMute()}>{call.muted ? <MicOff size={18} /> : <Mic size={18} />}{call.muted ? call.microphone ? 'Unmute' : 'Enable mic' : 'Mute'}</button>
        <button className="btn btn-secondary" disabled={!['thinking', 'speaking', 'paused'].includes(call.phase)} onClick={() => void session.current?.interrupt().catch(() => {})}><Square size={15} />Stop reply</button>
        <button className="btn btn-danger" onClick={() => void close()}><PhoneOff size={18} />{call.phase === 'ended' ? 'Close' : 'End call'}</button>
      </div>
      <div className="voice-options">
      <button className="voice-keyboard-toggle" aria-pressed={call.voiceInterruption} disabled={call.phase === 'connecting' || call.phase === 'ended'} onClick={() => session.current?.setVoiceInterruption(!call.voiceInterruption)}><Headphones size={16} />Headphone mode</button>
      <button className="voice-keyboard-toggle" onClick={() => setTyping(value => !value)} aria-expanded={typing}><Keyboard size={16} />{typing ? 'Hide keyboard' : 'Type a question'}</button>
      </div>
      {typing && <form className="voice-compose" onSubmit={event => { event.preventDefault(); send(); }}>
        <input className="input" aria-label="Type a question for this call" placeholder="Or ask here…" maxLength={2000} disabled={call.phase === 'connecting' || call.phase === 'ended'} value={draft} onChange={event => setDraft(event.target.value)} />
        <button className="btn btn-primary" aria-label="Send voice-call question" disabled={!draft.trim() || call.phase === 'connecting' || call.phase === 'ended'}><ArrowUp size={18} /></button>
      </form>}
      <details className="voice-conversation" open={showDetails} onToggle={event => setShowDetails(event.currentTarget.open)}>
        <summary>Conversation &amp; details</summary>
        <div className="voice-call-details" ref={detailsPane}>
          {call.notice && <p className="small muted voice-notice">{call.notice}</p>}
          <HistoryProgress enabled={open && call.historyReady && (Boolean(call.replyPendingSince) || ['connecting', 'thinking'].includes(call.phase))} onLookupChange={setHistoryLookup} />
          <p className="small muted">{call.phase === 'speaking' ? call.voiceInterruption ? 'Speak to interrupt. Use headphones to avoid speaker feedback.' : 'Listening pauses during replies to prevent echo. Tap Stop reply to speak.' : 'Speak naturally. A short pause sends your question.'}</p>
          <div className="voice-transcript">{transcript.map(turn => <div key={turn.id}>
            {turn.question && <><strong>You</strong><p>{turn.question}</p></>}
            {turn.answer && <><strong>Draken · generated reply</strong><p className={turn.id === call.turnId ? 'voice-answer' : undefined}>{turn.answer}</p></>}
          </div>)}</div>
          {!transcript.length && <p className="small muted">No transcript yet.</p>}
          <p className="small muted">Live generated transcripts, not word-timed subtitles. Exact playback and agreement are not confirmed. Full text is retained here even when the scene shows only its latest lines.</p>
          {call.evidence.length > 0 && <details className="voice-history"><summary>Sources supplied ({call.evidence.length})</summary><p className="small muted">Context available to the voice model, not verified citations for every spoken claim.</p><div className="voice-sources">{call.evidence.map(ref => <button className="citation" key={ref} onClick={event => { const list = event.currentTarget.closest('details'); if (list) list.open = false; setSource(source === ref ? '' : ref); }}>{ref.startsWith('H') ? `History ${ref.slice(-6)}` : `Source ${ref}`}</button>)}</div></details>}
          {/^H[a-f0-9]{24}$/.test(source) && <section className="voice-source" ref={sourcePanel}><button className="btn btn-secondary" onClick={() => setSource('')}>Close historical source</button><HistorySource reference={source} /></section>}
          {selected && <section className="voice-source" ref={sourcePanel}><div className="section-heading"><strong>{selected.ref} · {selected.session_name || selected.cwd}</strong><button className="icon-button" aria-label="Close source" onClick={() => setSource('')}><X size={16} /></button></div><pre>{selected.text}</pre></section>}
        </div>
      </details>
      <div className="voice-footer"><AudioLines size={14} /><span>Experimental live audio to OpenAI · Generated, not verified · 30-minute limit</span></div>
    </dialog>
  </>;
}
