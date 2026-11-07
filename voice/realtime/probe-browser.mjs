import { VoicePeer } from './peer.mjs';
let peer, context, monitor, poll, finished = false, cursor = 0, pollRunning = false;
const startButton = document.querySelector('#start'), endButton = document.querySelector('#end'), status = document.querySelector('#status');
const result = window.voiceResult = { completed: false, success: false, setupMs: null, audioFrames: 0, questions: [], transcripts: [], events: {}, errors: [], localCleanup: false, helperCleanup: false };
const waitFor = async (predicate, ms = 20_000) => {
  const deadline = performance.now() + ms;
  while (!predicate()) { if (finished || performance.now() > deadline) throw new Error('Synthetic voice turn did not complete.'); await new Promise(resolve => setTimeout(resolve, 50)); }
};
async function end() {
  if (finished) return;
  finished = true; clearInterval(monitor); clearInterval(poll); peer?.close();
  if (context && context.state !== 'closed') await context.close();
  result.localCleanup = !!peer?.closed && !peer?.inputActive && (!context || context.state === 'closed');
  try {
    const response = await fetch('/end', { method: 'POST', signal: AbortSignal.timeout(5000) });
    result.helperCleanup = response.ok && (await response.json()).helperExited === true;
  } catch { /* Lab lease is the final guard; do not claim confirmed helper cleanup. */ }
  if (!result.helperCleanup) result.success = false;
  result.completed = true; endButton.disabled = true; status.textContent = result.success ? 'Synthetic exchange passed. Account quota and human-device behaviour still need testing.' : 'Test ended; see the private structural report.';
}
endButton.onclick = () => { void end(); };
window.addEventListener('pagehide', () => { peer?.close(); void fetch('/end', { method: 'POST', keepalive: true }); });
startButton.onclick = async () => {
  startButton.disabled = true; endButton.disabled = false; status.textContent = 'Connecting…';
  const start = performance.now(); let lastAudible = 0, current;
  try {
    context = new AudioContext(); await context.resume();
    if (finished) throw new Error('Test cancelled before audio setup.');
    const input = context.createMediaStreamDestination();
    // A real microphone continues sending silence between utterances. Keep
    // the synthetic source active too, rather than ending its audio graph.
    const silence = context.createConstantSource(); silence.offset.value = 0; silence.connect(input); silence.start();
    peer = new VoicePeer({ onClose: () => { if (!finished) { result.errors.push('Media connection closed.'); void end(); } }, onEvent: event => {
      const type = typeof event.type === 'string' ? event.type : 'unknown';
      result.events[type] = (result.events[type] || 0) + 1;
      if (event.type === 'error') { result.errors.push('Remote voice event reported an error.'); void end(); }
    } });
    poll = setInterval(async () => {
      if (pollRunning || finished) return; pollRunning = true;
      try {
        const response = await fetch(`/events?after=${cursor}`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Events unavailable.');
        for (const event of await response.json()) {
          cursor = event.sequence;
          if (event.method === 'thread/realtime/transcript/done') result.transcripts.push(event.params);
          if (['thread/realtime/error', 'thread/realtime/closed', 'draken/closed', 'draken/blocked'].includes(event.method)) { result.errors.push(event.method); void end(); }
        }
      } catch { result.errors.push('Native voice event stream failed.'); void end(); }
      finally { pollRunning = false; }
    }, 250);
    await peer.open(input.stream, async (offer, signal) => {
      const response = await fetch('/call', { method: 'POST', body: offer, signal });
      if (!response.ok) throw new Error('Native voice connection was rejected.');
      return response.text();
    });
    result.setupMs = Math.round(performance.now() - start); status.textContent = 'Running two spoken turns on one connection…';
    monitor = setInterval(() => {
      if (peer.level > 0.01) {
        result.audioFrames++; lastAudible = performance.now();
        if (current && current.firstAudioAt === undefined) current.firstAudioAt = Math.round(lastAudible);
      }
    }, 20);
    const buffer = await context.decodeAudioData(await (await fetch('/question.wav')).arrayBuffer());
    for (let index = 0; index < 2; index++) {
      const assistantBefore = result.transcripts.filter(item => item.role === 'assistant').length;
      const userBefore = result.transcripts.filter(item => item.role === 'user').length;
      const framesBefore = result.audioFrames;
      current = { index, inputStartedAt: Math.round(performance.now()) }; result.questions.push(current);
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(input);
      await new Promise(resolve => { source.onended = resolve; source.start(); });
      current.inputEndedAt = Math.round(performance.now()); source.disconnect();
      await waitFor(() => result.transcripts.filter(item => item.role === 'assistant').slice(assistantBefore).some(item => /pass/i.test(item.text)) &&
        result.transcripts.filter(item => item.role === 'user').slice(userBefore).some(item => /export.*test/i.test(item.text)) &&
        result.audioFrames > framesBefore + 5 && performance.now() - lastAudible > 900);
      current.firstAudioAfterFixtureMs = current.firstAudioAt - current.inputEndedAt;
      current = undefined;
    }
    result.success = true;
  } catch (error) { result.errors.push(error.message); }
  finally { await end(); }
};
