## Result

**The server/call preflight finding is resolved, but native-check ownership is still incomplete at the terminal entry points.** I found one actionable runtime issue and one remaining documentation inconsistency.

This was a read-only review of current files, including `voice/realtime/helper-process.mjs`. No commands or tests were executed.

## Confirmed worthwhile changes

### 1. Standalone voice commands can exit while their newly detached version helper survives

**Locations**
- `voice/realtime/helper-process.mjs`: `NativeHelperProcess.constructor()` (line 11)
- `voice/realtime/probe.mjs`: `onSignal()` (lines 8–12)
- `voice/realtime/setup.mjs`: version checks (lines 23, 30)
- `src/pi/setup.ts`: `run()` cancellation and `voiceSetup()` (lines 11–19, 91–95)

The extraction changes version inspection from an ordinary child into a **detached Unix process group**. Server shutdown now drains that group correctly, but the executable callers do not:

- During `probe.mjs`’s initial `nativeStatus()`, SIGINT/SIGTERM invokes a handler that closes only `browser` and `lab`, then calls `process.exit()`. Neither exists yet. The registered version check is abandoned before its timeout/escalation can run.
- `setup.mjs --check` has no signal cleanup for native checks. Normal terminal Ctrl+C no longer reaches the detached version group.
- `draken voice status` launches that script through `run()`, whose cancellation terminates only the script process. Its nested native check is not drained.

A slow version executable therefore can survive an ordinary cancellation. This is especially clear on Unix: detaching version checks removed the previous terminal-process-group relationship without updating all executable owners. It does **not** imply that version inspection performs inference or mutates application data.

**Change-together rationale:** Creating an independent helper group and exposing `stopNativeChecks()` imposes a shutdown obligation on every executable hosting those checks—not only the HTTP server. Registration in a module-local set cannot protect a child after its hosting process exits.

**Minimal redesign:** Have the standalone setup/probe entry points close check admission, cancel, and await `stopNativeChecks()` on SIGINT/SIGTERM before exiting. Pass cancellation into preflight and prevent subsequent startup after cancellation. For the `voiceSetup()` wrapper, relay cancellation and await the voice script’s cleanup rather than allowing generic `run()`’s 1.5-second launcher kill to preempt the native owner’s own 1.5-second escalation and exit confirmation. Keep pi’s unrelated command runner behavior unchanged; no general process framework is needed.

**Preserve:** Metadata-only inspection, exact version matching, sanitized errors, isolated environment, Unix group versus Windows direct-executable ownership, and cancellation without proceeding to login/provider setup.

**Tests:** Extend `tests/native-ownership.test.cjs` with executable-entry-point regressions:
1. Create a temporary HOME containing a synthetic default-path version helper that announces readiness and remains running.
2. Launch `probe.mjs --check`, `setup.mjs --check`, and `draken voice status`.
3. Cancel only after the readiness marker; assert helper termination before command completion.
4. Include an ignoring-SIGTERM helper to establish escalation and ensure the outer wrapper does not kill its cleanup owner early.

The current direct `NativeVoice.close()`/abort tests and disconnected HTTP test establish the server/library boundaries, not these terminal paths.

### 2. The canonical architecture guide retains the obsolete no-idle-model statement

**Location:** `ARCHITECTURE.md:202`, §6:

> “There is no timer that runs models just because the application is idle.”

The visual guide now correctly describes enabled automatic preparation, but this statement remains alongside the canonical guide’s own combined-scheduler explanation. `startBackgroundIndexing()` schedules checks, and `AutoIndexer.run()` invokes briefing preparation when the enabled pipeline has qualifying work.

**Change-together rationale:** The scheduler’s spending/consent policy and its documentation must agree. Correcting the visual copy while retaining a blanket contrary statement in its canonical reference leaves the cleanup incomplete.

**Minimal redesign:** Narrow this sentence to recap ownership: “Recaps have no independent idle-refresh timer. Enabled automatic conversation preparation can run model work under the policy described above.” Link rather than duplicate thresholds/defaults.

**Preserve:** Explicit recap refresh, frozen prior-memory preparation, automatic-preparation consent, no automatic capture, and no automatic review.

**Tests establishing behavior:** `tests/automatic-index.test.cjs`’s fresh-default timer test, `tests/automatic-defaults.test.cjs`, and `tests/automatic-briefing.test.cjs`. No prose snapshot test is necessary.

## Prior findings verified as resolved

