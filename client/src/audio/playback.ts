/** Optional, read-only observation of one LOCAL decoded playback chunk.
 * The observer cannot control audio, receipts, the microphone, or inference.
 * Retain only while playing; samples must not be uploaded or persisted.
 */
export interface PlaybackCue {
  readonly text: string;
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly duration: number;
  readonly startedAt: number;
  /** The same AudioContext clock used to schedule playback, not wall time. */
  readonly now: () => number;
}
