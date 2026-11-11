## Result

**The four original findings are not all fully resolved.** The browser harness, Unix native-group confirmation, and retrieval documentation fixes are present and supported by relevant test code. Directory ownership now protects ordinary competing launches, but its **recovery and shutdown boundaries still permit replacement before exclusive ownership is safe**.

This is a read-only review of current files, including newly present files—not a HEAD-only review. No tests or commands were executed.

## Original findings: verification

| Original finding | Current assessment |
|---|---|
| **1. Standalone browser harness omitted extracted credentials** | **Resolved in source.** `tests/live-browser.cjs` serves the actual transpiled `client/src/auth/session.ts`, returns 404 for unknown non-API resources, checks controller bootstrap before lifecycle tests, and cleans up failed bootstrap. Synthetic bearer-header assertions remain. The qualification workflow explicitly runs this suite. |
| **2. Server ownership followed ports rather than the data directory** | **Partially resolved.** `startServer().bound()` acquires the directory lock after all configured listeners bind and before DB initialization, recovery, or discovery writes. The new different-port test verifies rejection without changing active rows or discovery, continued first-server responsiveness, and orderly restart. **Time-only takeover and incomplete shutdown remain unsafe**, detailed below. |
| **3. Launcher exit incorrectly confirmed whole native-helper exit** | **Resolved at the RPC boundary.** On Unix, `NativeRpc.#confirmExit()` requires launcher closure **and** `kill(-pid, 0)` reporting `ESRCH`. Other errors remain unconfirmed. Launcher closure no longer cancels escalation while the group survives; `waitForExit()` polls within its deadline. Windows retains direct-executable confirmation. `tests/native-ownership.test.cjs` exercises a real independent-stdio descendant ignoring SIGTERM, verifies no early confirmation and SIGKILL escalation, and conservatively handles container zombies. Its second test verifies an unconfirmed native close retains the call lease. **Server shutdown subsequently discards that protection**, as finding 1 explains. |
| **4. Native guide described obsolete frozen-only retrieval** | **Resolved.** `voice/realtime/README.md` now distinguishes prepared historical retrieval/cutoff, explicit frozen sources and later-report checking, acknowledged evidence transfer, and the small handoff receipt. This agrees with `lookup()`, `deliverContext()`, and the refinement, cutoff, explicit-status, and multipart tests. |

## Confirmed worthwhile changes

### 1. Server shutdown treats stop requests and unconfirmed cleanup as completed resource ownership

**Location:** `src/server.ts:109–120`, `startServer().shutdown()`; `src/memory/service.ts:29–35,111–116`, `retire()` / `stopHistory()`; `src/sync/pi.ts:23–25`, `stopManagerProcesses()`; `src/voice/live.ts:341`, `stopLiveCalls()`.

The directory lock is released after this promise set:

```ts
Promise.all([closed, stopLiveCalls(), backgroundStopped, stopPiChecks()])
```

But it does **not** establish that all owned resources have stopped:

- `stopHistory()` merely starts retirement. Its worker can still own/write `memory/index.sqlite` and model assets. The server neither awaits its exit nor keeps the process alive for its 1.5-second escalation timer.
- `stopManagerProcesses()` sends SIGTERM without awaiting exit or entering `invokePi()`’s cancellation/escalation path. An ignoring child can survive the server’s immediate exit.
- `stopLiveCalls()` uses `allSettled()` and clears the call map even when `endLiveCall()` rejected because helper-group exit was unconfirmed. The new fail-closed call test establishes protection only **while that server remains alive**.
- The outer `.finally()` releases ownership even if a shutdown dependency rejects; `Promise.all()` rejection also need not wait for the remaining dependencies.
- The unconditional 6.5-second `process.exit()` bypasses any remaining confirmation. HTTPS listener closure is requested but not included in the drain promise.

Consequently, an ordinary Stop followed by Start can admit a replacement while an old index worker, model process, or unconfirmed native resource survives. The new idle-server restart test does not exercise this case.

