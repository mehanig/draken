# Experimental subscription-backed live voice

This is Draken’s native WebRTC voice backend, using the official **Codex 0.166.0 App Server** and a separate native ChatGPT sign-in to the same paid account. The browser has one persistent audio connection to OpenAI. It does not start pi, local transcription, or local synthesis for each question.

**Experimental, not a stable public embedding API.** Account/workspace access and future compatibility can change. A paid plan or successful SDP alone does not establish usable voice. There is no Platform API-key or alternative-provider fallback. This is the only voice engine. The local speech engine has been removed; only its historical call records remain readable.

## Operator setup

From a development checkout:

```sh
npm run voice:realtime:setup
npm run voice:realtime:login         # owner completes native ChatGPT device sign-in
npm run voice:realtime:check         # structural check only, no microphone/model
npm run voice:realtime:probe -- --allow-provider

# After qualification, launch the server:
npm start
```

No mode setting is required. Existing `DRAKEN_VOICE_MODE=native` is accepted, but `local` and unknown values are rejected rather than silently changing an old audio-privacy choice. `.env` is not loaded automatically. For an existing installation, stop active calls/model runs, back up its database and retain its existing authentication/TLS settings before restarting. Do not regenerate a sync to enable voice.

Node/npm must be on the operator’s PATH. A pi-managed runtime may already exist at `$HOME/.local/share/pi-node/current/bin`; no OS package installation is necessary if that runtime works.

The pinned helper and its separate credentials live under `~/.draken/realtime/`, outside the repository. Authentication/refresh belongs to the official helper. This implementation never reads or converts pi’s credential. The browser receives no provider token. No inherited API keys, proxy/provider overrides, pi ownership variables or Node preload settings reach the helper. Custom account `config.toml` files and unqualified non-default workspace regions fail closed. Trusted operators/tests may override `DRAKEN_CODEX_BIN` and `DRAKEN_CODEX_HOME`; the exact helper-version and native-auth checks still apply.

## Audio proof, not just a handshake

The opt-in probe requires two real spoken-input fixtures, both roles’ transcripts, and nonzero received audio on one connection. It reports setup separately from turn-to-first-audio timing and confirms browser cleanup and helper exit separately. It uses synthetic data, not the microphone or Draken database. Its temporary server is loopback-only, capability-header authenticated, same-origin/Host restricted, with a ten-second lease and ninety-second lifetime. Reports are private under `~/.draken/realtime/reports/`; no recordings, SDP or tokens are saved.

`nativeLoginPresent` and `readyForProbe` describe local prerequisites, not entitlement. The structural check always reports `audioVerified: false`; it does not reuse an earlier success. A successful current provider probe is the account-specific audio proof. Local-peer tests are not a substitute.

## Read-only architecture

- `rpc.mjs`: bounded private stdio RPC, correlation, deadlines/abort, sanitized errors, and unconditional denial of server-initiated tools/approvals. Unix shutdown targets the launcher/native-child process group, with escalation and exit confirmation.
- `native.mjs`: native-only account check, ephemeral thread, early-SDP-safe negotiation, text append and cleanup. Call creation uses the Codex backend; the sideband uses the official helper’s default route rather than a guessed override.
- `backend.mjs`: an authenticated, owned loopback Responses-compatible **text-only adapter**, not a proxy to a coding model. Without an explicit callback it denies inference. A callback may return only one assistant text message, never executable tool items. Incoming instructions, tool schemas and arbitrary options are not forwarded. Catalog probes are denied without being mistaken for work execution. Requests, body size, concurrency and callback duration are bounded.
- Sandbox/feature flags are additional precautions. The primary execution boundary is that there is **no backing coding-model inference or function-call output**, and every RPC execution/approval request is rejected. `clientManagedHandoffs` alone is not an execution-disable switch.
- `peer.mjs`: one audio track, persistent WebRTC/data channel, received-energy meter, explicit input replacement, immediate local mute/hang-up, late-SDP rejection and complete track/context cleanup. A muted decoder starts Chromium’s receiver; only the Web Audio graph is audible. No automatic capture or reconnection.

### Frozen evidence, not another model call

`src/voice/live-context.ts` supplies a bounded frozen briefing, saved notes, prior-sync decisions and source excerpts at call start. Historical discussion remains durable and is returned as up to eight dated, bounded quotes only when the current user explicitly asks to recall older discussion; keyword matching can select older relevant messages. A request for the last recorded question selects the last user message, not the assistant’s closing question. Old requests are never injected as an active conversation at startup. The persistent provider session retains this call’s own ongoing conversation. Initial packets are at most 24,000 UTF-8 bytes. Retained bracketed source markers always have supplied excerpts; unavailable markers are replaced explicitly. Excerpts preserve source roles and visibly omit their middles when needed, retaining closing qualifications rather than only a prefix.

Current questions proactively receive bounded context before typed input or when a spoken transcript completes, without depending on model delegation. Ordinary questions automatically use the hybrid historical index described in [MEMORY.md](../../MEMORY.md); explicit E/C requests retain the snapshot path. Spoken context delivery can race the beginning of a reply, so it is not a claim-validation gate. Requests about what was just said in this call do not automatically inject older snapshot discussion.

