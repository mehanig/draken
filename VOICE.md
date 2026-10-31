# Voice-call prototype

**Talk to Draken through the same configured pi login.** No separate OpenAI voice API, API key, account, or voice subscription is required. This is a local speech pipeline around pi's text model—not OpenAI's native Realtime service or a promise of ChatGPT Voice latency.

## Use it

1. Install local speech once on the server: `npm run voice:setup`.
2. Open Draken on **localhost or trusted HTTPS**. The LAN instructions below matter: ordinary `http://192.168.…` cannot normally access a browser microphone.
3. Prepare a sync's briefing, then click **Call Draken** and allow microphone access. An unfinished briefing is not silently resumed by the call.
4. Speak naturally. A roughly 0.7-second pause sends a turn. **Speaker-safe mode is the default:** speech detection pauses during the whole reply and resets after the speaker tail, so output cannot interrupt itself. Use **Stop reply** to interrupt. If you wear headphones, enable **Headphone mode** for automatic interruption by speaking. **Mute** stops microphone tracks; **Type a question** also works when microphone permission is unavailable.
5. **End call** (or Escape) stops capture/playback and keeps the text history. Review/edit your decisions on the page afterward. Ending a call **does not finish the sync** or mark anything reviewed.

A short greeting is generated locally without a model request. Recognized speech and typed questions use pi. A malformed model response gets one formatting repair before any speech; the call shows **Preparing the spoken reply…** while it works. If that also fails, listening resumes and **Retry question** submits a new turn without restarting the call. The call stays anchored to the current **frozen snapshot**; later coding activity belongs to your next sync.

Headphones are recommended. Echo cancellation and noise suppression are requested, but real speaker/microphone feedback, background conversations, accents, Bluetooth routing and mobile browser behavior still need hands-on evaluation. The current speech models are English-only. Chromium on Linux is the tested browser/server combination; other platforms are not claimed verified.

## Animated call persona

Calls now show a local 3D interpretation of the homepage’s mechanical dragon, seated in a warm workshop. The jaw follows decoded speech energy and approximate English text shapes on the actual playback clock; interruption and silence stop it. Idle/listening/thinking poses are procedural, not model-generated emotions. This is an animated illustration, **not a webcam or native video service**.

The call image has no captions or animation controls. Closer portrait framing, a clear desk and a softly blurred background keep attention on the dragon. OS reduced-motion preferences and a static WebGL-failure fallback leave audio working; **Pause animation** and retry controls remain in the standalone preview. Known software renderers automatically use reduced detail/frame rate. No new permissions, model calls or external assets are required. Try the independent `/persona.html` preview without a microphone or sync. See [PERSONA.md](PERSONA.md) for the modular interface, limitations and tests.

## Local speech installation

```bash
npm run voice:setup
npm run voice:setup -- --check    # hashes + local synthesis smoke test; no pi request
```

The explicit installer downloads a pinned uv binary, Python 3.12 if needed, Python dependencies, Whisper `base.en`, Kokoro v1.0 int8, and voice weights. Model/uv archives are SHA-256 checked; model files are installed atomically. It needs internet access during setup, roughly 270 MB of model downloads plus Python/dependencies, and no sudo or Docker. Existing matching models and the virtual environment are reused. Linux/macOS installer targets are included; only Linux x64 has been exercised.

Defaults live in `~/.draken/voice/`, **not the repository**. Runtime speech has model downloads and Hugging Face telemetry disabled. One warm CPU process handles recognition and synthesis; it is started by a call, not by browsing your session history. Four threads are the default. Ending the call releases audio/turn state; the models remain warm until server shutdown.

### LAN microphone access

Use an existing **trusted HTTPS reverse proxy** preserving Host/Origin, or the built-in optional TLS listener:

```bash
npm run voice:tls -- --host 192.168.1.20    # use your actual server address
```

This generates a private local certificate authority and a server certificate, then prints these environment settings:

```bash
DRAKEN_HTTPS_PORT=44433
DRAKEN_TLS_CERT=/absolute/path/to/draken-server.crt
DRAKEN_TLS_KEY=/absolute/path/to/draken-server.key
DRAKEN_TLS_CA=/absolute/path/to/draken-local-root.crt
```

