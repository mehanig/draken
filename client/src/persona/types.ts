import type { PlaybackCue } from '../audio/playback';

/** Standalone presentation contract. No sync, API, authentication or call objects. */
export type PersonaMode = 'idle' | 'listening' | 'thinking' | 'speaking' | 'ended';
export interface PersonaInput {
  mode: PersonaMode;
  motion: boolean;
  playback: PlaybackCue | null;
}
export interface DragonPose {
  jaw: number;
  round: number;
  smile: number;
  blink: number;
  headPitch: number;
  headYaw: number;
  headRoll: number;
  gazeX: number;
  gazeY: number;
  breath: number;
  gesture: number;
}
export interface PersonaScene {
  readonly maxFps: number;
  update(input: PersonaInput): void;
  resize(width: number, height: number): void;
  render(time: number): void;
  dispose(): void;
}