**Change-together rationale:** Directory ownership must cover the lifetime of resources created under it—not merely the HTTP listener. Each resource owner must supply the completion information that the server’s release decision requires. Moving lock release later syntactically does not create that contract.

**Minimal redesign:**

- Have the history owner expose retirement completion; have the model owner cancel active work, escalate where necessary, and report confirmed child exit.
- Preserve unsuccessful native cleanup in `stopLiveCalls()`’s result instead of swallowing it and clearing ownership.
- Drain both listeners and prevent pending orchestration from starting replacement work during shutdown.
- Release the directory only after successful cleanup confirmation. At the shutdown deadline, report/retain an unsuccessful stopping state rather than converting it into successful replacement permission through unconditional exit. Existing tray behavior already supports refusing replacement after an unconfirmed stop.

Keep these resource-specific protocols; no generic process framework is needed.

**Preserve:** Private tray IPC authority, bounded stop attempts, no PID-file kills, retained committed work, conservative call admission, and occupied-port launches that never initialize the DB.

**Tests:** Extend `tests/server-state.test.cjs` with an actual active synthetic history/model child whose exit is delayed or ignores SIGTERM; assert another-port startup remains excluded until confirmed termination. Extend `tests/native-ownership.test.cjs` through **server shutdown/relaunch**, not just `endLiveCall()`, with unconfirmed native cleanup. Include shutdown rejection/deadline and HTTPS-drain cases. Retain the existing group-escalation and ordinary restart assertions.

### 2. A stale heartbeat is being used as proof that a server owner is dead

**Location:** `src/server.ts:88–89`, `startServer().bound()` directory-lock options and `onCompromised`.

The new server lock automatically becomes recoverable after **30 seconds without a heartbeat**. That is not exclusive server-lifetime ownership.

For a concrete Unix case:

1. Start a server with an active owned helper or history worker.
2. Suspend **only the server process** with SIGSTOP.
3. Its heartbeat stops, while its children can continue running.
4. After the stale interval, another-port startup can acquire the directory and execute recovery and discovery writes.

The first server has not exited. Its compromise callback cannot run while suspended, and calling graceful shutdown after it resumes cannot retroactively protect the second server’s recovery. Long synchronous work or severe scheduling stalls create the same underlying ownership problem.

This is a defect in the newly introduced ownership mechanism, not a recommendation to remove heartbeat-based UI liveness generally.

**Change-together rationale:** Permission to recover durable runs and create a new process-local activity registry must be tied to exclusive ownership. Tray heartbeat conventions cannot simply become the authoritative server/DB recovery rule: missed updates prove loss of responsiveness, not loss of ownership.

**Minimal redesign:** Use an atomic, non-expiring server ownership lock with private owner identity. Automatically recover it only after the recorded local owner is positively known to be dead; treat live, inaccessible, incomplete, or otherwise ambiguous ownership as locked and require explicit operator recovery where necessary. Release must remain identity-bound. The tray’s presentation/liveness heartbeat can remain separate. Increasing the stale interval alone does not fix this.

**Preserve:** Crash recovery after genuine owner death, independent data directories, refusal before DB initialization, and no authority to terminate a process merely because its PID appears in a record.

**Tests:** Add a Unix suspended-owner test with a surviving synthetic child and a different-port contender. Assert rejection, unchanged active rows/discovery, and no second active owner. Separately test genuine crash recovery and ambiguous owner records. The current `tests/server-state.test.cjs` tests neither stale-lock recovery nor compromise handling.

## Retained requirements—not surplus

The following distinctions remain justified by actual callers, external protocols, or stored compatibility:

