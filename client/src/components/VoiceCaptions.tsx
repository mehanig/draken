import { useEffect, useState } from 'react';
import type { CallState } from '../voice/api';

const thinking = ['[Thinking...]', '[Hmmm...]', '[Hmmmmmm...]'];
const checking = ['[Checking...]', '[Looking that up...]'];

/** A short window onto the live transcript, not word-timed playback receipts. */
function excerpt(text: string) {
  const characters = Array.from(text.trim().replace(/\s+/g, ' '));
  if (characters.length <= 140) return characters.join('');
  const tail = characters.slice(-140).join('');
  const boundary = tail.indexOf(' ');
  return '…' + (boundary >= 0 && boundary < 25 ? tail.slice(boundary + 1) : tail);
}

export function VoiceCaptions({ call, historyLookup }: { call: CallState; historyLookup: boolean }) {
  const [phrase, setPhrase] = useState(0);
  const waiting = Boolean(call.replyPendingSince) && !['connecting', 'hearing', 'speaking', 'paused', 'ended'].includes(call.phase) && !call.error;
  useEffect(() => {
    setPhrase(0);
    if (!waiting) return;
    const timer = setInterval(() => setPhrase(value => (value + 1) % 6), 5000);
    return () => clearInterval(timer);
  }, [waiting, call.replyPendingSince, historyLookup]);

  let text: string, speaker = '';
  if (call.phase === 'ended') text = '[Call ended]';
  else if (call.error) text = '[Reply unavailable]';
  else if (call.phase === 'paused') text = '[Sound paused]';
  else if (call.phase === 'connecting') text = call.notice.includes('microphone permission') ? '[Waiting for microphone...]' : '[Connecting...]';
  else if (call.phase === 'hearing') { text = call.question ? excerpt(call.question) : '[Listening...]'; speaker = call.question ? 'You' : ''; }
  else if (waiting) text = historyLookup ? checking[phrase % checking.length] : thinking[phrase % thinking.length];
  else if (call.notice.startsWith('Reply muted locally;')) text = '[Reply stopped]';
  else if (call.answer) { text = excerpt(call.answer); speaker = 'Draken'; }
  else if (call.question) { text = excerpt(call.question); speaker = 'You'; }
  else text = call.phase === 'speaking' ? '[Speaking...]' : call.muted ? '[Microphone off]' : '[Listening...]';

  // Keep captions in the scene's DOM layer: accessible text that is still
  // present if WebGL fails. Cycling filler is visual only, never spoken or saved.
  return <div className="voice-captions" role="region" aria-label="Live captions" aria-live="off" data-kind={speaker ? 'transcript' : 'status'}>
    {speaker && <span className="voice-caption-speaker">{speaker}</span>}
    <div className="voice-caption-window"><p>{text}</p></div>
  </div>;
}
