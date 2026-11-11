## Result

The replacement SQLite lock and the revised shutdown contracts resolve the two findings in `02-runtime.md` **for the resources now registered with shutdown**. One native subprocess path remains outside that ownership boundary. There is also one remaining documentation inconsistency.

This was a read-only review of files currently present, including the new ownership source and tests. No commands or tests were executed.

## Confirmed worthwhile changes

### 1. Native status subprocesses are not covered by server shutdown

**Locations:** `voice/realtime/native.mjs:nativeStatus()` (lines 39–46), `NativeVoice.open()` / `#closeResources()`; `src/voice/live.ts:liveStatus()`, `createLiveCall()`, `stopLiveCalls()`; `src/server.ts:startServer().shutdown()` (lines 101–120).

`nativeStatus()` runs `execFile(binary, ['--version'], …)` without registering the child with any shutdown owner. It is called by ordinary voice-status requests and during reservation/connection setup.

A concrete sequence permitted by the current code:

1. `/api/voice/status` starts a slow or stuck native `--version` subprocess.
2. The requesting browser disconnects.
3. The operator stops Draken normally.
4. Listener closure can complete despite the disconnected handler’s unresolved Promise. There is no call lease, and `stopLiveCalls()` knows only about entries in `calls`.
5. All registered shutdown promises resolve, so the server releases directory ownership and calls `process.exit()`, leaving the status child unconfirmed and potentially alive.

The five-second `execFile` timeout does not close this gap: shutdown can exit before it fires, and its default SIGTERM has no escalation. During `NativeVoice.open()`, the same subprocess also precedes creation of `#rpc`; `#closeResources()` can consequently report `helperExited: true` while that preliminary check remains running.

This does **not** establish that `--version` performs inference or writes the application database. It establishes a remaining ordinary-shutdown orphan path, contradicting the new owned-resource completion contract.

**Change-together rationale:** Native readiness probing and native call execution both create owned helper processes. Server exclusion cannot depend on whether a browser connection happens to remain open until a readiness check finishes. Pi checks already have explicit ownership through `stopPiChecks()`; native checks need the corresponding native-owned boundary.

**Minimal redesign:**

- Track status-check children and their actual completion in `native.mjs`.
- Provide a terminal shutdown operation that closes check admission, cancels/escalates existing checks, and awaits confirmed cleanup.
- Include that operation in server shutdown. Keep reusable `stopLiveCalls()` behavior distinct from terminal process shutdown.
- Ensure closing during native preflight does not falsely represent its still-running subprocess as confirmed cleanup. Retain Unix launcher/group versus Windows direct-executable distinctions where applicable.

No generic process framework or new recovery protocol is needed.

**Preserve:** Metadata-only status checks, exact pinned-version checking, sanitized diagnostics, isolated helper environment, no provider fallback, and explicit operator overrides.

**Tests:** Extend `tests/server-ownership.test.cjs` with a real synthetic `--version` child that signals readiness and ignores SIGTERM. Start it through `/api/voice/status`, disconnect the HTTP client, then request normal shutdown. Assert exclusion until actual termination, escalation, and no surviving child before replacement succeeds. Also cover cancellation while `NativeVoice.open()` is awaiting version inspection. Existing `realtime.test.cjs` fixtures return `--version` immediately; the new ownership tests exercise history/model children and rejected call cleanup, not this path.

### 2. The architecture diagram still understates native historical retrieval

**Location:** `ARCHITECTURE.md`, §7 “One voice path: ChatGPT,” line 224:

> `+-- text-only lookup in that same snapshot`

The guide’s prose and the corrected `voice/realtime/README.md` describe broader prepared-history retrieval, but this diagram still presents the obsolete frozen-snapshot-only boundary.

**Change-together rationale:** The diagram describes what private material voice can retrieve and supply to the provider. It must change with retrieval ownership rather than retain the earlier implementation’s narrower privacy description.

**Minimal redesign:** Replace that line with a distinction such as “prepared historical lookup; explicit frozen-source reads,” linking to the existing retrieval explanation rather than duplicating limits.

**Preserve:** Prepared cutoff, bounded selection, explicit E/C handling, and the distinction between supplied evidence and verified claims.

**Tests establishing behavior:** The prepared-cutoff, native-refinement, explicit frozen-status, and multipart-transfer cases in `tests/live-voice.test.cjs`, plus `tests/voice-history-delivery.test.cjs`. No prose snapshot test is necessary.

## Original findings and recent fixes

- **Standalone browser harness:** Resolved in source. `tests/live-browser.cjs` serves the real credential module, rejects unknown non-API resources, checks bootstrap, and cleans up bootstrap failure.
- **Directory exclusion:** The heartbeat takeover defect is resolved. `ownServerDirectory()` holds a separate SQLite `BEGIN EXCLUSIVE` connection, has no timestamp/PID takeover mechanism, validates storage, and closes the owning connection on release. Acquisition remains after listener binding and before application DB initialization/recovery.
- **Registered shutdown owners:** The previous stop-request/completion mismatch is substantially resolved:
  - `activity.shutdown()` closes admission, aborts jobs, and waits for identity-bound leases.
  - Model shutdown uses cancellation/escalation and awaits child closure.
  - History shutdown closes request admission and awaits retirement; embedding lanes are worker threads inside that history process.
  - Native call shutdown retains rejected cleanup rather than clearing ownership.
  - Server shutdown awaits both listeners and uses `allSettled()`. Failure or pending cleanup does not unconditionally release the lock at the deadline; a referenced interval keeps the process alive.
