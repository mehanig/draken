# ChatGPT voice calls

**Draken has one voice engine: subscription-backed ChatGPT live voice.** It uses the pinned official Codex helper and a separate native sign-in to the same paid ChatGPT account. Microphone audio and bounded context go to OpenAI over a persistent browser audio connection.

The former Whisper → pi → Kokoro engine has been removed, including its Python worker, installer, browser speech detector and execution endpoints. Old call records are still readable; they are not a second working voice option. There is no local-speech, Platform API-key or alternative-provider fallback.

## Setup

```sh
npm run voice:realtime:setup
npm run voice:realtime:login        # Complete the official ChatGPT device sign-in
npm run voice:realtime:check        # Local prerequisites only; not an audio test
npm run voice:realtime:probe -- --allow-provider  # Explicit provider use, synthetic audio
npm start
```

No voice-mode setting is needed. An existing `DRAKEN_VOICE_MODE=native` remains accepted so installed launchers keep working. Any other value, including `local`, fails startup rather than silently changing an old privacy choice into cloud audio. Remove obsolete local speech settings from launchers; `voice:setup` no longer exists.

The helper and its credentials live under `~/.draken/realtime/`, outside the checkout. Provider credentials never enter the browser. Pi credentials are not copied or converted. Preserve the existing database, dashboard credentials and TLS configuration when updating an installation. No snapshot regeneration is needed to enable voice.

This uses an experimental native interface, not a stable public embedding API. Successful setup or a connection handshake is not proof that an account can receive usable audio. The opt-in probe tests actual audio separately. Quota, idle accounting, coding-allowance impact and future compatibility are not established.

## Start and use a call

1. Open Draken on **localhost or trusted HTTPS**. Plain LAN HTTP normally cannot access the microphone.
2. **Sync with Draken** collects available entries, prepares a snapshot with short prior-sync recaps, then opens its call. On an existing prepared sync, use **Call Draken**.
3. Wait for any needed history download/indexing to finish on a dedicated preparation screen; the microphone remains off and the dragon is not shown yet. Then allow microphone access. A failed or cancelled preparation does not request permission, and if the page is hidden when preparation finishes, start the call again explicitly. You can also type if microphone permission is unavailable.
4. Speaker-safe mode pauses input during replies. Use **Stop reply** to speak, or enable **Headphone mode** to allow spoken interruption. Headphones are recommended.
5. **Mute** releases the microphone tracks. **Stop reply** cuts playback locally and asks the provider to stop; it does not prove immediate remote cancellation. **End call** stops capture/playback and keeps the text history.

Capture follows a transient browser action, never a URL flag. Reloading or opening `/syncs/:id` does not restart the microphone. Failed preparation, a hidden page, denied permission or an ended connection requires explicit recovery. There is no automatic reconnect or fallback voice engine.

Reply waiting is owned by the server's identified user transcript and pending-answer events. Unkeyed WebRTC user events can arrive late and must not switch an already pending reply back to listening, erase its waiting caption, or restart a settled reply. A lookup acknowledgement such as “I’ll check what’s recorded” is not meant to end the answer. Draken keeps the question pending and can automatically resume ChatGPT speech when its context arrives; you should not need to ask “have you checked?” Quiet captions in the dragon scene show **[Thinking...]**, **[Hmmm...]** and **[Hmmmmmm...]** during a pending reply, including silence after an acknowledgement. They change every five seconds without animation. **[Checking...]** and **[Looking that up...]** are used only while the local history worker reports fresh lookup activity; these labels are not proof of a match or exhaustive search. These are visual waiting cues—not the model’s private thoughts, spoken messages, a percentage or an ETA. They are never saved in the transcript or sent to the model. The separate waiting banner and elapsed-wait timer have been removed. Stop, a newer question, interruption, or ending the call cancels the old pending continuation. There is at most one automatic completion cue per question—not a retry loop or a fabricated user message. A failed lookup must be disclosed; a failed or silent continuation produces a visible notice instead of silently retrying.

One call may be active at a time, with a 30-minute limit, at most 60 user messages and a 90-second disconnect timeout. These are resource limits, not spending guarantees. A new call cannot start until helper cleanup is confirmed.

## Evidence, records and recap

- Voice questions do **not** start pi, local transcription or local synthesis. The call receives a bounded briefing, saved notes and source excerpts. Explicit source/history questions can request more data from the same frozen snapshot. Calls automatically prepare and use bounded semantic + keyword retrieval across retained older records, using the local index described in [MEMORY.md](MEMORY.md). No scope/setup switch is required; first use may take longer while the local model/index is prepared. Initial indexing progress is visible before the dragon appears. Expand **Conversation & details** for the full transcript, sources and any later history progress. Optional **Settings → Automatically index history** prewarms local search in idle batches; it never starts capture, calls or provider summaries. This block starts collapsed for every call; its progress polling reads metadata only. Those dated excerpts also go to ChatGPT; they are not new snapshot evidence. The embedding runtime is text-only and is not a replacement speech engine.
- The read-only lookup service is not a coding model or a general web search. Tool-execution and approval requests are denied. Calls cannot edit files, deploy work, save decisions by model instruction, finish syncs or advance coverage.
- Speech may paraphrase. **Sources supplied** means context was given to the model, not that every spoken claim was verified. Responses are not held for whole-answer JSON validation before playback.
- History stores ordered user/assistant messages with generated/interrupted labels. It does not invent question–answer pairs, exact played words, human hearing or agreement. Historical records from the retired engine retain their original playback reports and are labelled separately.
- No raw microphone recording is persisted locally. Text, source references and call status are stored in the private SQLite database. There is no retention/purge UI yet.
- Ending the call does not mark the sync reviewed. Closing the call UI requests a short text recap through pi using the sync's cheaper summary model. This is separate from live audio; a browser exit cannot guarantee the request is sent or completes. You can explicitly refresh the recap later.