- **Server directory exclusion:** `ownServerDirectory()` holds a separate SQLite exclusive transaction. Suspended owners retain exclusion; acquisition precedes application initialization/recovery. No heartbeat/PID takeover remains.
- **Registered server-resource drainage:** Shutdown closes admission, cancels activity, awaits both listeners and resource owners, and retains the process/lock when cleanup fails or remains pending. It no longer turns a deadline into unconditional release.
- **Unix helper-group confirmation:** `NativeHelperProcess` requires launcher closure plus group disappearance; launcher exit does not cancel necessary escalation. Unconfirmed call cleanup retains its lease.
- **Native preflight inside the server:** Checks are registered before asynchronous waiting. `stopNativeChecks()` closes admission, stops checks, confirms exit, and retains unconfirmed ownership. `NativeVoice.close()` includes preflight completion. `shutdownLiveVoice()` drains both checks and calls.
- **Regression tests:** The disconnected HTTP test uses an actual ignoring version child and an explicit shutdown gate. Direct close/abort tests wait for confirmed exit. Terminal admission is tested in an isolated subprocess. History/model escalation uses fixture-controlled kill delivery rather than assuming contender startup speed.
- **Activity test completion:** All four lease categories require a final subprocess marker; unresolved promises cannot silently pass through clean Node exit.
- **Browser harness extraction:** The actual credential module is served, unknown non-API resources receive 404, and bootstrap failure cleans up.
- **Retrieval documentation:** The native README, architecture voice diagram, and visual guide now distinguish prepared history from explicit frozen-source reads and context transfer from receipts. The visual guide’s pointer-backed storage and kernel-backed server ownership descriptions are corrected.

These are source/test-code conclusions, not independently executed test results.

## Retained requirements—not surplus

I found no justification for removing or merging:

- Opt-in HTTP disconnect cancellation versus durable preparation.
- Unix process-group confirmation versus Windows direct-native ownership.
- Managed/external pi selection, explicit setup/login, immutable qualified installations, and no silent fallback.
- Tray discovery/heartbeat versus server exclusion and private child-termination authority.
- Authenticated LAN access, loopback Host restrictions, Origin checks, and certificate re-encoding.
- Legacy call readers/recovery and rejection of retired local-audio configuration.
- Reservation cancellation markers, per-turn identities, serialized multipart completion, duplicate delivery reuse, stop-echo handling, and bounded continuation.

No speculative framework or additional surplus-removal proposal is warranted.

## Scope and coverage

**Read completely — runtime sources**
- `src/{server,server-ownership,server-state,server-status,cli,npm-cli,data-dir}.ts`
- `src/auth/middleware.ts`
- All six `src/routes/{auth,http,sync,memory,voice,live-voice}.ts`
- `src/pi/{runtime,setup}.ts`
- All five `src/tray/{controller,launcher,native,processes,worker}.ts`
- All five `src/voice/{continuation,history-delivery,legacy-history,live-context,live}.ts`
- All source modules under `voice/realtime/`, including `helper-process.mjs`, browser/probe modules, `peer.d.mts`, `probe.html`, and `README.md`; `voice/tls.mjs`
- `tray/{macos.js,windows.ps1}`
- `scripts/{release-version,site-release}.cjs`

**Supporting source read completely**
- `src/db/schema.ts`
- `src/sync/{activity,automatic,background,manager,models,pi,preparation}.ts`
- `src/memory/{service,worker,embedding-pool}.ts`
- `client/src/auth/session.ts`, `client/src/voice/{api,live-session}.ts`

**Configuration/documentation read completely**
- Root/client/private-runtime manifests; root/client TypeScript configurations; Vite, Playwright and Knip configurations; `.gitignore`, `.npmignore`
- All four `.github/workflows/{qualification,release,tray-check,web-deploy}.yml`
- `docs/refactor-decisions.md`, all three prior runtime reports
- `ARCHITECTURE.md`, `docs/architecture.html`, `SETUP.md`, `TRAY.md`, `VOICE.md`
- The truncated visual-guide read was continued through EOF.

**Tests read completely**
- `tests/{activity,http,native-launch,native-ownership,pi-setup,server-ownership,server-state,tray,tls,release,site-release,realtime,realtime-backend,live-voice,voice-boundary,voice-continuation,voice-history-delivery,sync,sync-home,chat,automatic-index,automatic-briefing,automatic-defaults,memory,embedding-pool}.test.cjs`
- `tests/{package-smoke,runtime-smoke,tray-native,realtime-native,realtime-browser,live-browser,live-voice-real,voice-continuation-real}.cjs`
- `tests/fixtures/{fake-codex,fake-pi,fake-npm,fake-tray-worker,fake-memory}.cjs`
- `tests/ui/server.cjs`, `{native-fixture,history-fixture}.ts`
- `tests/ui/{setup,call-cancel,voice,preparation-info,settings,sync,chat,automatic,usage,history}.spec.ts`

**Explicit gaps and execution limits**
- Lockfiles: root package metadata only; transitive contents were not fully reviewed or vulnerability-audited.
- Other core internals/tests and browser presentation files were not exhaustively re-reviewed.
- Tray images and the audio fixture were inventoried, not visually/acoustically qualified.
- No build, test, native-desktop, physical-device, provider, or installation-network execution is claimed. These execution limits are **not unresolved code-review defects**.
- No credential stores, private logs, environment files, installed dependencies, generated assets, test artifacts, or source-session stores were read.
- Current files were reviewed directly; Git tracked/untracked classification and historical provenance were not independently established.

**CONFIRMED FINDINGS REMAIN**