- **Unix native group confirmation:** Resolved at the RPC boundary. Launcher closure alone does not confirm group exit or cancel necessary escalation. Windows retains direct-executable confirmation.
- **Native retrieval guide:** The original README paragraph is corrected. The architecture diagram above is the remaining inconsistent explanation.

The new tests support different-port exclusion, suspended-owner/advanced-clock contention, genuine process death, malformed storage, ignoring history/model children, rejected native cleanup, and held HTTPS draining. These are assertions inspected in test code, not independently executed results.

Forced external termination remains outside graceful cleanup guarantees, as documented. I found no reason to replace the SQLite approach with PID claims, heartbeat expiry, stale-file deletion, or an orphan-recovery protocol.

## Retained requirements—not surplus

- Opt-in disconnect cancellation remains appropriate: history reads and call setup differ from durable preparation.
- Authenticated LAN access, loopback Host restrictions, Origin checks, credential precedence, and public-certificate re-encoding protect distinct boundaries.
- Managed/external pi selection, immutable lock-qualified installation, isolated environments, explicit setup/login, and failure without substitution remain justified.
- Tray discovery/heartbeat remains separate from server exclusion and private child-termination authority.
- Legacy call readers/recovery, retired-local-mode rejection, and existing model-setting compatibility are real compatibility requirements.
- Reservation tombstones, per-turn identities, serialized multipart delivery, duplicate reuse, stop-echo handling, and bounded continuation address actual asynchronous protocols.

No speculative redesign or additional surplus-removal recommendation is warranted.

## Reviewed files and coverage

**Read completely:**

- `src/{server,server-ownership,server-state,server-status,cli,npm-cli,data-dir}.ts`
- `src/auth/middleware.ts`
- `src/routes/{auth,http,sync,memory,voice,live-voice}.ts`
- `src/pi/{runtime,setup}.ts`
- `src/tray/{controller,launcher,native,processes,worker}.ts`
- `src/voice/{continuation,history-delivery,legacy-history,live-context,live}.ts`
- Supporting owners: `src/sync/{activity,automatic,background,manager,models,pi,preparation}.ts`; `src/memory/{service,worker,embedding-pool}.ts`
- `voice/tls.mjs`; all `voice/realtime/{backend,native,rpc,setup,probe,probe-server,probe-browser,peer}.mjs`, `peer.d.mts`, `probe.html`, `README.md`
- `tray/{macos.js,windows.ps1}`; `scripts/{release-version,site-release}.cjs`
- Root/client/private-runtime manifests; root/client TypeScript configurations; `client/vite.config.ts`; `playwright.config.ts`; `knip.jsonc`; `.gitignore`; `.npmignore`
- All four `.github/workflows/{qualification,release,tray-check,web-deploy}.yml`
- Supplemental browser boundaries: `client/src/auth/session.ts`, `client/src/voice/{api,live-session}.ts`
- `docs/refactor-decisions.md`, `docs/refactor-reviews/{01-runtime,02-runtime}.md`, `ARCHITECTURE.md`, `SETUP.md`, `TRAY.md`, `VOICE.md`

**Tests read completely:**

- `tests/{activity,http,native-launch,native-ownership,pi-setup,server-ownership,server-state,tray,tls,release,site-release,realtime,realtime-backend,live-voice,voice-boundary,voice-continuation,voice-history-delivery,sync,sync-home,chat,automatic-index,automatic-briefing,automatic-defaults,embedding-pool}.test.cjs`
- `tests/{package-smoke,runtime-smoke,tray-native,realtime-native,realtime-browser,live-browser,live-voice-real,voice-continuation-real}.cjs`
- `tests/fixtures/{fake-codex,fake-pi,fake-npm,fake-tray-worker,fake-memory}.cjs`
- `tests/ui/{server.cjs,native-fixture.ts,history-fixture.ts}`
- `tests/ui/{setup,call-cancel,voice,settings,preparation-info,sync,history,chat,automatic,usage}.spec.ts`

**Explicit coverage gaps and limits:**

- Root/client/private-runtime lockfiles: root manifest/version agreement only, not exhaustive transitive inspection or vulnerability auditing.
- `src/db/schema.ts`: initialization and closure sections. `tests/memory.test.cjs`: HTTP contracts, real-worker cancellation/restart, deadlines, and retirement/preemption sections.
- Other core internals/tests and browser presentation files were not exhaustively reviewed.
- The held HTTPS test releases before the shutdown deadline; it does not itself establish behavior after a prolonged pending drain.
- Tray images/audio assets were inventoried, not visually/acoustically qualified.
- No device, provider, network installation, desktop, build, or test execution is claimed.
- No credential stores, private logs, environment files, installed dependencies, generated assets, test artifacts, or source-session stores were read. Git provenance/tracked status was not independently classified.

**CONFIRMED FINDINGS REMAIN**
