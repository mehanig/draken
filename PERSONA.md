# Draken’s 3D call persona

The call window now contains a local, animated mechanical dragon in a furnished workshop. This is an **initial procedural 3D interpretation**, not a photoreal reconstruction or camera/video feed. The reference is the actual illustration from [Draken’s homepage](https://draken.mehanig.com/): `site/img/scene1-web.jpg`, copied unchanged to `client/public/persona/reference.jpg`.

The character keeps its blue-gray mechanical shell, red wooden jaw/wing struts, amber eyes, ivory horns and mustard knitwear, with a knitted beanie. The call uses a closer, nearly frontal portrait with an uncluttered oak desk and chair. A dusk window, warm floor lamp and single plant sit in a softly blurred room behind the sharp character. Busy slats, shelves, clock, print and desktop accessories have been removed; lower-contrast wood/knit textures and matte wood reduce visual noise. Materials and lighting aim for a warm, tangible setting; the geometry remains deliberately stylized. A professionally sculpted/textured character would be a separate art pass.

## Try it separately

Open **`/persona.html`** on your Draken server. In development:

```sh
npm --prefix client ci
npm run dev:client
# Open http://localhost:3000/persona.html
```

The preview offers listening/thinking poses, a generated speech sample, pause and the original reference. It does not request a microphone, authenticate, read sessions, or invoke a model. Everything is served locally. The call integration mounts the same component only while its dialog is active. Calls keep the dragon prominent, with a lightweight DOM subtitle layer at the bottom of the scene. It shows live transcript excerpts or bracketed waiting cues; the full transcript/details block is collapsed by default. There is no workshop label or animation-button overlay. Preview chrome is an explicit `studioControls` option; the preview keeps its pause/retry controls.

## Boundaries

```text
voice/live-session.ts — owns the ChatGPT call and audio
  └─ optional onPlayback(PlaybackCue | null)
       └─ VoiceCall.tsx stores a ref and maps call phase to PersonaMode
            └─ persona/PersonaStage.tsx — lifecycle, visibility, lazy loading
                 ├─ scene.ts — WebGL renderer, lighting, camera
                 ├─ dragon.ts — articulated character
                 ├─ studio.ts — separated background / foreground furniture
                 ├─ background.ts — cached, separable Gaussian room blur
                 ├─ geometry.ts — materials and disposable GPU resources
                 └─ motion.ts — pure motion / audio-envelope math
```

`client/src/audio/playback.ts` is a presentation-only contract. Live calls supply a read-only energy meter and audio clock. The standalone preview supplies its stored sample's text, PCM samples, duration and playback clock. The renderer cannot start/stop speech, submit a turn, write notes, access auth or finish a sync. Observer exceptions are contained by the audio controller. Live voice optionally supplies only a read-only received-energy getter and audio clock, with no PCM retention or invented phoneme alignment. The persona itself requires no server/schema/model dependencies.

`types.ts` describes the small pose/scene interface. A future authored mesh or glTF rig can replace `dragon.ts` and map the existing pose values to bones/morph targets; call logic and the room do not need to change. No glTF loading or external avatar service is implemented in this version.

## Animation and timing

- The standalone preview derives jaw energy from its **stored sample's decoded audio**. Its text supplies approximate English mouth shapes. This preview does not synthesize speech or provide another call engine.
- Native live voice follows actual received energy through the same presentation boundary. It does not estimate phonemes from a growing transcript; mute/stop, silence and suspended output produce a closed mouth.
- Timing uses the same `AudioContext.currentTime` as playback—not response arrival or a looping “talk” animation. Silence, chunk boundaries, interruption, suspended audio and hang-up close the mouth.
- Idle breathing/blinks, listening/thinking head poses, speaking gestures and question tilt are procedural. They are not model-generated emotions or evidence of attention/understanding.
- This is **heuristic lip synchronization**, not forced phoneme alignment. Accents, names and speech rate can misalign individual shapes.
- Pausing motion in the preview or an OS reduced-motion preference keeps a static pose without changing audio. Offscreen/hidden scenes stop drawing. Hang-up disposes textures, geometry, materials, shadows, environment maps, timers and the WebGL context.

## Performance and failure behavior

The Three.js scene is loaded lazily (about 140 kB gzip for the scene/engine chunk), not with the ordinary sync page. No CDN, remote textures/fonts, webcam, extra voice API or rendering server is involved. The reference, a WebP poster matching the new framing/blur, generated demo WAV and Three.js MIT license are local assets.

Hardware rendering is capped at 30 fps while speaking / 18 fps otherwise, DPR 1.5 and 900,000 pixels. Known software renderers use an economy profile: 10 fps, at most 160,000 pixels, no dynamic shadows, clearcoat or cloth sheen. This is visibly less detailed, but keeps graphics from overwhelming audio/control responsiveness. A timer between animation frames avoids continuously asking the browser to composite at 60 fps. These are caps, not promised frame rates.

The room is rendered and blurred only on initialization/resize; each animation frame composites that cached texture behind the sharp dragon and desk. This is layered call-style background separation, not a full optical depth-of-field simulation. Both rendering profiles use it. Blur targets/materials are disposed with the renderer.

WebGL initialization/context loss switches to the static poster; voice continues independently. The call fallback retains the same live subtitle layer and an accessible scene description. Captions are presentation only and do not drive speech or write records. The standalone preview retains its retry button and **Pause animation** control. The preview and call were exercised in Chromium, including its software renderer. Physical mobile GPUs, Safari, Firefox and long-session battery behavior are not yet verified.

## Verification

```sh
npm test                 # Includes pure audio-clock/pose and module-boundary checks
npm run test:ui          # Includes preview, reduced motion, context loss and call regressions

# Explicit opt-in: synthetic evidence/audio, real ChatGPT voice, staged frontend:
DRAKEN_TEST_STATIC_DIR=/path/to/stage node tests/live-voice-real.cjs --allow-provider
```

Browser checks cover a chrome-free call image, cached blur reuse/resize, high-quality shader compilation (also exercised on software GL), audible sample mouth motion, stopping, desktop/mobile sizing, local-only requests, no preview microphone access, WebGL loss/retry, unavailable WebGL during a working call, and context disposal on hang-up. Native controller/peer tests cover speaker/headphone gating, interruption, mute, permission refusal and cleanup. Main UI tests cover supplied sources, generated/interrupted history, explicit retry and preservation of retired-engine records. No production snapshot is changed by these tests.
