# ChatGPT voice calls

**Draken has one voice engine: subscription-backed ChatGPT live voice.** It uses the pinned official Codex helper and a separate native sign-in to the same paid ChatGPT account. Microphone audio and bounded context go to OpenAI over a persistent browser audio connection.

The former Whisper → pi → Kokoro engine has been removed, including its Python worker, installer, browser speech detector and execution endpoints. Old call records are still readable; they are not a second working voice option. There is no local-speech, Platform API-key or alternative-provider fallback.

## Setup

After [installing Draken](SETUP.md#install-and-start), run:

```sh
draken voice setup
draken voice login          # Complete the official ChatGPT device sign-in
draken voice status         # Local prerequisites only; not an audio test
draken                     # Start the server if it is not already running
```

No voice-mode setting is needed. An existing `DRAKEN_VOICE_MODE=native` remains accepted so installed launchers keep working. Any other value, including `local`, fails startup rather than silently changing an old privacy choice into cloud audio. Remove obsolete local speech settings from launchers; `voice:setup` no longer exists.

Setup runs npm's resolved JavaScript entry under the current Node executable, without a shell or command-shim evaluation. On Windows x64/arm64, status/login/calls launch the pinned official package's `codex.exe` directly, so the owned child is the native process rather than a `.cmd`/Node wrapper. HOME and Windows profile directories are private to the voice account. Runtime installation/version checks do not qualify sign-in, refresh, WebRTC or physical audio.

The helper and its credentials live under `~/.draken/realtime/`, separate from the installed application. Provider credentials never enter the browser. Pi credentials are not copied or converted. Preserve the existing database, dashboard credentials and TLS configuration when updating an installation. No snapshot regeneration is needed to enable voice.

This uses an experimental native interface, not a stable public embedding API. Successful setup or a connection handshake is not proof that an account can receive usable audio. The opt-in probe tests actual audio separately. Quota, idle accounting, coding-allowance impact and future compatibility are not established.

## Chat instead

For a keyboard-only conversation, choose **Chat instead** on Home or next to **Call Draken**. This is a separate `/syncs/:id/chat` surface, not a muted call. It uses the configured text model through pi and requires no microphone permission, WebRTC connection or native ChatGPT sign-in. It shows a square Draken portrait, searching/thinking status, saved messages and source links. Its model access/quota is separate from the native voice account. See [the text-chat guide](README.md#text-chat).

Choosing chat while a one-click call is still preparing consumes that browser call intent; preparation can finish without opening a microphone. Returning to **Voice & call history** never automatically starts a call. Existing voice history remains preserved and separately labelled.

## Start and use a call

1. Open Draken on **localhost or trusted HTTPS**. Plain LAN HTTP normally cannot access the microphone.
2. **Sync with Draken** finishes importing each discovered file's captured prefix, prepares the briefing and searchable history, then opens its call. Import errors stop preparation instead of silently freezing an old prefix. On an existing sync, **Call Draken** stays disabled until both are ready. If imported history has changed, use **Prepare history** first. An already-ready sync also offers **Refresh history** to capture later work without rebuilding its frozen briefing.
3. Any needed history download/indexing happens on the sync page, before a call can start. Progress and **Cancel preparation** are available there; the microphone remains off. Once ready, start the call and allow microphone access. A failed or cancelled preparation does not request permission, and if the page is hidden when preparation finishes, start the call again explicitly. You can also type if microphone permission is unavailable.
4. Speaker-safe mode pauses input during replies. Use **Stop reply** to speak, or enable **Headphone mode** to allow spoken interruption. Headphones are recommended.
5. **Mute** releases the microphone tracks. **Stop reply** cuts playback locally and asks the provider to stop; it does not prove immediate remote cancellation. **End call** stops capture/playback and keeps the text history.

Capture follows a transient browser action, never a URL flag. Reloading or opening `/syncs/:id` does not restart the microphone. Failed preparation, a hidden page, denied permission or an ended connection requires explicit recovery. There is no automatic reconnect or fallback voice engine.

Reply waiting is owned by the server's identified user transcript and pending-answer events. Unkeyed WebRTC user events can arrive late and must not switch an already pending reply back to listening, erase its waiting caption, or restart a settled reply. A lookup acknowledgement such as “I’ll check what’s recorded” is not meant to end the answer. Draken keeps the question pending and can automatically resume ChatGPT speech when its context arrives; you should not need to ask “have you checked?” Quiet captions in the dragon scene show **[Thinking...]**, **[Hmmm...]** and **[Hmmmmmm...]** during a pending reply, including silence after an acknowledgement. They change every five seconds without animation. **[Checking...]** and **[Looking that up...]** are used only while the local history worker reports fresh lookup activity; these labels are not proof of a match or exhaustive search. These are visual waiting cues—not the model’s private thoughts, spoken messages, a percentage or an ETA. They are never saved in the transcript or sent to the model. The separate waiting banner and elapsed-wait timer have been removed. Stop, a newer question, interruption, or ending the call cancels the old pending continuation. There is at most one automatic completion cue per question—not a retry loop or a fabricated user message. A failed lookup must be disclosed; a failed or silent continuation produces a visible notice instead of silently retrying.

Work questions use original project evidence and preserve the project across follow-ups; old conversation recall remains available when explicitly requested. History is captured at the displayed preparation cutoff, not observed live. The helper can refine a lookup or read a longer H source. Each turn allows three distinct lookups, with source packets bounded to 7,000 UTF-8 bytes (the native context envelope is bounded to 8 KiB). Supplied source IDs belong to that turn; they are not proof that each generated claim was verified. The larger text-chat reconciliation packet and bounded pi answer-repair pass do not apply to streaming native voice; this call path retains its existing lookup budget. See [MEMORY.md](MEMORY.md) for retrieval limits.

One call may be active at a time, with a 30-minute limit, at most 60 user messages and a 90-second disconnect timeout. These are resource limits, not spending guarantees. A new call cannot start until helper cleanup is confirmed. The browser chooses its reservation UUID before sending creation, so End can release a reservation even if the create response is lost. If End overtakes creation, the server retains a bounded cancellation marker for five minutes; an already-created ID can never be reused. Network loss can still require the disconnect timeout or explicit End previous call.

## Evidence, records and recap

- Voice questions do **not** start pi, local transcription or local synthesis. The call receives a bounded briefing, saved notes and source excerpts. Explicit source/history questions can request more data from the same frozen snapshot. Calls use bounded semantic + keyword retrieval across retained older records, using the local index described in [MEMORY.md](MEMORY.md). The local model/index must be prepared before calling is enabled; first preparation may take minutes. During the call, retrieval uses that prepared cutoff and verifies original sources without building new corpus embeddings. Expand **Conversation & details** for the full transcript, sources and any later history progress. Optional **Settings → Automatically index history** prepares that same call/search history in idle batches of at least 64 changed source records; it never starts capture, calls or provider summaries. Smaller batches wait for explicit preparation, and keep Call disabled if history is not ready. This block starts collapsed for every call; its progress polling reads metadata only. Those dated excerpts also go to ChatGPT; they are not new snapshot evidence. The embedding runtime is text-only and is not a replacement speech engine.
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

Use an existing **trusted HTTPS reverse proxy** preserving Host/Origin, or the built-in TLS listener. For the latter, the globally installed npm package includes a certificate helper. It requires **OpenSSL** on PATH. In Bash or PowerShell, run:

```sh
npm --prefix "$(npm root -g)/draken" run voice:tls -- --host 192.168.1.20
```

Use your actual server address. This runs the helper from the installed package; no repository clone or build is needed.

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

## Verification and limits

`draken voice status` checks local helper/sign-in metadata. It does not establish provider access, usable audio, microphone quality, speaker echo, Bluetooth behavior or support for every browser/device. Test those explicitly with your intended account and device.

Automated checks and optional real-provider probes are documented in [CONTRIBUTING.md](CONTRIBUTING.md#voice-qualification). They are contributor tools, not installation prerequisites. Ordinary tests use temporary synthetic records and audio; real-provider probes require explicit consent and are not part of the ordinary suite.