- **HTTP lifetime:** `route()` handles synchronous/asynchronous errors; `connected()` remains opt-in. Search/call setup may cancel on disconnect; durable preparation must survive it.
- **Authentication/TLS:** Configured credentials override anonymous defaults; no-auth loopback Host protection, Origin checks, authenticated certificate download, and certificate re-encoding protect different boundaries.
- **Compatibility:** Legacy call readers/recovery, legacy final-model fallback, explicit native mode, and rejection of retired local mode preserve stored-data and privacy semantics.
- **Native voice:** Unix group confirmation versus Windows direct-executable confirmation; reservation cancellation tombstones; per-turn identity; serialized multipart completion; duplicate delivery reuse; stop-echo handling; and bounded continuation are necessary asynchronous protocols.
- **Runtime setup:** Managed/external selection, immutable lock-qualified pi installations, isolated environments, explicit installation/login, and no silent fallback remain necessary.
- **Tray:** Observed versus owned servers, saved versus configured addresses, private IPC shutdown, native helper heartbeats, and OS-specific launch behavior remain necessary. The saved-target check is still useful discovery/UI policy even after server exclusion exists.

No additional speculative redesign or surplus-removal recommendation is warranted from this pass.

## Reviewed files and coverage

**Read completely:**

- `src/{server,server-state,server-status,cli,npm-cli,data-dir}.ts`
- `src/auth/middleware.ts`
- `src/routes/{auth,http,sync,memory,voice,live-voice}.ts`
- `src/pi/{runtime,setup}.ts`
- `src/tray/{controller,launcher,native,processes,worker}.ts`
- `src/voice/{continuation,history-delivery,legacy-history,live-context,live}.ts`
- `voice/tls.mjs`
- `voice/realtime/{backend,native,rpc,setup,probe,probe-server,probe-browser}.mjs`, `probe.html`, `peer.d.mts`, `README.md`
- `tray/{macos.js,windows.ps1}`
- `scripts/{release-version,site-release}.cjs`
- Root, client, and private-runtime `package.json`; root/client TypeScript configurations; `client/vite.config.ts`; `playwright.config.ts`; `knip.jsonc`; `.npmignore`; `.gitignore`
- `.github/workflows/{qualification,release,tray-check,web-deploy}.yml`
- `docs/refactor-reviews/01-runtime.md`, `docs/refactor-decisions.md`, `SETUP.md`, `TRAY.md`, `VOICE.md`
- Supporting owners: `src/sync/{activity,background,pi,preparation}.ts`, `src/memory/{service,worker}.ts`, `client/src/auth/session.ts`, `client/src/voice/api.ts`

**Tests read completely:**

- `tests/{activity,http,native-launch,native-ownership,pi-setup,server-state,tray,tls,release,site-release,realtime,realtime-backend,live-voice,voice-boundary,voice-continuation,voice-history-delivery,sync,sync-home,automatic-index}.test.cjs`
- `tests/{package-smoke,runtime-smoke,tray-native,realtime-native,realtime-browser,live-browser,live-voice-real,voice-continuation-real}.cjs`
- `tests/fixtures/{fake-codex,fake-npm,fake-tray-worker}.cjs`
- `tests/ui/{server.cjs,native-fixture.ts,history-fixture.ts}`
- `tests/ui/{setup,call-cancel,voice,settings,sync,preparation-info,history,chat,automatic,usage}.spec.ts`

**Explicit coverage limits:**

- Root/client/runtime lockfiles: manifest agreement and selected dependency metadata only, not exhaustive transitive inspection.
- `src/db/schema.ts`, `src/sync/manager.ts`, and `tests/memory.test.cjs`: targeted initialization, cancellation, finalization, and worker-retirement sections only.
- Other core/browser tests were not exhaustively re-reviewed; physical-device, real-provider, installation-network, and native-desktop behavior were not executed.
- Tray image assets and the audio fixture were inventoried, not visually/acoustically qualified. `voice/realtime/peer.mjs` was intentionally excluded.
- No credential stores, private logs, `.env` files, installed dependencies, generated assets, test artifacts, or source-session stores were read.
- Files were examined directly as present; tracked/untracked classification and historical provenance were not independently established through Git.

**CONFIRMED FINDINGS REMAIN**