See [the native implementation guide](voice/realtime/README.md) for packet limits, helper restrictions, recall rules and verification details. Provider retention and exact subscription accounting are not promised by Draken.

## Animated dragon

The local 3D dragon follows received audio energy, not exact words or phonemes. Its drawing code cannot capture audio, call a model or change records. Silence and stopped playback close its mouth. Drawing failure leaves a still image without disabling the call.

Live subtitles appear over the bottom of the call scene, labelled **You** or **Draken**. They show a bounded window of the latest transcript, not word-timed audio alignment; the complete text remains in the collapsed **Conversation & details** block. Captions also work over the static fallback image. Errors and recovery buttons remain visible outside that block. There is no animation-control overlay. The separate `/persona.html` preview uses a stored sample without microphone access, sign-in or model use. See [PERSONA.md](PERSONA.md).

## LAN microphone access

Use an existing **trusted HTTPS reverse proxy** preserving Host/Origin, or the built-in TLS listener:

```sh
npm run voice:tls -- --host 192.168.1.20    # Use your actual server address
```

This creates a private local certificate authority and a server certificate, then prints settings like:

```sh
DRAKEN_HTTPS_PORT=44433
DRAKEN_TLS_CERT=/absolute/path/to/draken-server.crt
DRAKEN_TLS_KEY=/absolute/path/to/draken-server.key
DRAKEN_TLS_CA=/absolute/path/to/draken-local-root.crt
```

Export them alongside your existing authenticated LAN configuration and restart Draken while idle. `.env` is not loaded automatically. The command does not change firewall rules, install system trust, change dashboard credentials or expose Draken to the internet.

### One-time browser trust

In the voice card, open **First-time browser setup** and download the public certificate using your dashboard login. Compare its fingerprint with the TLS setup output. Trust **only your own** `draken-local-root.crt`:

- **Windows:** open the certificate → Install Certificate → Current User → Trusted Root Certification Authorities.
- **macOS:** import into the login keychain → open its Trust section → Always Trust.
- **Firefox:** Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import; trust it to identify websites.
- **Chromium/Linux:** use your browser/platform certificate manager. Firefox trust settings do not necessarily apply to Chromium.

Restart the browser if needed, visit `https://your-server:44433`, sign in and allow the microphone when starting a call. HTTPS is a separate browser origin, so an HTTP login is not automatically transferred. Dismissing a certificate warning is not the supported setup.

Keep both `.key` files private. The authenticated download route re-encodes only the public certificate. Rerunning TLS setup preserves the CA and reuses valid matching certificates; it renews certificates near expiry or with changed hostnames. There is no renewal daemon.

### SSH alternative

If you already have trusted SSH access, forward Draken to your own localhost:

```sh
ssh -N -L 40333:192.168.1.20:40333 your-user@192.168.1.20
# Open http://localhost:40333 on the client computer.
```

The localhost browser exception permits microphone access; SSH encrypts the connection. Dashboard authentication is still required for an authenticated server.

## Server settings

| Variable | Purpose |
|---|---|
| `DRAKEN_CODEX_BIN`, `DRAKEN_CODEX_HOME` | Trusted operator/test overrides for the pinned helper and its account directory |
| `DRAKEN_HTTPS_PORT` | Optional second listener |
| `DRAKEN_TLS_CERT`, `DRAKEN_TLS_KEY` | Certificate and key for that listener |
| `DRAKEN_TLS_CA` | Optional public certificate download |
| `DRAKEN_TLS_DIR` | TLS setup output; defaults to `<data dir>/runtime/tls` |

There are no per-call model selectors or API keys. Native helper version and native-auth checks still apply to operator overrides.

## Verification

```sh
npm run check
npm test
npm run test:ui
npm run test:live:browser
npm run test:realtime:browser
npm run test:realtime:native

# Explicit provider use, synthetic data/audio, isolated database:
DRAKEN_TEST_STATIC_DIR=/path/to/staged/frontend npm run test:live:real -- --allow-provider

# Focused real-voice proof with one spoken question and a controlled delayed lookup:
DRAKEN_TEST_STATIC_DIR=/path/to/staged/frontend node tests/voice-continuation-real.cjs --allow-provider
```

Ordinary tests use temporary records, a fake native helper and real local browser peers carrying synthetic audio. They test the native-only UI, controls, drawing failure, source lookup, history, no-capture-on-reload, absent old endpoints and preservation of old records. The text-model fake is used only for sync preparation and recaps, not voice turns.

The synthetic WAV fixture is not a human recording. Synthetic peers and injected audio do not establish physical microphone quality, speaker echo, Bluetooth behavior, mobile performance or other-browser support. Those still need hands-on testing. The separately opted-in real-provider test is not part of ordinary tests.
