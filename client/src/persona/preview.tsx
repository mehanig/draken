import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PersonaStage } from './PersonaStage';
import type { PersonaMode } from './types';
import type { PlaybackCue } from '../audio/playback';
import '../styles/index.css';
import './preview.css';

function PersonaPreview() {
  const [mode, setMode] = useState<PersonaMode>('idle'), [error, setError] = useState('');
  const cue = useRef<PlaybackCue | null>(null), context = useRef<AudioContext>(), source = useRef<AudioBufferSourceNode>();
  const alive = useRef(true), version = useRef(0);
  const stop = () => { version.current++; source.current?.stop(); source.current = undefined; cue.current = null; setMode('idle'); };
  useEffect(() => () => { alive.current = false; version.current++; source.current?.stop(); cue.current = null; void context.current?.close(); }, []);
  const sample = async () => {
    stop(); const current = version.current; setError('');
    try {
      const audio = context.current ||= new AudioContext(); await audio.resume();
      const response = await fetch('/persona/sample.wav'); if (!response.ok) throw Error('The local sample could not be loaded.');
      const buffer = await audio.decodeAudioData(await response.arrayBuffer());
      if (!alive.current || current !== version.current) return;
      const node = audio.createBufferSource(); source.current = node; node.buffer = buffer; node.connect(audio.destination);
      const startedAt = audio.currentTime;
      cue.current = { text: 'Did the export tests pass?', samples: buffer.getChannelData(0).slice(), sampleRate: buffer.sampleRate, duration: buffer.duration,
        startedAt, now: () => audio.state === 'running' ? audio.currentTime : NaN };
      node.onended = () => { node.disconnect(); if (current === version.current && alive.current) { source.current = undefined; cue.current = null; setMode('idle'); } };
      setMode('speaking'); node.start(startedAt);
    } catch (e) { if (alive.current && current === version.current) { setError(e instanceof Error ? e.message : 'Sample playback failed'); setMode('idle'); cue.current = null; } }
  };
  return <main className="dp-preview">
    <header className="dp-preview-heading"><div><span className="eyebrow">DRAKEN / PERSONA STUDIO</span><h1>A little warmth.<br />A clear head.</h1></div><a className="btn btn-secondary" href="/">Back to Draken</a></header>
    <div className="dp-preview-scene"><PersonaStage mode={mode} playback={cue} /></div>
    <section className="dp-preview-controls" aria-label="Persona preview controls">
      {(['idle', 'listening', 'thinking'] as const).map(state => <button key={state} className="btn btn-secondary" aria-pressed={mode === state} onClick={() => { stop(); setMode(state); }}>{state}</button>)}
      <button className="btn btn-primary" onClick={() => void sample()}>Play speech sample</button>
      <button className="btn btn-secondary" onClick={stop} disabled={mode !== 'speaking'}>Stop sample</button>
    </section>
    {error && <p role="alert">{error}</p>}
    <p className="muted small">Standalone presentation module. No microphone, login, model request, or session data. The sample is generated speech. Mouth timing follows audio energy and approximate English text cues, not exact phoneme alignment.</p>
    <details className="dp-reference"><summary>Character reference</summary><img loading="lazy" src="/persona/reference.jpg" alt="The original illustrated mechanical Draken dragon with wooden jaw and wings, amber eyes, ivory horns, and mustard knitwear." /><p className="small muted">Based on the exact illustration from draken.mehanig.com. The beanie and seated workshop scene are a new 3D interpretation.</p></details>
  </main>;
}
createRoot(document.getElementById('root')!).render(<PersonaPreview />);
