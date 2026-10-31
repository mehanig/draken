import type { MicVAD } from '@ricky0123/vad-web';

export type CallPhase = 'connecting' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking' | 'paused' | 'ended';
export interface VoiceStatus { installed: boolean; state: string; error: string; httpsPort: number | null; certificateAvailable: boolean; activeCall: { id: string; syncId: number } | null }
export interface CallState {
  phase: CallPhase; muted: boolean; microphone: boolean; question: string; answer: string; evidence: string[];
  error: string; notice: string; startedAt: number; turnId: number; modelMs?: number;
}
export const INITIAL_CALL: CallState = { phase: 'connecting', muted: false, microphone: false, question: '', answer: '', evidence: [], error: '', notice: '', startedAt: 0, turnId: 0 };
export interface CallHistory { id: string; status: string; started_at: string; ended_at: string | null; end_reason: string;
  turns: { id: number; question: string; answer: string; heard_text: string; status: string; error: string; evidence_json: string }[] }

export function voiceHeaders(json = true): Record<string, string> {
  const token = localStorage.getItem('draken_token');
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
export async function voiceRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/voice${path}`, { method, headers: voiceHeaders(), body: body === undefined ? undefined : JSON.stringify(body), signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || (response.status === 401 ? 'Sign in again to use the call.' : 'The call connection failed.'));
  }
  return response.status === 204 ? undefined as T : response.json();
}
export function encodeWav(audio: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + audio.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, audio.length * 2, true);
  for (let i = 0; i < audio.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, audio[i])) * 32767, true);
  return buffer;
}
interface AudioChunk { turnId: number; index: number; text: string; version: number }
interface Options { onState: (state: CallState) => void; onLevel: (level: number) => void; onTurn: (question: string, answer: string, refs: string[], turnId: number) => void }

/** Owns every microphone track, audio node, fetch, and heartbeat for one call. */
export class VoiceSession {
  state = { ...INITIAL_CALL };
  private alive = true;
  private id = '';
  private version = 0;
  private context: AudioContext;
  private stream?: MediaStream;
  private vad?: MicVAD;
  private queue: AudioChunk[] = [];
  private pumping = false;
  private generationDone = false;
  private stopPlayback?: () => void;
  private request?: AbortController;
  private lifetime = new AbortController();
  private heartbeat?: ReturnType<typeof setInterval>;
  private barrier: Promise<unknown> = Promise.resolve();
  private receipt: Promise<unknown> = Promise.resolve();
  private pendingReceipt?: { turnId: number; index: number };
  private captureVersion = -1;
  private speechStarted = 0;
  private splitting = false;
  private heartbeatPending = false;
  private changingMicrophone = false;
  private pageExit = () => { void this.end(); };

  constructor(private options: Options) {
    // Unlock audio during the actual button gesture, before any network await.
    this.context = new AudioContext();
    void this.context.resume().catch(() => {});
    window.addEventListener('pagehide', this.pageExit);
  }
  private set(update: Partial<CallState>) {
    this.state = { ...this.state, ...update };
    if (this.alive || update.phase === 'ended') this.options.onState(this.state);
  }
  private valid(version: number) { return this.alive && version === this.version; }
  private async microphone() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (!this.alive) { stream.getTracks().forEach(track => track.stop()); throw new Error('Call ended'); }
    this.stream = stream;
    for (const track of stream.getAudioTracks()) track.onended = () => {
      if (this.alive && !this.state.muted) {
        this.captureVersion = -1; this.speechStarted = 0; this.options.onLevel(0);
        this.set({ microphone: false, muted: true, phase: this.state.phase === 'hearing' ? 'listening' : this.state.phase,
          notice: 'Microphone disconnected. You can type or enable it again.' });
      }
    };
    this.set({ microphone: true });
    return stream;
  }
  private async detector() {
    const { MicVAD } = await import('@ricky0123/vad-web');
    if (!this.alive) return;
    const vad = await MicVAD.new({
      model: 'v5', baseAssetPath: '/voice-assets/', onnxWASMBasePath: '/voice-assets/',
      ortConfig: ort => { ort.env.wasm.numThreads = 1; },
      audioContext: this.context, startOnLoad: false, submitUserSpeechOnPause: false,
      // A 0.7s pause finishes a thought; a quarter-second of speech permits barge-in.
      redemptionMs: 700, minSpeechMs: 250, preSpeechPadMs: 300,
      getStream: async () => this.stream?.active ? this.stream : this.microphone(),
      pauseStream: async stream => { stream.getTracks().forEach(track => track.stop()); },
      resumeStream: async () => this.microphone(),
      onSpeechStart: () => { this.speechStarted = Date.now(); },
      onSpeechRealStart: () => {
        if (!this.alive || this.state.muted) return;
        void this.interrupt(false);
        this.captureVersion = this.version;
        this.set({ phase: 'hearing', error: '' });
      },
      onVADMisfire: () => { this.speechStarted = 0; },
      onSpeechEnd: audio => {
        this.speechStarted = 0;
        if (this.valid(this.captureVersion) && !this.state.muted) void this.submitAudio(audio, this.captureVersion);
      },
      onFrameProcessed: (_probabilities, frame) => {
        if (!this.alive) return;
        const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length);
        this.options.onLevel(Math.min(1, rms * 12));
        // Bound the recording buffer even if someone never pauses (server limit: 45s).
        if (this.speechStarted && Date.now() - this.speechStarted > 40000 && !this.splitting) void this.splitLongTurn();
      },
    });
    if (!this.alive) { await vad.destroy(); return; }
    this.vad = vad;
  }
  private async splitLongTurn() {
    if (!this.vad) return;
    this.splitting = true;
    try {
      this.vad.setOptions({ submitUserSpeechOnPause: true });
      await this.vad.pause();
      this.vad.setOptions({ submitUserSpeechOnPause: false });
      if (this.alive && !this.state.muted) await this.vad.start();
    } catch { if (this.alive) this.set({ notice: 'Microphone paused. Enable it again, or type your question.', muted: true }); }
    finally { this.speechStarted = 0; this.splitting = false; }
  }

  async start(syncId: number) {
    try {
      try { await this.microphone(); }
      catch {
        if (!this.alive) return;
        this.set({ muted: true, microphone: false, notice: 'Microphone access was not available. You can type, or enable the microphone below.' });
      }
      if (!this.alive) return;
      const vadPromise = this.state.microphone ? this.detector() : Promise.resolve();
      // Both branches are observed even if startup is cancelled or one branch fails.
      const [callResult, vadResult] = await Promise.allSettled([
        voiceRequest<{ id: string; startedAt: string; greeting: string; limits: { heartbeatSeconds: number } }>('/calls', 'POST', { syncId }, this.lifetime.signal),
        vadPromise,
      ]);
      if (callResult.status === 'rejected') throw callResult.reason;
      const call = callResult.value;
      this.id = call.id;
      if (!this.alive) { await this.closeRemote(); return; }
      if (vadResult.status === 'rejected') {
        this.stream?.getTracks().forEach(track => track.stop());
        this.set({ muted: true, microphone: false, notice: 'Speech detection could not start. You can still type and hear replies.' });
      }
      this.set({ startedAt: Date.parse(call.startedAt), phase: 'listening', answer: call.greeting });
      this.heartbeat = setInterval(() => { void this.ping(); }, call.limits.heartbeatSeconds * 1000);
      if (this.vad && !this.state.muted) await this.vad.start();
      this.queue.push({ turnId: 0, index: 0, text: call.greeting, version: this.version });
      this.generationDone = true;
      void this.pump();
    } catch (error) {
      if (!this.alive) return;
      const message = error instanceof Error ? error.message : 'Could not start the call';
      await this.end();
      this.set({ phase: 'ended', error: message });
    }
  }
  private async ping() {
    if (!this.alive || !this.id || this.heartbeatPending) return;
    this.heartbeatPending = true;
    try { await voiceRequest(`/calls/${this.id}/heartbeat`, 'POST', {}, AbortSignal.timeout(12000)); }
    catch {
      if (this.alive) { await this.end(); this.set({ phase: 'ended', error: 'The call connection was lost. Your completed transcript is saved. Start another call to continue.' }); }
    } finally { this.heartbeatPending = false; }
  }

  interrupt(listening = true) {
    ++this.version;
    this.captureVersion = -1;
    this.request?.abort(); this.request = undefined;
    this.stopPlayback?.(); this.stopPlayback = undefined;
    this.queue = []; this.generationDone = false;
    if (listening && this.alive) this.set({ phase: 'listening' });
    if (this.id && this.alive) {
      this.barrier = this.barrier.catch(() => {}).then(() => this.receipt.catch(() => {}))
        .then(() => this.confirmPlayback())
        .then(() => voiceRequest(`/calls/${this.id}/interrupt`, 'POST', {}, this.lifetime.signal));
      // Speech callbacks cannot await; submitAudio/sendText still await the barrier.
      void this.barrier.catch(() => {});
    }
    return this.barrier;
  }
  private async submitAudio(audio: Float32Array, version: number) {
    if (!this.valid(version)) return;
    this.set({ phase: 'transcribing', question: '', error: '' });
    const controller = new AbortController(); this.request = controller;
    try {
      await this.barrier;
      if (!this.valid(version)) return;
      const response = await fetch(`/api/voice/calls/${this.id}/transcribe`, { method: 'POST',
        headers: { ...voiceHeaders(false), 'Content-Type': 'audio/wav' }, body: encodeWav(audio), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not transcribe the recording');
      if (!this.valid(version)) return;
      if (!result.text?.trim()) { this.set({ phase: 'listening', notice: "I didn't catch any speech. Please try again." }); return; }
      await this.beginReply(result.text, version, controller);
    } catch (error) { this.failed(error, version); }
  }
  async sendText(text: string) {
    if (!text.trim() || !this.id || !this.alive) return;
    void this.interrupt(false);
    const version = this.version;
    const controller = new AbortController(); this.request = controller;
    this.set({ phase: 'thinking', question: text.trim(), error: '', notice: '' });
    try { await this.barrier; if (this.valid(version)) await this.beginReply(text.trim(), version, controller); }
    catch (error) { this.failed(error, version); }
  }
  private failed(error: unknown, version: number) {
    if (!this.valid(version) || (error instanceof DOMException && error.name === 'AbortError')) return;
    ++this.version; this.stopPlayback?.(); this.queue = []; this.generationDone = true;
    this.set({ phase: 'listening', error: error instanceof Error ? error.message : 'The reply failed. Please try again.' });
  }
  private async beginReply(question: string, version: number, controller: AbortController) {
    this.set({ phase: 'thinking', question, answer: '', evidence: [], error: '', notice: '' });
    this.generationDone = false;
    const response = await fetch(`/api/voice/calls/${this.id}/turns`, { method: 'POST', headers: voiceHeaders(),
      body: JSON.stringify({ message: question, requestId: crypto.randomUUID() }), signal: controller.signal });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Could not start the reply'); }
    if (!response.body) throw new Error('This browser cannot stream the call response');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let done = false;
    try {
      while (this.valid(version)) {
        const packet = await reader.read();
        if (packet.done) break;
        buffer += decoder.decode(packet.value, { stream: true });
        if (buffer.length > 100000) throw new Error('The call response was too large');
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (!this.valid(version)) return;
          if (event.type === 'turn') this.set({ turnId: event.id });
          if (event.type === 'answer') {
            this.set({ answer: event.text, evidence: event.evidence, modelMs: event.modelMs });
            this.options.onTurn(question, event.text, event.evidence, event.id);
          }
          if (event.type === 'audio') { this.queue.push({ turnId: event.id, index: event.index, text: event.text, version }); void this.pump(); }
          if (event.type === 'done') { done = true; this.generationDone = true; if (!this.pumping && !this.queue.length && this.state.phase !== 'paused') this.set({ phase: 'listening' }); }
          if (event.type === 'error') {
            done = true; ++this.version; this.generationDone = true;
            this.stopPlayback?.(); this.queue = [];
            this.set({ phase: 'listening', error: event.error });
          }
        }
      }
      if (this.valid(version) && !done) throw new Error('The reply connection was interrupted. Please try again.');
    } finally { await reader.cancel().catch(() => {}); }
  }

  private confirmPlayback(): Promise<unknown> {
    const pending = this.pendingReceipt;
    if (!pending) return Promise.resolve();
    this.receipt = voiceRequest(`/calls/${this.id}/played`, 'POST', pending, this.lifetime.signal).then(() => {
      if (this.pendingReceipt === pending) this.pendingReceipt = undefined;
    });
    return this.receipt;
  }
  private async pump() {
    if (this.pumping || !this.alive) return;
    this.pumping = true;
    let playingVersion = this.version;
    try {
      while (this.queue.length && this.alive) {
        const chunk = this.queue[0]; playingVersion = chunk.version;
        if (!this.valid(chunk.version)) { this.queue.shift(); continue; }
        const response = await fetch(`/api/voice/calls/${this.id}/audio/${chunk.turnId}/${chunk.index}`, { headers: voiceHeaders(false), signal: this.lifetime.signal });
        if (!response.ok) throw new Error('Spoken audio could not be loaded. You can still read the reply.');
        const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
        if (!this.valid(chunk.version)) { if (this.queue[0] === chunk) this.queue.shift(); continue; }
        await this.context.resume();
        if (this.context.state !== 'running') { this.set({ phase: 'paused', error: 'Sound is paused by the browser. Tap Resume sound.' }); return; }
        this.set({ phase: 'speaking' });
        const complete = await new Promise<boolean>(resolve => {
          const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
          let settled = false;
          const finish = (heard: boolean) => { if (settled) return; settled = true; source.onended = null; source.disconnect(); this.stopPlayback = undefined; resolve(heard); };
          source.onended = () => finish(true);
          this.stopPlayback = () => { source.onended = null; try { source.stop(); } catch { /* Already stopped. */ } finish(false); };
          source.start();
        });
        if (this.queue[0] === chunk) this.queue.shift();
        if (complete) {
          this.pendingReceipt = { turnId: chunk.turnId, index: chunk.index };
          await this.confirmPlayback();
        }
      }
      if (this.alive && this.generationDone && this.state.phase === 'speaking') this.set({ phase: 'listening' });
    } catch (error) {
      if (this.valid(playingVersion)) this.set({ phase: 'paused', error: error instanceof Error ? error.message : 'Sound playback failed. Tap Resume sound.' });
    } finally {
      this.pumping = false;
      // An interrupted playback can have a new turn queued while its old loop unwinds.
      if (this.alive && this.queue.length && this.state.phase !== 'paused') void this.pump();
    }
  }
  async resumeSound() {
    try {
      await this.context.resume(); await this.confirmPlayback();
      if (this.alive) { this.set({ error: '', phase: this.queue.length ? 'speaking' : this.generationDone ? 'listening' : 'thinking' }); void this.pump(); }
    } catch (error) { if (this.alive) this.set({ phase: 'paused', error: error instanceof Error ? error.message : 'Sound could not resume. Please try again.' }); }
  }
  async toggleMute() {
    if (!this.alive || this.changingMicrophone) return;
    this.changingMicrophone = true;
    try {
      if (!this.state.muted) {
        this.captureVersion = -1; this.speechStarted = 0;
        this.set({ muted: true });
        try { await this.vad?.pause(); }
        catch { this.set({ notice: 'Speech detection paused. Enable the microphone again to retry.' }); }
        finally { this.stream?.getTracks().forEach(track => track.stop()); this.options.onLevel(0); }
      } else {
        try {
          await this.context.resume();
          if (!this.vad) { await this.microphone(); await this.detector(); }
          // A physically disconnected track can leave VAD marked as listening.
          // Reset it before reacquiring a device instead of pretending it resumed.
          else if (!this.stream?.active) await this.vad.pause();
          await this.vad?.start();
          this.set({ muted: false, microphone: true, notice: '' });
        } catch { this.set({ muted: true, microphone: false, notice: 'Microphone access is still unavailable. Check the browser permission, or type below.' }); }
      }
    } finally { this.changingMicrophone = false; }
  }
  private async closeRemote() {
    if (!this.id) return;
    try { await fetch(`/api/voice/calls/${this.id}/end`, { method: 'POST', headers: voiceHeaders(), body: '{}', keepalive: true, signal: AbortSignal.timeout(2500) }); }
    catch { /* The server's lease closes disconnected calls. */ }
  }
  async end() {
    if (!this.alive) return;
    this.alive = false; ++this.version; this.captureVersion = -1;
    clearInterval(this.heartbeat); window.removeEventListener('pagehide', this.pageExit);
    this.request?.abort(); this.stopPlayback?.(); this.queue = [];
    this.stream?.getTracks().forEach(track => track.stop());
    void this.vad?.destroy().catch(() => {});
    void this.context.close().catch(() => {});
    this.options.onLevel(0);
    this.set({ phase: 'ended', muted: true });
    // Send completed playback receipts before marking the remaining reply interrupted.
    await Promise.race([this.receipt.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
    this.lifetime.abort();
    await this.closeRemote();
  }
}