`src/voice/continuation.ts` tracks one pending answer per real user message. Ordinary developer context is background, not a reliable request to resume speech. After context delivery, a pending answer gets at most one official `thread/realtime/appendSpeech` completion cue. This is application control for the original question, not another user message, tool execution, or another speech/model provider. A response already in progress is allowed to finish; a normal completed reply is not repeated. Short English lookup promises (the default response language), including the reported “I’ll check what’s recorded”, keep the turn pending, as do brief acknowledgements and backchannels such as “Mm-hmm” on a real question. A final transcript part is not necessarily a completed answer. Simple social replies do not restart a lookup conversation. This conservative recognizer is not a semantic answer-quality validator or a guarantee for every language/phrasing. The prompt also requires actual follow-through and forbids speaking the control text.

Each turn has its own cancellation signal and identity, including repeated identical questions. Stop, first transcript of newer input, call end and helper failure cancel timers and old retrieval ownership. Results delivered after cancellation cannot send a completion cue; already-sent provider work cannot be recalled, so local Stop still mutes immediately. Acknowledgements (including delayed or duplicated events) never authorize another cue. A failed completion request or the fixed 45-second completion deadline produces a visible failure without further automatic attempts. Normal transcript/playback qualifications and explicit review boundaries remain unchanged.

If the voice model delegates a lookup, `src/voice/live.ts` runs deterministic retrieval over that same frozen snapshot. The delegation text is an untrusted query, not instructions. No shell, files, network searches or pi model calls are available. Handoff packets are at most 3,500 UTF-8 bytes, below the pinned helper’s approximately 1,000-token handoff limit. Explicit source requests take priority. This is bounded lexical retrieval, not a comprehensive search.

**Native speech may paraphrase.** It does not validate a complete JSON answer before speech is played. The UI says **Sources supplied**, not “verified citations.” An assistant’s claim is not independent test evidence, truncated output cannot establish a final suite pass, and an unverified deployment is not proof of a failed or absent deployment. These remain model instructions and human-review obligations, not a proof of semantic correctness.

### Main call UI, history and cleanup

`client/src/voice/live-session.ts` owns the native call, capture, polling and controls. The existing image-only dragon follows received audio energy through the read-only playback contract. Live motion is energy-driven, not phoneme-aligned. Speaker-safe input gating is the default; Headphone mode allows spoken interruption. Mute releases microphone tracks, typed questions work without microphone permission, and hang-up/page exit stops local media immediately.

**Stop reply cuts local playback and requests a remote stop.** It is not confirmation of immediate provider cancellation or accounting. A new typed question can continue within the same provider turn, so playback must not wait forever for another `turn.created`. A brief old tail or acknowledgment can precede the new reply. Physical echo, Bluetooth routing and device behavior still need hands-on qualification.

`live_calls` / `live_messages` are additive tables. Legacy history is retained. Live records are ordered by message initiation, not invented question–answer pairing; streams may overlap. They distinguish generated/interrupted text and observed audio energy from **exact playback**, which is not confirmed. Generated speech and proposals are not agreement. Transcript memory is explicitly marked as such. Calls cannot write decisions, finish syncs or advance coverage.

There is one call at a time, a 90-second disconnect lease, a 30-minute limit and at most 60 user messages. The main voice session allows at most 120 delegated lookup requests per call, independently of the user-message limit; these are local data lookups, not additional pi model calls. The text-only adapter defaults to eight requests when no limit is supplied and accepts only integer limits from 1 to 120. Rejected authentication and catalog probes do not consume that allowance; an admitted lookup still counts if its body or callback fails. A new call cannot start until helper cleanup is confirmed. Reload never resumes capture automatically; server recovery marks unfinished native history interrupted. LAN APIs retain the dashboard’s authentication and same-origin restrictions. Trusted HTTPS remains necessary for LAN microphones.

## Verification

```sh
npm test
npm run test:realtime:browser         # real LOCAL peer-to-peer audio, synthetic service
npm run test:live:browser             # main controller, local peers/API doubles
npm run test:realtime:native          # real pinned helper; unusable synthetic auth, loopback only

# Explicit account/provider use, synthetic data and injected audio, no real mic:
DRAKEN_TEST_STATIC_DIR=/path/to/staged/frontend \
  npm run test:live:real -- --allow-provider

# One spoken question → acknowledgement → delayed synthetic lookup → spoken answer:
DRAKEN_TEST_STATIC_DIR=/path/to/staged/frontend \
  node tests/voice-continuation-real.cjs --allow-provider
```

The main-controller tests cover permission denial, late microphone permission, speaker/headphone gating, mute/replacement, immediate stop, same-provider-turn resumption, late SDP, page exit and no capture after reload. The optional real-helper checks verify both denied inference and tool-looking text remaining plain text, with zero executed tools. Real-provider UI qualification exercises spoken input/interruption, typing, dragon motion, mute/unmute, stop/resume and cleanup on one connection. Use synthetic records for regression tests; any additional private-history qualification needs separate approval. Never use production history as a test scratchpad. Qualification must wait for a substantive answer, not mistake an acknowledgment plus an audio pause for completion. First audio may be an acknowledgment; it is not a measure of time to a fully grounded answer.

No unlimited usage, exact quota pool, idle accounting, impact on coding allowances, provider-retention policy, ChatGPT latency parity or future API stability is promised. Audio and bounded context go to OpenAI. No raw audio is persisted locally. Linux/Chromium is the tested combination; physical devices and other browsers are not claimed verified.
