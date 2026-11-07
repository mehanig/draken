import type { PlaybackCue } from '../audio/playback';

type CallPhase = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'paused' | 'ended';
export interface VoiceStatus { mode: 'native'; installed: boolean; state: string; error: string; httpsPort: number | null; certificateAvailable: boolean; activeCall: { id: string; syncId: number } | null }
export interface CallState {
  phase: CallPhase; muted: boolean; microphone: boolean; voiceInterruption: boolean; question: string; answer: string; evidence: string[];
  error: string; notice: string; startedAt: number; turnId: number; replyPendingSince: number; historyReady: boolean;
}
export const INITIAL_CALL: CallState = { phase: 'connecting', muted: false, microphone: false, voiceInterruption: false, question: '', answer: '', evidence: [], error: '', notice: '', startedAt: 0, turnId: 0, replyPendingSince: 0, historyReady: false };
export interface CallHistory { mode: 'native' | 'legacy'; id: string; status: string; started_at: string; ended_at: string | null; end_reason: string;
  turns: { id: number; question: string; answer: string; heard_text: string; status: string; error: string; evidence_json: string }[] }
export interface CallOptions { onState: (state: CallState) => void; onLevel: (level: number) => void; onTurn: (question: string, answer: string, refs: string[], messageId: number) => void; onPlayback?: (cue: PlaybackCue | null) => void }

export function voiceHeaders(json = true): Record<string, string> {
  const token = localStorage.getItem('draken_token');
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
export async function voiceRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/voice${path}`, { ...options, headers: voiceHeaders() });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || (response.status === 401 ? 'Sign in again to use the call.' : 'The live connection failed.'));
  }
  return response.status === 204 ? undefined as T : response.json();
}
