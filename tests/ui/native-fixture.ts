import type { Page } from '@playwright/test';

/** Real local WebRTC audio plus the synthetic server helper. Never contacts OpenAI. */
export async function nativePeer(page: Page, denied = false) {
  await page.addInitScript(({ denied }) => {
    const w = window as any;
    w.__captures = 0;
    w.__tracks = [];
    w.__micContexts = [];
    navigator.mediaDevices.getUserMedia = async () => {
      w.__captures++;
      if (denied) throw new DOMException('Synthetic microphone refusal', 'NotAllowedError');
      const context = new AudioContext(); await context.resume();
      const destination = context.createMediaStreamDestination();
      const silence = context.createConstantSource(); silence.offset.value = 0;
      silence.connect(destination); silence.start();
      w.__micContexts.push(context);
      w.__tracks.push(...destination.stream.getTracks());
      return destination.stream;
    };
    w.__answerNative = async (sdp: string) => {
      const context = new AudioContext(); await context.resume();
      const pc = new RTCPeerConnection();
      const output = context.createMediaStreamDestination(), volume = context.createGain();
      const tone = context.createOscillator(); volume.gain.value = 0;
      tone.connect(volume); volume.connect(output); tone.start();
      pc.addTrack(output.stream.getAudioTracks()[0], output.stream);
      const remote = w.__remote = { context, pc, output, volume, channel: null, timer: 0, release: () => {} };
      pc.ondatachannel = event => { remote.channel = event.channel; };
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await new Promise<void>(resolve => {
        remote.release = resolve;
        if (pc.iceGatheringState === 'complete') resolve();
        else pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); };
      });
      return pc.localDescription?.sdp || '';
    };
    w.__speakNative = () => {
      const r = w.__remote;
      const send = (type: string) => r.channel?.readyState === 'open' && r.channel.send(JSON.stringify({ type, turn: { role: 'assistant' } }));
      clearTimeout(r.timer); send('turn.created'); r.volume.gain.value = 0.15;
      r.timer = setTimeout(() => { r.volume.gain.value = 0; send('turn.done'); }, 3000);
    };
    w.__disposeNative = async () => {
      const r = w.__remote;
      if (r) { clearTimeout(r.timer); r.release(); r.pc.close(); r.output.stream.getTracks().forEach((track: MediaStreamTrack) => track.stop()); await r.context.close(); w.__remote = null; }
      for (const context of w.__micContexts) if (context.state !== 'closed') await context.close();
    };
  }, { denied });

  await page.route('**/api/voice/live/calls/*/connect', async route => {
    // Exercise real server admission, helper lifecycle, initial evidence and stored status.
    const response = await route.fetch();
    if (!response.ok()) { await route.fulfill({ response }); return; }
    try {
      const sdp = await page.evaluate(sdp => (window as any).__answerNative(sdp), route.request().postDataJSON().sdp);
      await route.fulfill({ response, json: { sdp } });
    } catch (error) {
      if (!/Execution context was destroyed|Target.*closed|Test ended/.test(String(error))) throw error;
      await route.abort().catch(() => {}); // Explicit hang-up/navigation can cancel negotiation.
    }
  });
  await page.route('**/api/voice/live/calls/*/text', async route => {
    const response = await route.fetch();
    if (response.ok()) await page.evaluate(() => (window as any).__speakNative());
    await route.fulfill({ response });
  });
  await page.route('**/api/voice/live/calls/*/end', async route => {
    const response = await route.fetch();
    await page.evaluate(() => (window as any).__disposeNative?.()).catch(() => {});
    await route.fulfill({ response });
  });
}
