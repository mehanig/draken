import { useEffect, useRef, useState } from 'react';
import type { PlaybackCue } from '../audio/playback';
import type { PersonaMode, PersonaScene } from './types';
import './persona.css';

export interface PersonaStageProps {
  mode: PersonaMode;
  /** Preview-only chrome; calls remain an uninterrupted image. */
  studioControls?: boolean;
  /** Read-only pull interface avoids React updates on every audio/animation frame. */
  playback: { readonly current: PlaybackCue | null };
}

export function PersonaStage({ mode, playback, studioControls = false }: PersonaStageProps) {
  const canvas = useRef<HTMLCanvasElement>(null), host = useRef<HTMLElement>(null);
  const input = useRef({ mode, playback }); input.current = { mode, playback };
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false);
  const [paused, setPaused] = useState(false), [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [retry, setRetry] = useState(0);
  const motion = !paused && !reduced; const moving = useRef(motion); moving.current = motion;
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches); query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    let disposed = false, scene: PersonaScene | undefined, frame = 0, timer = 0, visible = true;
    const element = canvas.current!, container = host.current!;
    const render = (now: number) => {
      frame = 0;
      if (disposed || !scene || document.hidden || !visible) return;
      scene.update({ mode: input.current.mode, motion: moving.current, playback: input.current.playback.current });
      try { scene.render(now / 1000); }
      catch { unavailable(); return; }
      // Do not keep the browser compositing at 60 fps between our actual draws.
      if (moving.current) timer = window.setTimeout(() => { timer = 0; start(); },
        1000 / Math.min(scene.maxFps, input.current.mode === 'speaking' ? 30 : 18));
    };
    const stop = () => { clearTimeout(timer); timer = 0; cancelAnimationFrame(frame); frame = 0; };
    const start = () => {
      clearTimeout(timer); timer = 0;
      if (!frame && !disposed && visible && !document.hidden) frame = requestAnimationFrame(render);
    };
    wake.current = start;
    const unavailable = () => {
      if (disposed) return;
      stop();
      const previous = scene; scene = undefined; previous?.dispose();
      if (!disposed) { setReady(false); setFailed(true); }
    };
    const resize = () => {
      if (scene) { const rect = container.getBoundingClientRect(); scene.resize(rect.width, rect.height); start(); }
    };
    const visibility = () => { if (document.hidden) stop(); else start(); };
    const lost = (event: Event) => { event.preventDefault(); unavailable(); };
    const observer = new ResizeObserver(resize); observer.observe(container);
    const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; if (visible) start(); else stop(); });
    intersection.observe(container); document.addEventListener('visibilitychange', visibility); element.addEventListener('webglcontextlost', lost);
    setFailed(false); setReady(false);
    // Heavy WebGL code is fetched only when this presentation is mounted.
    void import('./scene').then(({ createPersonaScene }) => {
      if (disposed) return;
      try {
        scene = createPersonaScene(element); resize();
        scene.update({ mode: input.current.mode, motion: moving.current, playback: input.current.playback.current });
        scene.render(performance.now() / 1000); setReady(true); start();
      }
      catch { unavailable(); }
    }).catch(unavailable);
    return () => {
      disposed = true; stop(); observer.disconnect(); intersection.disconnect();
      document.removeEventListener('visibilitychange', visibility); element.removeEventListener('webglcontextlost', lost);
      wake.current = () => {}; scene?.dispose();
    };
  }, [retry]);
  useEffect(() => { wake.current(); }, [mode, motion]);

  return <figure className="dp-stage" ref={host} data-renderer={failed ? 'fallback' : ready ? 'webgl' : 'loading'} data-motion={motion ? 'on' : 'off'} data-mode={mode}
    aria-label="Draken, a friendly mechanical dragon in a mustard beanie, seated at a wooden desk in a warmly lit workshop. Animated 3D illustration, not camera video.">
    <img className="dp-poster" src="/persona/call-poster.webp" alt="" onError={event => { if (!event.currentTarget.src.endsWith('/persona/reference.jpg')) event.currentTarget.src = '/persona/reference.jpg'; }} />
    <canvas key={retry} ref={canvas} className={`dp-canvas ${ready ? 'is-ready' : ''}`} aria-hidden="true" />
    {studioControls && <><figcaption className="dp-caption"><span className="dp-dot" />DRAKEN’S WORKSHOP<span className="dp-caption-sub">LOCAL 3D · NO CAMERA</span></figcaption>
    <div className="dp-tools">
      {failed ? <button type="button" onClick={() => setRetry(n => n + 1)}>Retry 3D scene</button> :
        <button type="button" disabled={reduced} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{reduced ? 'Reduced motion' : paused ? 'Resume animation' : 'Pause animation'}</button>}
    </div></>}
    {failed && <p className={studioControls ? 'dp-fallback' : 'sr-only'}>3D is unavailable. Your audio call is unaffected.</p>}
  </figure>;
}