Export those settings alongside your existing **authenticated LAN configuration**, restart Draken, and permit the HTTPS port on your trusted LAN if necessary. `.env` is not auto-loaded. HTTP stays available at the existing port; use HTTPS for normal LAN use. The TLS command does **not** alter firewall rules, install a system trust anchor, change dashboard credentials, or expose a service to the internet.

**One-time client trust:** on your other computer, open **First-time browser setup** in the voice card and download the public certificate using your dashboard login. Compare its fingerprint with the TLS setup command's output. Install **only your own** `draken-local-root.crt`:

- **Windows:** open certificate → Install Certificate → Current User → Trusted Root Certification Authorities.
- **macOS:** Keychain Access → login keychain → import certificate → open its Trust section → Always Trust.
- **Firefox:** Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import; trust it to identify websites.
- **Chromium/Linux:** import the certificate through your browser/platform's certificate manager. Certificate-store paths differ by browser release; do not assume Firefox's import affects Chromium.

Restart the browser if necessary, visit `https://your-server:44433`, sign in with the **same dashboard credentials**, and allow the microphone on starting a call. HTTPS is a separate browser origin, so an existing HTTP login is not automatically transferred. Merely dismissing a certificate warning is not the supported setup.

Keep **both `.key` files private**. A trusted local CA is security-sensitive: its key can sign certificates. The app's authenticated certificate route parses/re-encodes only the public certificate and never serves a key. Rerunning TLS setup preserves the CA and reuses a valid matching server certificate; certificates nearing expiry or requiring a new hostname are renewed. No renewal daemon is installed.

**Alternative, no certificate installation:** if you already use SSH to the server, forward its HTTP listener to your own localhost:

```bash
ssh -N -L 40333:192.168.1.20:40333 your-user@192.168.1.20
# Then open http://localhost:40333 on the client computer.
```

The browser's localhost secure-context exception permits the microphone, and SSH encrypts the connection. Existing dashboard authentication is still enforced. This requires an available local port and an existing trusted SSH login.

## Data, permissions and limits

- **Speech recognition and synthesis run on the Draken server.** Browser audio travels only to that server. No Web Speech recognition service, CDN-hosted model, or cloud TTS is used.
- **Text goes to the configured pi provider:** recognized/typed question, bounded briefing/excerpts, saved decisions and recent discussion. The existing subscription's limits still apply; this is not unlimited or guaranteed free usage. Draken cannot see your remaining ChatGPT quota or invoice.
- Pi runs tool-free, outside project checkouts, with no session persistence, extensions, MCP, skills, templates, context discovery, or automatic catalog updates. Credentials remain with pi and never enter the browser or Python speech worker.
- Raw microphone audio and generated WAVs are **not recorded to disk**. Text questions, generated answers, source IDs, errors, timing and playback confirmations are stored in the private SQLite database. There is no retention/purge UI yet.
- Only completely played, browser-confirmed chunks enter ordinary discussion as heard text. Interrupted/failed turns are marked explicitly. Full generated text remains inspectable in call history. Playback confirmation is a client receipt, not proof a human heard or agreed with it.
- Speech starts only after the **entire reply** passes schema and exact known-source validation. Draken reads pi's successfully settled final assistant message, not provisional model deltas. A formatting/schema failure gets at most **one same-model repair**, with the original evidence and rejected answer supplied for revalidation. Prose, arrays, concatenated objects and unknown IDs are not spoken or silently accepted. If repair fails, no answer is synthesized and the turn is marked failed. Provider/network errors are not automatically retried. Sentence-by-sentence synthesis still overlaps playback after validation.
- Formatting diagnostics log only the turn ID, attempt number, response-shape category and validation error—not raw rejected text, prompts or source excerpts. Rejected output is held temporarily for repair, not persisted as an answer.
- Reference existence **does not prove semantic support**. Voice includes the sources cited by its bounded briefing, notes and recent discussion, plus lexical retrieval, within 64 excerpts / roughly 16,000 excerpt characters—not a search of all history. Explicitly requested sources take priority. Every citation left visible in that narrative has a supplied excerpt; unavailable or over-budget input citation markers are labeled as unavailable instead of advertising sources the validator would reject. The frozen briefing and notes themselves are unchanged. Returned source IDs still require exact validation; none are guessed or silently discarded. The model can still be wrong or miss facts. It has no execution, save-notes, finish-sync, Git or deployment tools.
- One active call across tabs/devices; 30 minutes and 60 submitted turns per call. These are resource limits, **not spending caps**. Recording segments are bounded to about 40 seconds in the browser and 45 seconds on the server. Short/no-speech recordings do not initiate pi.
- A 10-second heartbeat maintains the call; a disconnected call expires after 90 seconds. Reload/navigation ends capture and requests hang-up; the lease is the fallback. Microphone capture never resumes automatically after reload or server restart.
- Interruption cancels pi and drops queued/late audio. Native local inference may finish before its result is discarded. Provider-side cancellation/accounting is best-effort.
- Notes, source snapshots and coverage cannot be changed through a call. Other sync mutations are blocked while it is active. Compression is not rerun. Background listening outside an explicitly started call is not implemented.

