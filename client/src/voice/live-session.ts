import { VoicePeer } from '../../../voice/realtime/peer.mjs';
import { INITIAL_CALL, voiceRequest } from './api';
import type { CallState, CallOptions } from './api';

/** One persistent cloud-audio peer. No local STT/TTS and no per-question pi process. */
export class LiveVoiceSession {
  private state: CallState = { ...INITIAL_CALL, phase: 'connecting' };
  private alive = true;
  private id = '';
  private pageExit = () => { void this.end(); };
  private peer: VoicePeer;
  private life = new AbortController();
  private inputContext = new AudioContext();
  private inputMeter = this.inputContext.createAnalyser();
  private inputSource?: MediaStreamAudioSourceNode;
  private input?: MediaStream;
  private changing = false;
  private cursor = 0;
  private timer = 0;
  private speechAt = 0;
  private providerDone = true;
  private stopped = false;
  private newQuestion = false;
  private pendingAnswer = false;
  private answerSettled = false;
  private awaitingUser = false;
  private userId = 0;
  private inputEpoch = 0;
  private readonly pendingNotice = 'Preparing the answer. I’ll continue automatically.';
  private assistantId: number | null = null;
  private observed = 0;
  private reportedAt = 0;
  private micBuffer = new Float32Array(1024);
  constructor(private options: CallOptions) {
    window.addEventListener('pagehide', this.pageExit);
    this.inputMeter.fftSize = 1024;
    void this.inputContext.resume().catch(() => {});
    this.peer = new VoicePeer({ onEvent: event => this.providerEvent(event), onClose: reason => { if (this.alive) { this.set({ error: reason }); void this.end(); } } });
    this.set({});
  }
  private set(change: Partial<CallState>) { this.state = { ...this.state, ...change }; this.options.onState(this.state); }
  private async request<T>(suffix: string, body?: object): Promise<T> {
    return voiceRequest<T>(`/live/calls/${this.id}${suffix}`, { method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}), signal: this.life.signal });
  }
  private async microphone() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (!this.alive) { stream.getTracks().forEach(track => track.stop()); throw new Error('Call ended'); }
    this.inputSource?.disconnect(); this.inputSource = this.inputContext.createMediaStreamSource(stream); this.inputSource.connect(this.inputMeter);
    this.input = stream; this.set({ microphone: true });
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
      if (this.alive && !this.state.muted && this.input === stream) { this.set({ muted: true, microphone: false, notice: 'Microphone disconnected. Type, or turn the microphone on again.' }); this.peer.stopInput(); }
    });
    return stream;
  }
  private silentInput() {
    const destination = this.inputContext.createMediaStreamDestination();
    const source = this.inputContext.createConstantSource(); source.offset.value = 0; source.connect(destination); source.start();
    return destination.stream;
  }
  async start(syncId: number) {
    try {
      if (!this.alive) return;
      this.set({ notice: 'Connecting your call. Your microphone is still off.' });
      // The server only accepts already-prepared history. A stale readiness
      // check fails without starting indexing, a provider session or capture.
      // Own the cancellation identity BEFORE sending creation. Aborting a fetch
      // may discard an already-committed response, including its server ID.
      this.id = crypto.randomUUID();
      const call = await voiceRequest<{ id: string; startedAt: number }>('/live/calls', { method: 'POST', body: JSON.stringify({ syncId, requestId: this.id }), signal: this.life.signal });
      if (call.id !== this.id) throw new Error('The call reservation identity did not match.');
      if (!this.alive) { void voiceRequest(`/live/calls/${this.id}/end`, { method: 'POST', keepalive: true }).catch(() => {}); return; }
      if (document.visibilityState !== 'visible') throw new Error('History is ready. Return to this page and start the call again to enable the microphone.');
      this.set({ historyReady: true, startedAt: call.startedAt, notice: 'History is ready. Waiting for microphone permission…' });
      // Keep the prepared reservation alive while the permission dialog is open.
      void this.poll();
      let input: MediaStream;
      try { input = await this.microphone(); this.set({ notice: '' }); }
      catch { if (!this.alive) return; input = this.silentInput(); this.set({ muted: true, notice: 'Microphone unavailable. You can type instead.' }); }
      this.input = input;
      await this.peer.open(input, async (sdp, signal) => (await voiceRequest<{ sdp: string }>(`/live/calls/${call.id}/connect`, { method: 'POST', body: JSON.stringify({ sdp }), signal })).sdp);
      if (!this.alive) return;
      try { this.options.onPlayback?.({ text: '', samples: new Float32Array(0), sampleRate: 0, duration: Infinity, startedAt: 0, now: () => this.peer.clock, level: () => this.peer.level }); } catch { /* Visual observer cannot own the call. */ }
      this.set({ phase: this.state.replyPendingSince ? 'thinking' : 'listening' }); this.timer = window.setInterval(() => this.meter(), 80);
    } catch (error) {
      if (this.alive) { this.set({ error: error instanceof Error ? error.message : 'Live voice could not start' }); await this.end(); }
    }
  }
  private providerEvent(event: Record<string, any>) {
    if (!this.alive) return;
    // WebRTC user events have no server question ID and can arrive after the
    // polled final transcript/pending state. They cannot own or reset waiting.
    if (event.type === 'input_transcript.added' && this.stopped && this.newQuestion) {
      this.stopped = false; this.peer.muteOutput(false); this.set({ notice: '' });
    }
    if (event.type === 'turn.created' && event.turn?.role === 'assistant') {
      if (this.stopped && this.newQuestion) { this.stopped = false; this.newQuestion = false; this.peer.muteOutput(false); }
      this.providerDone = false;
    }
    if (event.type === 'output_transcript.added' && !this.stopped) {
      this.providerDone = false;
      if (!this.state.voiceInterruption) this.peer.gateInput(false);
    }
    if (event.type === 'turn.done' && event.turn?.role === 'assistant') this.providerDone = true;
  }
  private meter() {
    if (!this.alive) return;
    const now = performance.now(), output = this.peer.level;
    let input = 0;
    if (!this.state.muted) { this.inputMeter.getFloatTimeDomainData(this.micBuffer); input = Math.sqrt(this.micBuffer.reduce((sum, sample) => sum + sample * sample, 0) / this.micBuffer.length) * 10; }
    if (this.stopped && input > 0.08) this.newQuestion = true;
    if (output > 0.02) {
      this.speechAt = now; this.observed += 80;
      if (this.state.phase !== 'speaking') this.set({ phase: 'speaking' });
      if (!this.state.voiceInterruption) this.peer.gateInput(false);
      if (this.assistantId && now - this.reportedAt > 1000) {
        this.reportedAt = now; void this.request('/observed', { messageId: this.assistantId, milliseconds: this.observed }).catch(() => {});
      }
    } else if ((this.providerDone || this.pendingAnswer || this.answerSettled) && now - this.speechAt > 400 && this.state.phase === 'speaking') {
      // A spoken acknowledgement can go silent without a provider turn.done.
      // Owned reply state remains visible independently of those transport events.
      this.set({ phase: this.state.replyPendingSince ? 'thinking' : 'listening' }); this.peer.gateInput(!this.state.muted);
    }
    if (this.peer.audioState === 'suspended' && this.state.phase !== 'paused') this.set({ phase: 'paused' });
  }
  private async poll() {
    try {
      while (this.alive) {
        const result = await this.request<{ active: boolean; events: any[] }>(`/events?after=${this.cursor}`);
        if (!this.alive) return;
        for (const event of result.events) {
          this.cursor = event.sequence;
          if (event.type === 'sources') this.set({ evidence: event.evidence });
          if (event.type === 'message') {
            if (event.role === 'user') {
              if (event.id < this.userId) continue;
              if (event.id > this.userId) {
                if (!this.awaitingUser) this.inputEpoch++;
                this.pendingAnswer = false; this.answerSettled = false;
                this.set({ answer: '', error: '', replyPendingSince: this.awaitingUser ? this.state.replyPendingSince : 0,
                  ...(!this.awaitingUser && !this.stopped ? { phase: 'hearing' } : {}),
                  ...(this.state.notice === this.pendingNotice ? { notice: '' } : {}) });
                this.awaitingUser = false;
              }
              this.userId = event.id; this.set({ question: event.text });
              if (event.final && !this.answerSettled && (!this.stopped || this.newQuestion)) {
                this.pendingAnswer = true;
                this.set({ replyPendingSince: this.state.replyPendingSince || Date.now(),
                  ...(!['speaking', 'paused'].includes(this.state.phase) ? { phase: 'thinking' } : {}) });
              }
            }
            else {
              if (this.assistantId !== event.id) { this.assistantId = event.id; this.observed = 0; }
              this.set({ turnId: event.id, answer: event.text, evidence: event.evidence });
            }
            this.options.onTurn?.(event.role === 'user' ? event.text : '', event.role === 'assistant' ? event.text : '', event.evidence, event.id);
          }
          if (event.type === 'answer_pending' && event.id === this.userId && !this.awaitingUser && (!this.stopped || this.newQuestion)) {
            this.pendingAnswer = event.pending === true; this.answerSettled = !this.pendingAnswer;
            this.set({
              replyPendingSince: this.pendingAnswer ? this.state.replyPendingSince || Date.now() : 0,
              ...(['thinking', 'listening', 'hearing'].includes(this.state.phase) ? { phase: this.pendingAnswer ? 'thinking' : 'listening' } : {}),
              ...(!this.state.notice || this.state.notice === this.pendingNotice ? { notice: this.pendingAnswer ? this.pendingNotice : '' } : {}),
              ...(event.error ? { error: event.error } : {}),
            });
          }
          if (event.type === 'error') this.set({ error: event.error });
        }
        if (!result.active) { await this.end(); return; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch (error) { if (this.alive) { this.set({ error: error instanceof Error ? error.message : 'Live connection lost' }); await this.end(); } }
  }
  async sendText(text: string) {
    if (!this.alive || !this.id || !text.trim() || text.length > 2000) return;
    const epoch = ++this.inputEpoch;
    this.newQuestion = true; this.awaitingUser = true; this.answerSettled = false; this.pendingAnswer = false;
    this.set({ phase: 'thinking', error: '', question: text, answer: '', replyPendingSince: Date.now() });
    try {
      await this.request('/text', { question: text, requestId: crypto.randomUUID() });
      // Live can answer an appended typed question within the SAME provider
      // turn. Waiting for another turn.created would leave playback muted forever.
      if (this.alive && epoch === this.inputEpoch && this.stopped) { this.stopped = false; this.peer.muteOutput(false); this.set({ notice: '' }); }
    }
    catch (error) {
      if (this.alive && epoch === this.inputEpoch) {
        this.awaitingUser = false; this.pendingAnswer = false; this.answerSettled = true;
        this.set({ phase: 'listening', replyPendingSince: 0, error: error instanceof Error ? error.message : 'Question could not be sent' });
      }
    }
  }
  async toggleMute() {
    if (!this.alive || this.changing) return; this.changing = true;
    try {
      if (!this.state.muted) { this.set({ muted: true }); this.peer.stopInput(); this.inputSource?.disconnect(); }
      else {
        const stream = await this.microphone(); await this.peer.replaceInput(stream);
        if (this.alive) { this.set({ muted: false, notice: '' }); this.peer.gateInput(this.state.voiceInterruption || this.state.phase !== 'speaking'); }
      }
    } catch { if (this.alive) this.set({ muted: true, notice: 'Microphone unavailable. You can type instead.' }); }
    finally { this.changing = false; }
  }
  setVoiceInterruption(enabled: boolean) { this.set({ voiceInterruption: enabled }); this.peer.gateInput(!this.state.muted && (enabled || this.state.phase !== 'speaking')); }
  async interrupt() {
    if (!this.alive) return;
    this.inputEpoch++;
    this.pendingAnswer = false; this.awaitingUser = false; this.answerSettled = true; this.stopped = true; this.newQuestion = false; this.peer.muteOutput(true); this.peer.gateInput(!this.state.muted);
    this.set({ phase: 'listening', replyPendingSince: 0, notice: 'Reply muted locally; a stop request was sent. Ask another question to continue.' });
    try { await this.request('/interrupt', {}); } catch { if (this.alive) { this.set({ error: 'The remote stop could not be confirmed. The call was ended.' }); await this.end(); } }
  }
  async resumeSound() { await this.peer.resume(); if (this.alive) this.set({ phase: this.state.replyPendingSince ? 'thinking' : 'listening' }); }
  async end() {
    if (!this.alive) return; this.alive = false;
    window.removeEventListener('pagehide', this.pageExit);
    clearInterval(this.timer); this.life.abort();
    this.input?.getTracks().forEach(track => track.stop()); this.inputSource?.disconnect();
    this.peer.close(); void this.inputContext.close().catch(() => {});
    try { this.options.onPlayback?.(null); } catch { /* Presentation only. */ }
    this.pendingAnswer = false; this.awaitingUser = false;
    this.set({ phase: 'ended', muted: true, notice: '', replyPendingSince: 0 });
    if (this.id) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 4000);
      try { await voiceRequest(`/live/calls/${this.id}/end`, { method: 'POST', keepalive: true, signal: controller.signal }); }
      catch { /* Server lease bounds cleanup when the network is gone. */ }
      finally { clearTimeout(timer); }
    }
  }
}
