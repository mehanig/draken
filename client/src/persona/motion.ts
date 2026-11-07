import type { PlaybackCue } from '../audio/playback';
import type { DragonPose, PersonaInput } from './types';

const clamp = (n: number, low = 0, high = 1) => Math.min(high, Math.max(low, n));
export interface SpeechTrack { amplitude: Float32Array; progress: Float32Array; shapes: { open: number; round: number; weight: number }[]; duration: number; questioning: boolean }

/** Approximate English visemes, NOT forced phoneme alignment. Audio supplies the
 * real silence/energy timing; text supplies closure/rounding and phrase gestures. */
export function prepareSpeech(cue: PlaybackCue): SpeechTrack {
  const hop = Math.max(1, Math.floor(cue.sampleRate / 80));
  const frames = Math.ceil(cue.samples.length / hop);
  const amplitude = new Float32Array(frames), progress = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0; const end = Math.min(cue.samples.length, (i + 1) * hop);
    for (let j = i * hop; j < end; j++) sum += cue.samples[j] ** 2;
    amplitude[i] = Math.sqrt(sum / Math.max(1, end - i * hop));
  }
  const sorted = Array.from(amplitude).sort((a, b) => a - b);
  const peak = Math.max(0.012, sorted[Math.floor(sorted.length * 0.92)] || 0);
  let total = 0;
  for (let i = 0; i < frames; i++) {
    amplitude[i] = clamp((amplitude[i] / peak - 0.055) / 0.945);
    total += amplitude[i] > 0.035 ? 0.25 + Math.sqrt(amplitude[i]) : 0;
    progress[i] = total;
  }
  if (total) for (let i = 0; i < frames; i++) progress[i] /= total;
  const sounds = cue.text.toLowerCase().match(/sh|ch|th|ee|oo|ou|ow|[a-z]/g) || [];
  const shapes = sounds.map(sound => {
    if (/^[bmp]$/.test(sound)) return { open: 0, round: 0, weight: 0.7 };
    if (/^(oo|ou|ow|o|u|w)$/.test(sound)) return { open: 0.6, round: 1, weight: 1.25 };
    if (/^(ee|e|i|y)$/.test(sound)) return { open: 0.48, round: -0.4, weight: 1.1 };
    if (sound === 'a') return { open: 1, round: 0, weight: 1.4 };
    if (/^[fv]$/.test(sound)) return { open: 0.2, round: -0.15, weight: 0.9 };
    return { open: 0.35, round: 0.1, weight: 0.8 };
  });
  const weight = shapes.reduce((sum, s) => sum + s.weight, 0);
  let end = 0;
  for (const shape of shapes) { end += shape.weight / Math.max(1, weight); shape.weight = end; }
  return { amplitude, progress, shapes, duration: cue.duration, questioning: /\?\s*$/.test(cue.text) };
}

export function sampleSpeech(track: SpeechTrack, elapsed: number) {
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= track.duration || !track.amplitude.length) return { jaw: 0, round: 0, energy: 0 };
  const index = Math.min(track.amplitude.length - 1, Math.floor(elapsed / track.duration * track.amplitude.length));
  const energy = track.amplitude[index];
  const shape = track.shapes.find(s => s.weight >= track.progress[index]) || { open: 0.6, round: 0 };
  return { jaw: energy * shape.open, round: shape.round * energy, energy };
}

/** Stateful smoothing is local to one scene instance and resets between cues. */
export class PersonaMotion {
  private cue: PlaybackCue | null = null;
  private track: SpeechTrack | null = null;
  private jaw = 0;
  private round = 0;
  sample(input: PersonaInput, time: number, delta: number): DragonPose {
    if (this.cue !== input.playback) {
      this.cue = input.playback;
      this.track = this.cue && !this.cue.level ? prepareSpeech(this.cue) : null;
      this.jaw = 0; this.round = 0;
    }
    const elapsed = this.cue ? this.cue.now() - this.cue.startedAt : NaN;
    const playing = input.mode === 'speaking' && this.cue && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < this.cue.duration;
    let live = 0;
    if (playing && this.cue?.level) { try { const value = this.cue.level(); live = Number.isFinite(value) ? clamp(value) : 0; } catch { /* Presentation-only observer. */ } }
    const speech = playing && this.track ? sampleSpeech(this.track, elapsed) : live > 0.02 ? { jaw: Math.sqrt(live) * 0.7, round: 0, energy: live } : { jaw: 0, round: 0, energy: 0 };
    const smooth = 1 - Math.exp(-Math.min(delta, 0.1) * 28);
    // End/interrupt/paused output closes immediately, even between speech chunks.
    this.jaw = playing && speech.energy > 0 ? this.jaw + (speech.jaw - this.jaw) * smooth : 0;
    this.round = playing && speech.energy > 0 ? this.round + (speech.round - this.round) * smooth : 0;
    const moving = input.motion && input.mode !== 'ended';
    const listen = input.mode === 'listening', think = input.mode === 'thinking';
    const cycle = time % 5.7;
    const blink = cycle > 5.35 ? Math.sin(clamp((cycle - 5.35) / 0.24) * Math.PI) : 0;
    return {
      jaw: moving ? this.jaw : 0, round: moving ? this.round : 0, smile: 0.35,
      blink: moving ? blink : 0,
      headPitch: moving ? (listen ? 0.025 : think ? -0.035 : 0) + Math.sin(time * 1.5) * 0.009 + speech.energy * Math.sin(time * 3.4) * 0.025 : 0,
      headYaw: moving ? (think ? -0.12 : 0) + Math.sin(time * 0.35) * 0.028 : 0,
      headRoll: moving ? (listen ? -0.035 : 0) + Math.sin(time * 0.8) * 0.008 + (playing && this.track?.questioning ? 0.035 : 0) : 0,
      gazeX: moving && think ? -0.04 : 0, gazeY: moving && think ? 0.025 : 0,
      breath: moving ? Math.sin(time * 1.4) * 0.008 : 0,
      gesture: moving && playing ? Math.max(0, Math.sin(time * 1.7)) * speech.energy : 0,
    };
  }
  dispose() { this.cue = null; this.track = null; }
}