### Server-only options

| Variable | Default |
|---|---|
| `DRAKEN_PI_VOICE_MODEL` | Current sync's summary model (normally `openai/gpt-6-luna`) |
| `DRAKEN_VOICE_DATA_DIR` | `<DRAKEN_DATA_DIR>/voice` |
| `DRAKEN_VOICE_THREADS` | `4` |
| `DRAKEN_VOICE_SPEAKER` | `af_heart` |
| `DRAKEN_VOICE_PYTHON` | `<voice data dir>/venv/bin/python` |
| `DRAKEN_VOICE_WORKER` | Packaged `voice/worker.py`; override is intended for tests |
| `DRAKEN_HTTPS_PORT` | Unset; optional second listener |
| `DRAKEN_TLS_CERT`, `DRAKEN_TLS_KEY` | Certificate/key paths for that listener |
| `DRAKEN_TLS_CA` | Optional public certificate download for client setup |
| `DRAKEN_TLS_DIR` | TLS setup script's output directory; defaults to `<data dir>/runtime/tls` |

No per-call model, budget or permission controls are added. Voice shares a **60-second model deadline across the initial answer and its optional repair**, and never falls back to a more expensive model automatically. A submitted turn normally uses one pi invocation and can use at most two; the 60-turn call limit is not a 60-invocation or spending cap.

## Verification

```bash
npm test
npm run test:ui
npm run voice:setup -- --check

# Explicit opt-in: one real voice turn (up to two pi invocations), synthetic evidence, isolated DB.
node tests/voice-real.cjs --allow-provider
node tests/voice-real.cjs --allow-provider --browser
node tests/voice-real.cjs --allow-provider --browser --overview
```

Normal test commands use fake pi/audio workers and temporary synthetic sessions. Browser tests exercise actual same-origin Silero VAD with a generated speech fixture, playback, microphone feedback suppression, headphone-mode spoken interruption, mute, microphone refusal, typing, source inspection, mobile layouts, failure/retry, broad-overview formatting repair, explicit retry after unrepaired output, 37-source briefing regression, citation consistency above the 64-source budget, playback-receipt recovery, and reload cancellation. The opt-in test also exercises real local STT/TTS and the saved pi authentication; its browser mode includes the full speech round trip. Synthetic receipts in its non-browser mode are not claimed as audible playback.

Observed on the development machine: roughly **0.5 seconds for a short transcription**. The original sentence-streaming trials reached first audio in 3.6–6.2 seconds from model-request start, but real usage exposed unreliable model formatting. The current whole-reply approach prioritizes validation over early playback: two synthetic browser overview trials reached first audio in **7.3 seconds without repair** and **11.3 seconds with repair**. Two larger-snapshot browser checks with repair reached first audio in about **14 seconds**. Pause detection and transcription are additional. These are individual observations, not a latency guarantee; response length and provider latency vary. This is a usable turn-taking prototype, not established native-realtime parity. Physical room echo and perceived voice quality still need user testing.

The synthetic fixture `tests/fixtures/voice-question.wav` is generated speech, not a user's recording. Tests, model downloads, runtime databases, credentials and certificate keys must never be published as session evidence. Speech dependencies/model assets retain their upstream licenses: see [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [Kokoro ONNX](https://github.com/thewh1teagle/kokoro-onnx), and [Silero VAD](https://github.com/snakers4/silero-vad).
