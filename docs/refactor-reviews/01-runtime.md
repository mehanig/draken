## Confirmed worthwhile findings

### 1. The credential extraction broke the standalone live-browser qualification harness
**Refactor regression — `tests/live-browser.cjs:9–13`, module map and `fixture()`; `client/src/voice/api.ts:2`.**

`voice/api.ts` now imports `../auth/session`, but the harness serves only the controller, API module and peer implementation. The browser consequently requests `/client/src/auth/session`; this falls through to the fixture’s generic **204 response**, rather than receiving JavaScript. Module loading fails before `window.Controller` is assigned.

This is a hidden change-together dependency: production imports changed, but the hand-maintained browser module inventory did not. Neither `npm test` nor the 48-test Playwright suite exercises this harness. `.github/workflows/qualification.yml:31` runs it separately, so the documented verification does not establish that release qualification still works.

**Minimal change:** serve the transpiled real `client/src/auth/session.ts` at the requested URL. Do not duplicate authorization logic in the fixture. Return 404 for unknown module paths instead of treating them as API requests, so future omissions fail intelligibly.

**Preserve:** real local WebRTC, synthetic credentials, no provider access, and the distinct voice authentication-error policy.

**Tests:** run `node --test tests/live-browser.cjs tests/realtime-browser.cjs`. Assert module responses have a JavaScript content type and that bootstrap succeeds before testing call behavior. Keep the existing assertions that voice requests carry the synthetic bearer token. Update the verification log after this separate suite passes.

### 2. Server ownership is enforced by listening address, not by the data directory it mutates
**Ownership safety — `src/server.ts:58–102`, `startServer()` / `bound()`; related `src/tray/worker.ts:69–72` and `src/sync/activity.ts`.**

A second ordinary server using the **same `DRAKEN_DATA_DIR` but a different free port** reaches:

```ts
getDb(); recoverInterruptedRuns(); recoverLegacyCalls(); recoverLiveCalls();
```

It can mark the first server’s active work interrupted and overwrite its discovery record. Both servers then have independent `activity` registries, defeating per-sync mutation guards and single-call ownership for that database.

The tray already recognizes this hazard and consults the recorded target before launching. That is a workflow-specific approximation of an invariant belonging to the server. It neither protects ordinary CLI launches nor provides atomic exclusion between competing launchers.

**Minimal change:** acquire a server-owned, cross-process data-directory lifetime lock after successful socket binding but **before database initialization/recovery**. Hold it through shutdown; refuse another owner without recovering or rewriting state. Keep tray ownership of its child separate—neither a discovery record nor a PID should confer termination rights. An existing locking dependency is available; no general process framework is needed.

**Preserve:** occupied-port launches must not initialize a database; independent data directories remain usable; tray IPC remains the only tray shutdown authority; crash recovery runs only after ownership is established.

**Tests:** extend `tests/server-state.test.cjs` or `tests/tray.test.cjs` with two processes sharing a temporary data directory on different ports. Verify the second is rejected, active run/call rows and the first instance record remain unchanged, the first remains responsive, and a later launch succeeds after orderly shutdown. Retain same-port and foreign-server non-interference tests.

This is a verified current ownership gap, not a claim that the refactor originally introduced it.

### 3. Unix helper-exit confirmation can release call ownership while a descendant survives
**Ownership safety — `voice/realtime/rpc.mjs:25–29,92–114`, `NativeRpc`; downstream `NativeVoice.#closeResources()` and `src/voice/live.ts:endLiveCall()`.**

On Unix, the selected executable is the npm launcher, and termination deliberately targets its process group. However, the launcher’s Node `close` event unconditionally:

- clears group-kill escalation;
- resolves `waitForExit()` as successful.

A launcher can exit while a descendant that closed or redirected its inherited pipes remains alive. That produces `helperExited: true`, allowing `endLiveCall()` to release the activity lease and admit another call. It also contradicts the comment promising escalation when the launcher exits before its child.

The hidden contract is consequential: `NativeRpc` reports launcher/stdio completion, while the call owner interprets it as completion of the entire owned native resource.

**Minimal change:** make Unix confirmation cover the owned process group, not just the launcher. Retain escalation and bounded confirmation until the group is gone; return false when that cannot be established. Keep Windows’ direct-native-executable confirmation separate. Do not merge these protocols into a generic shutdown wrapper.

**Preserve:** sanitized diagnostics, bounded shutdown, fail-closed call admission, and termination restricted to the process/group actually created by this owner.

**Tests:** add a Unix synthetic launcher that starts a descendant with independent stdio, exits on SIGTERM, and leaves the descendant ignoring SIGTERM. Verify escalation removes it and confirmation does not succeed early. Also test an unconfirmed result leaves the call lease held. Existing `tests/realtime.test.cjs` mocks a single child; `tests/realtime-native.cjs` checks ordinary exit, not this ownership case.

This is likewise an ownership safety gap established from the current code, not a demonstrated refactor-origin regression.

### 4. The native implementation guide describes the obsolete retrieval boundary
**Documentation cleanup — `voice/realtime/README.md:51`, “Frozen evidence, not another model call.”**

