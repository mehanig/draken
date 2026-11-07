/** Media-only browser boundary. It owns transferred tracks, never credentials or sync data.
 * No automatic microphone acquisition/reconnect; callers must obtain a stream explicitly.
 */
export class VoicePeer {
  #pc;
  #context;
  #input;
  #sender;
  #remote = new Set();
  #sources = [];
  #meter;
  #gain;
  #decoder;
  #samples = new Float32Array(1024);
  #controller = new AbortController();
  #closed = false;
  #opened = false;
  #mutedOutput = false;
  #rejectConnection;
  #timer;
  #onClose;
  #onEvent;
  constructor({ onClose = () => {}, onEvent = () => {} } = {}) { this.#onClose = onClose; this.#onEvent = onEvent; }
  get closed() { return this.#closed; }
  get clock() { return !this.#closed && this.#context?.state === 'running' ? this.#context.currentTime : NaN; }
  get audioState() { return this.#context?.state || 'closed'; }
  async resume() { if (!this.#closed) { await this.#context?.resume(); await this.#decoder?.play(); } }
  gateInput(enabled) { this.#input?.getAudioTracks().forEach(track => { track.enabled = !!enabled; }); }
  get inputActive() { return !!this.#input?.getAudioTracks().some(track => track.readyState === 'live'); }
  get level() {
    if (this.#closed || this.#mutedOutput || this.#context?.state !== 'running' || !this.#meter) return 0;
    this.#meter.getFloatTimeDomainData(this.#samples);
    const rms = Math.sqrt(this.#samples.reduce((sum, value) => sum + value * value, 0) / this.#samples.length);
    return Number.isFinite(rms) ? Math.min(1, rms * 12) : 0;
  }
  async open(input, negotiate) {
    if (this.#opened || this.#closed) { input.getTracks().forEach(track => track.stop()); throw new Error('A voice peer can open only once.'); }
    this.#opened = true; this.#input = input;
    try {
      if (input.getAudioTracks().length !== 1 || input.getVideoTracks().length) throw new Error('Exactly one audio track is required.');
      this.#pc = new RTCPeerConnection(); this.#context = new AudioContext();
      this.#meter = this.#context.createAnalyser(); this.#meter.fftSize = this.#samples.length;
      this.#gain = this.#context.createGain(); this.#meter.connect(this.#gain); this.#gain.connect(this.#context.destination);
      this.#timer = setTimeout(() => this.close('Voice connection timed out.'), 60_000);
      await this.#context.resume();
      if (this.#closed || this.#context.state !== 'running') throw new Error('Voice playback could not start.');
      this.#sender = this.#pc.addTrack(input.getAudioTracks()[0], input);
      const channel = this.#pc.createDataChannel('oai-events');
      const connected = new Promise((resolve, reject) => {
        this.#rejectConnection = reject;
        const check = () => {
          if (this.#pc.connectionState === 'connected' && channel.readyState === 'open') { this.#rejectConnection = undefined; clearTimeout(this.#timer); resolve(); }
          else if (['failed', 'disconnected', 'closed'].includes(this.#pc.connectionState)) this.close('Voice connection lost. Start a new call explicitly.');
        };
        this.#pc.onconnectionstatechange = check; channel.onopen = check;
        channel.onclose = () => this.close('Voice event connection closed.');
        channel.onerror = () => this.close('Voice event connection failed.');
      });
      // A close during the HTTP negotiation must not cause an unhandled rejection.
      void connected.catch(() => {});
      channel.onmessage = event => {
        if (this.#closed) return;
        if (typeof event.data !== 'string' || event.data.length > 200_000) { this.close('Voice event exceeds its limit.'); return; }
        try { this.#onEvent(JSON.parse(event.data)); } catch { this.close('Invalid voice event.'); }
      };
      this.#pc.ontrack = event => {
        if (this.#closed) { event.track.stop(); return; }
        if (event.track.kind !== 'audio' || this.#remote.size) { this.close('Unexpected remote media track.'); return; }
        this.#remote.add(event.track);
        const stream = new MediaStream([event.track]);
        // Chromium can leave a WebRTC track silent when only Web Audio consumes
        // it. A muted media element starts the receiver; the graph is the sole
        // audible output, so this does not play the voice twice.
        this.#decoder = new Audio(); this.#decoder.muted = true; this.#decoder.srcObject = stream;
        void this.#decoder.play().catch(() => this.close('Voice playback could not start.'));
        const source = this.#context.createMediaStreamSource(stream);
        this.#sources.push(source); source.connect(this.#meter);
        event.track.onended = () => this.close('Voice output ended.');
      };
      await this.#pc.setLocalDescription(await this.#pc.createOffer());
      if (this.#closed) throw new Error('Voice connection cancelled.');
      const answer = await negotiate(this.#pc.localDescription.sdp, this.#controller.signal);
      if (this.#closed) throw new Error('Voice connection cancelled.');
      if (typeof answer !== 'string' || answer.length > 64_000 || !answer.startsWith('v=0')) throw new Error('Invalid voice answer.');
      await this.#pc.setRemoteDescription({ type: 'answer', sdp: answer });
      await connected;
    } catch (error) { this.close('Voice connection failed or cancelled.'); throw error; }
  }
  muteOutput(muted) { this.#mutedOutput = !!muted; if (this.#gain) this.#gain.gain.value = muted ? 0 : 1; }
  stopInput() {
    this.#input?.getTracks().forEach(track => track.stop()); this.#input = undefined;
    if (this.#sender && !this.#closed) void this.#sender.replaceTrack(null).catch(() => this.close('Cannot mute voice input.'));
  }
  async replaceInput(stream) {
    if (this.#closed || !this.#sender || stream.getAudioTracks().length !== 1 || stream.getVideoTracks().length) {
      stream.getTracks().forEach(track => track.stop()); throw new Error('Cannot attach voice input.');
    }
    const old = this.#input; this.#input = stream;
    old?.getTracks().forEach(track => track.stop());
    try { await this.#sender.replaceTrack(stream.getAudioTracks()[0]); }
    catch (error) { stream.getTracks().forEach(track => track.stop()); this.close('Cannot attach voice input.'); throw error; }
    if (this.#closed || this.#input !== stream) { stream.getTracks().forEach(track => track.stop()); throw new Error('Voice input was superseded.'); }
  }
  close(reason = 'Call ended.') {
    if (this.#closed) return;
    this.#closed = true; clearTimeout(this.#timer); this.#controller.abort();
    this.#rejectConnection?.(new Error(reason)); this.#rejectConnection = undefined;
    this.#pc?.close(); this.#input?.getTracks().forEach(track => track.stop());
    this.#remote.forEach(track => track.stop()); this.#remote.clear();
    this.#sources.forEach(source => source.disconnect()); this.#sources = [];
    this.#meter?.disconnect(); this.#gain?.disconnect(); this.#samples.fill(0);
    if (this.#decoder) { this.#decoder.pause(); this.#decoder.srcObject = null; this.#decoder = undefined; }
    if (this.#context && this.#context.state !== 'closed') void this.#context.close().catch(() => {});
    try { this.#onClose(reason); } catch { /* Cleanup must not depend on the UI. */ }
  }
}