The guide says delegated retrieval searches the same frozen snapshot, is lexical, and returns evidence packets capped at 3,500 bytes. Current `src/voice/live.ts:lookup()` ordinarily calls prepared historical retrieval with the 32,000-byte discussion budget, while `history-delivery.ts` sends acknowledged context parts and returns a small receipt. Explicit frozen-source requests are a separate path, sometimes combined with later archive reports.

This documentation should change with the retrieval/transport ownership refactor: it currently understates what historical material may be supplied to the provider and misidentifies the handoff payload.

**Minimal change:** replace the obsolete paragraph with the current prepared-cutoff/archive-versus-snapshot distinction and evidence-versus-receipt distinction. Link to the already-correct explanation in `VOICE.md` rather than maintaining another detailed limit inventory.

**Preserve:** untrusted-query treatment, no executable tool output, no alternate provider, bounded selection, and no claim of comprehensive search.

**Tests establishing the behavior:** existing `tests/live-voice.test.cjs` refinement, explicit frozen-status, prepared-cutoff and multipart-transfer cases; `tests/voice-history-delivery.test.cjs`. No prose snapshot test is necessary.

## Retained requirements—not cleanup targets

- **HTTP lifetime policy:** `route()` consistently forwards synchronous/asynchronous errors. `connected()` appropriately remains opt-in: search and call setup cancel on disconnect; durable preparation does not. `tests/http.test.cjs` covers cancellation and listener removal.
- **Compatibility:** legacy call history/recovery, legacy final-model fallback, explicit `DRAKEN_VOICE_MODE=native`, and rejection of retired local mode preserve real stored-data/configuration semantics. They are not unused execution variants.
- **Authentication and TLS:** loopback defaults, configured-credential precedence, Host/Origin protections, authenticated certificate download and certificate re-encoding remain distinct necessary boundaries.
- **Native voice:** reservation cancellation tombstones, per-turn identity, duplicate delivery reuse, multipart completion, stop-echo handling and bounded continuation address actual asynchronous protocol behavior.
- **Runtime selection:** managed versus external pi, immutable lock-qualified installs, isolated environments and no silent fallback are justified. The extracted data-directory/model-default owners remove the identified database dependencies.
- **Tray:** observed versus owned servers, saved versus configured addresses, private IPC, helper heartbeats and OS-specific launch/shutdown paths are genuine requirements.

No speculative redesign recommendations are included.

## Reviewed files and coverage

**Read completely, from the current working tree:**

- `src/{server,server-state,server-status,cli,npm-cli}.ts`
- `src/auth/middleware.ts`
- `src/routes/{auth,http,sync,memory,voice,live-voice}.ts`
- `src/pi/{runtime,setup}.ts`
- `src/tray/{controller,launcher,native,processes,worker}.ts`
- `src/voice/{continuation,history-delivery,legacy-history,live-context,live}.ts`
- `voice/tls.mjs`; `voice/realtime/{backend,native,rpc,setup,probe,probe-server,probe-browser}.mjs`, `probe.html`, `peer.d.mts`, `README.md`
- `tray/{macos.js,windows.ps1}`; both `scripts/{release-version,site-release}.cjs`
- `package.json`, `runtime/pi/package.json`, `client/package.json`; root/client TypeScript configurations, `client/vite.config.ts`, `playwright.config.ts`, `knip.jsonc`, `.npmignore`, `.gitignore`
- `.github/workflows/{qualification,release,tray-check,web-deploy}.yml`
- Context: `docs/refactor-decisions.md`, `SETUP.md`, `TRAY.md`, `VOICE.md`; `src/data-dir.ts`, `src/sync/{activity,models,preparation,background,automatic}.ts`, `src/memory/{context,packet}.ts`, `client/src/voice/api.ts`, `client/src/auth/session.ts`.

**Tests read completely:**

- `tests/{activity,http,native-launch,pi-setup,server-state,tray,tls,release,site-release,realtime,realtime-backend,live-voice,voice-boundary,voice-continuation,voice-history-delivery,sync,sync-home,chat,browser-foundations,automatic-index,automatic-briefing,automatic-defaults}.test.cjs`
- `tests/{package-smoke,runtime-smoke,tray-native,realtime-native,realtime-browser,live-browser,live-voice-real,voice-continuation-real}.cjs`
- `tests/fixtures/{fake-codex,fake-npm,fake-tray-worker}.cjs`
- `tests/ui/{server.cjs,native-fixture.ts}` and `{call-cancel,setup,voice,history,settings,sync,chat,automatic,preparation-info,usage}.spec.ts`.

**Coverage gaps / limits:**

- Lockfiles were inspected for root manifest agreement and selected runtime metadata, not exhaustively audited transitively.
- `tests/memory.test.cjs` was reviewed selectively for API validation, packet and worker-cancellation contracts. Store/manager/schema/process callers were inspected selectively.
- Tray image assets and the audio fixture were inventoried, not visually/acoustically qualified. `peer.mjs` was intentionally excluded.
- No commands or tests were executed. No credential stores, private logs, environment files, installed dependencies, generated assets or source-session stores were read.
- Files were reviewed directly as present, including newly present source/test files; without Git execution, tracked/untracked status and historical provenance were not independently classified.

**CONFIRMED FINDINGS REMAIN**
