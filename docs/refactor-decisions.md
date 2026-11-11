# Refactor decision log

## Final status

The independent review requirement is satisfied. All inventoried findings are fixed, and fresh reviewers report no worthwhile findings remaining across the completed core, browser, runtime and test scopes. [Review reports and the coverage map](refactor-reviews/README.md) preserve both earlier findings and final clearances; coding-worker sessions were not counted as reviewers.

Final verification: **354 unit tests, 51 UI tests and 23 standalone browser/site tests passed**; server/client TypeScript, Knip and diff checks passed. The static TS/TSX runtime-import graph has 115 files, 297 edges and no cycles. All temporary mutations were restored. Real-provider, real-model, installation-network and physical-device acceptance remain unrun; static review and passing suites do not prove every possible behavior.

## Baseline

- User selected structural refactoring, comment cleanup and test cleanup.
- Clean working tree; `npm test`: 306 passing, no skips; `npm run check`: passing.
- Initial passes had no dedicated subagent tool and used sequential self-review. The subsequent review pass below uses independent read-only Pi CLI sessions.
- The entries retain the chronological inventory and intermediate review limits. The final status and linked coverage map supersede those intermediate limits.

## Decisions (recorded before implementation)

### Put transport errors in a dependency-free module

- Needless link: `src/memory/service.ts`, `src/sync/pi.ts`, `src/sync/usage.ts` and route adapters import the entire sync store just for `HttpError`.
- Hidden link: error identity depends on the store even though errors have no persistence requirements.
- Move the class to `src/errors.ts` and update all consumers rather than retaining a forwarding export.

### Own Express async dispatch and disconnect lifetime in one HTTP module

- Hidden link: sync, voice and live-voice routes copy the same Promise/error forwarding implementation.
- Hidden link: memory and live voice separately implement response-close cancellation and listener cleanup.
- Special case: live voice checks an already-destroyed response but memory does not.
- Share async dispatch and a response-lifetime operation. Keep cancellation opt-in: ordinary preparation must survive a browser disconnect, whereas memory requests and call setup must not.
- Preserve validation, status codes, middleware ordering and error messages.

### Separate evidence selection and discussion scope from model/call orchestration

- Needless link: `src/voice/live-context.ts` imports the model job manager to perform pure lexical retrieval.
- Needless link: text discussion imports `src/voice/history-focus.ts`, although project scope belongs to both text and voice history.
- Move lexical snapshot retrieval to `src/sync/retrieval.ts` and shared discussion scope to `src/memory/focus.ts`; use channel-neutral names.
- Surplus: the manager re-exports process shutdown owned by `src/sync/pi.ts`; server should import its owner directly.

## Special cases retained deliberately

- Authentication failure in the browser ends a dashboard session, but live voice reports failure for call cleanup: do not merge these policies just because both use fetch.
- Explicit source labels outrank lexical matches; bounded retrieval and chronological tie-breaking are product behavior.
- Project-switch, conversation-recall and pronoun handling in history scope are distinct user intents, not removable exceptions.
- Certificate re-encoding protects the private-key boundary; retain it and its security explanation.
- Model retries, legacy readers, timeouts and background ownership require behavioral review, not blanket removal.

## Verification plan

- Preserve existing regression tests during structural changes; update imports to new owners.
- Add behavior tests for synchronous/asynchronous HTTP failures and response-close cancellation/cleanup.
- Review comments and tests last. Remove implementation narration, not external/security constraints. Do not remove useful tests merely to reduce their count.
- Run full server tests, type/unused checks, production build and browser suite where supported.

## Implemented and verified

- All three decisions above are implemented. Imports point directly to owners; no compatibility re-export wrappers were added.
- Removed redundant route/API comments. Kept explanations of privacy/security constraints and source-scope semantics.
- Existing tests remain: the reviewed tests assert meaningful behavior or architectural boundaries, and none failed at baseline. Updated four test files to import the new owners; added five HTTP behavior tests.
- `npm test`: **311 passed**, zero failures/skips.
- `npm run check`: **passed** (server/client TypeScript and Knip).
- Production server/client build: **passed**; Vite retains its existing large-chunk advisory.
- `npx playwright test`: **48 passed**. The first combined build/UI command hit the harness's 200-second timeout after 40 passes; its leftover fixture server was stopped and the entire suite rerun with sufficient time. No test or timeout policy was weakened.
- Follow-up dependency scan found no remaining runtime cycle in the scanned static imports; the adapters/JSONL cycle is type-only in one direction. Voice context now depends on pure retrieval, shared focus lives in memory, and error-only consumers no longer load storage.

## Second-pass inventory (before edits)

### Separate embedding assets, inference, and the fixed vector contract

- Needless link: `EmbeddingPool` constructs `LocalEmbedder` only to check/download files. This loads tokenizer/WASM modules into the history coordinator, although inference belongs exclusively to isolated lanes.
- Hidden link: `LocalEmbedder.ready()` and `storedHistoryReadiness()` separately implement the same pinned-file size check.
- Hidden link: vector dimension 384 and byte size 1536 are repeated in inference, lane IPC validation, index writes, and SQLite schema/migration validation.
- Hidden link: pool and lane separately encode the 16,000-character request bound.
- Surplus: the lane's `LocalEmbedder` implements download/setup/readiness methods it never uses; the pool owns those operations.
- Fix: give pinned model assets a dedicated owner without inference imports, share cheap presence and checksum verification there, keep inference in the lane-only model, and define the fixed embedding wire/storage contract in one dependency-free module. Do not generalize model selection or change the persisted model fingerprint.
- Retain: pinned HTTPS URLs/checksums, no-download prepared lookups, bounded threads/windows, finite-vector validation, migration rollback, download deadline, and process-level cancellation.

### Make active-work ownership explicit

- Hidden link: store exports mutable busy/background/voice sets that route handlers, model jobs, history preparation, and calls must balance manually.
- Special case: sync-start reserves fake sync ID `0` and a separate `starting` flag during asynchronous scan/setup.
- Hidden link: cancellation dispatch checks the preparation job map before the manager controller map; lifecycle ownership is split across modules.
- Fix: one process-local activity owner issues idempotent, identity-bound release leases for jobs, calls, automatic ownership and pre-snapshot starts. It owns cancellation dispatch; callers can observe activity but cannot mutate its collections. Preparation keeps only its completion promises and errors; model orchestration no longer has a second controller registry. Replace the sentinel and route-local flag with a start lease. Preserve foreground yielding, global call exclusivity, per-sync mutation guards, and durable job recovery.
- Retain: a voice lease is released only after confirmed helper exit; cancellation requests do not release a running job before its finally block. Automatic ownership spans both briefing and history preparation.

### Put browser navigation and credentials below page/transport policy

- Needless link: App, Sync and History import Home just for navigation types and ordinary-anchor click handling.
- Hidden link: dashboard requests, voice requests and AuthContext each know the local-storage credential keys and how to construct authorization.
- Surplus: AuthContext exposes a token and manual auth-check function that no consumer uses; it stores a second token copy even though requests read local storage.
- Fix: move anchor handling to a page-independent navigation module; give stored credentials a single owner, while preserving the intentionally different dashboard reload and voice-cleanup error policies. Remove the unused context surface and implementation-narrating comments.

### Remove source-file forwarding exports

- Surplus: `sync/source-files.ts` re-exports JSONL utilities, causing collector/migration consumers to depend on the live-entry projection module.
- Fix: import low-level JSONL reading directly; keep EntryReader responsible only for live projection. Preserve migration-only legacy readers and exact historical normalization recipes rather than merging them with current ingestion.

### Keep launch/runtime configuration independent of database initialization

- Needless link: pi runtime selection, tray launch and server-state discovery import database schema/migrations to resolve the data directory.
- Needless link: pi readiness checks import the full snapshot store to obtain default model settings.
- Fix: extract data-directory resolution and summary model defaults into their own policy modules, with direct imports. They read environment at call time as before; no database creation or frozen-sync setting changes.
- Retain: the Luna-specific batching selector is not the default-model setting. A future default change must not silently give an unsupported model Luna's context budget.

### Separate history selection semantics from packet size and transport

- Needless link: native voice delivery imports the worker-backed history service transitively just for a packet byte limit.
- Hidden link/special case: `historyContext` switches from explicit-reference reading to reconciled status search when `maxBytes > 7000`. Changing a transport budget silently changes what evidence gets retrieved.
- Fix: separate pure packet formatting/budget from history retrieval; use the existing history-query `reconcile` intent explicitly. Shared source-focused discussion queries request reconciliation; ordinary reference reads do not. Byte limits continue to govern formatting only. Keep reference offsets, cutoff/admission checks and linked-report packing intact.

### Remove the unreachable local-only scheduler variant and test the real pipeline

- Surplus: `AutoIndexer.Operations` makes baseline, waiting, unfinished, briefing, problem and completion optional, but the only production construction supplies all of them.
- Special case: an old-cache/no-briefing branch implements a local-only mode that the app no longer enables. The in-memory fallback checkpoint also exists only for simplified tests.
- Misleading test: `source-batch.test.cjs` claimed old caches require foreground work, while production combined preparation already establishes missing checkpoints (`MEMORY.md` explicitly documents this).
- Fix: require the real combined-pipeline dependencies, always read the durable checkpoint, and remove the unreachable local-only branch and fallback state. Keep injectable operations for deterministic tests; make fixtures model the production contract. Rewrite the old-cache test to verify combined preparation/reuse, not an unavailable mode. Keep the threshold, consent gate, failure pause, retry intervals and cancellation behavior unchanged.

### Give indexed passage identity one recipe

- Hidden link: `HistoryIndex.refresh`, embedding preparation and prepared-only validation independently assemble title/role/text bodies and hashes. Refresh and validation also independently implement overlapping 800-character windows at 700-character strides and covered-tail suppression.
- Needless link: index hashing imports the source-discovery module for a duplicate SHA-256 helper.
- Fix: share the persisted passage recipe between indexing, reconstruction and readiness validation; import the existing digest directly. Keep migration-era 700/800 rules frozen rather than making old-data conversion depend on future live format changes. Keep presentation excerpt limits separate from indexed window size.

### Colocate conversation preparation with sync orchestration

- Hidden link/layout: the automatic conversation pipeline is split between `memory/automatic.ts` and `sync/automatic.ts`, even though it prepares snapshots and paid briefings, not just a search index.
- Needless link: text generation imports `voice/preparation.ts` for shared conversation readiness/history preparation.
- Fix: place scheduling/settings in `sync/background.ts` and shared history preparation in `sync/preparation.ts`. Memory remains the search service; voice remains a consumer of prepared conversations. Keep existing HTTP endpoint names for compatibility, but remove old module forwarding paths.

### Put historical source rendering below its two consumers

- Needless link found in the follow-up dependency graph: `components/VoiceCall.tsx` imports the History page to render one source. Page search/navigation changes should not be dependencies of the call UI.
- Fix: move the source viewer and its shared attribution rendering into `components/HistorySource.tsx`; both the page and call import the component. Preserve pagination, errors and source qualification text.
- Hidden link exposed during extraction: viewer pagination hard-codes the server's 4,000-character read-page size. Put that size in the shared history wire contract, so advancing pages and server slicing cannot drift.

## Follow-up reviews and retained requirements

- Source collection and pointer migrations: reviewed file identity/hash checks, captured-EOF scanning, branch/edit projection, frozen reconstruction, and migration rollback. Keep pi/Codex/Claude format distinctions and immutable historical normalization recipes. Shared traversal/normalization across old migration and live ingestion would make historical conversion depend on future parser changes.
- Summary tree: reviewed cache identity, legacy leaf reuse, citation-only repair, invocation reservation, token batches and final compaction. Keep bounded same-model repair, conservative unknown-model limits and immutable legacy prompt text; these preserve paid cached work and explicit provider budgets, not speculative fallback engines.
- Process/media lifetimes: reviewed history worker retirement, embedding-lane cleanup, native RPC, tray ownership and browser peer cleanup. Keep their distinct shutdown protocols: Unix process-group termination, Windows private IPC, helper-exit confirmation, WebRTC track cleanup and stalled-worker deadlines solve different external constraints. Do not replace them with one generic process wrapper.
- Browser: reviewed navigation, auth, source viewing, sync progress/readiness, automatic settings and media/presentation ownership. Keep provider-event ordering guards, permission-dialog keepalive, reduced-motion/WebGL fallback and modified-anchor behavior. They are external browser/provider behavior, not disposable delays.
- Re-ran the dependency scan after the initial changes. It found the History-page dependency from VoiceCall, which was then removed. Static runtime-import scan now excludes type-only edges. This is not a claim about dynamically loaded process/browser entry points.
- Comment pass removed implementation narration in auth, API types, persona construction and summary orchestration. Kept external protocol, privacy, source-attribution and migration-compatibility explanations.
- Test review retained meaningful release, architecture/privacy, source integrity and lifecycle regressions. Replaced the obsolete local-only scheduler assertion rather than deleting the durable-checkpoint/vector-reuse coverage. No test was disabled and no timing policy was weakened.

## Continuation verification / completion status

All second-pass fixes listed above are implemented. Final verification after the last moves and shared-pagination change:

- `npm test`: **320 passed**, zero failures/skips (nine new tests beyond PR #31's 311).
- `npm run check`: **passed**, including server/client TypeScript and Knip.
- `npm run test:ui`: production build **passed**, all **48 browser tests passed**.
- `git diff --check`: **passed**.
- Follow-up static-import graph: **114 TS/TSX files, 296 runtime-import edges, zero cycles**; only App imports page modules. Dynamic process/browser entry points are also covered by their existing tests, not by this static graph.
- Tests added cover ownership/cancellation/stale release, asset isolation and failed-download cleanup, credential lifecycle, and modified navigation. Existing reconciliation coverage now also proves that transport byte budgets do not select retrieval behavior. The legacy-checkpoint test verifies actual combined preparation and vector reuse.

No inventoried second-pass fix remained open at this checkpoint. This checkpoint did not satisfy independent review; the subsequent pass below addresses that gap. Real-provider, network-install and physical-device acceptance checks were not run. Changes after PR #31's initial commit remain uncommitted/unpushed.

## Independent review pass

The installed Pi CLI can launch fresh agents even though the parent harness has no dedicated subagent tool. Three independent sessions are reviewing the current working tree, including new files, with only `read`, `grep`, `find`, and `ls`. They have no editing or shell tools, no parent conversation history, and no extensions/MCP. Each receives the same change-together criterion and an assigned source scope:

1. Core: sync, database, sources, memory, and their tests.
2. Browser: all client source, browser peer transport, and relevant UI tests.
3. Runtime: server, routes, auth, pi runtime, tray, native voice, release/package configuration, and relevant tests.

All three initial reviewers exited successfully and reported confirmed findings. Reports and process exit statuses are captured under `/tmp/draken-independent-review/`. The following inventory is recorded before implementation; the final test/comment review follows structural fixes.

### Migrate optional qualification consumers to the extracted owners

- Hidden link/regression: `tests/memory-real.cjs` and `tests/memory-performance.cjs` still use the old combined LocalEmbedder asset/inference API, omit its thread budget, and read removed properties.
- Hidden link/regression (independently reported twice): the standalone live-browser harness manually serves a module graph but omits the new credential owner. Unknown modules receive 204, masking bootstrap failure.
- Fix: use the asset module and explicit inference budget in qualification scripts; serve the actual credential module, reject unknown non-API resources, and fail/clean up promptly on browser bootstrap failure. Exercise these optional entry points explicitly rather than assuming `npm test` covers them.

### Let historical-source views own identity and cancellation

- Hidden caller convention: History keys its viewer by reference, VoiceCall does not; switching references after paging can issue a read at the previous reference's offset.
- Lifetime gap: the shared viewer ignores late results but does not abort reads, and closing the call leaves the source viewer mounted. Those reads occupy the single history worker.
- Fix: reset pagination with reference-keyed internal state, own an AbortController per read, and unmount selected sources when closing the call. Preserve source qualifications and explicit paging; test delayed reads, switching and close/navigation.

### Remove obsolete controller hooks

- Surplus: all `onLevel` consumers are no-ops after the presentation change; `LiveVoiceSession.start` retains an unused `beforeStart` hook even though VoiceCall owns preflight.
- Fix: remove these API variants/emissions, keeping microphone metering for interruption, playback energy, and the actual component-owned preflight.

### Bind server recovery and process-local activity to exclusive directory ownership

- Hidden lifecycle assumption: a second server on another port can mutate the same database, recover the first server's active work, and overwrite discovery. The new activity registry, like the old mutable sets, is process-local.
- Workflow-specific approximation: tray checks discovery before launching, but ordinary launches do not and the check is not atomic.
- Fix: acquire an exclusive server-lifetime data-directory lock after socket binding and before database initialization/recovery; hold through shutdown. Keep separate data directories and occupied-port noninitialization, crash recovery, and tray's private child-termination authority.

### Confirm the whole owned Unix helper group has exited

- Hidden contract mismatch: native RPC resolves helper exit when the launcher closes its stdio and exits, while live-call ownership interprets that as all owned native resources gone. A descendant with independent stdio can survive and escalation is cancelled too early.
- Fix: keep Unix process-group escalation and bounded confirmation until the group is gone; fail closed if unconfirmed. Keep direct-executable confirmation on Windows. Test an ignoring descendant, not only a mocked single process.

### Freeze historical compatibility data independently of today's key generator (test pass last)

- Misleading compatibility tests: v1/v2 cache fixtures derive historical keys from current private `SummaryTree` methods, so a changed recipe can change both fixture and lookup undetected.
- Fix: seed fixed synthetic historical keys/output independently, then exercise ordinary generation and assert provider reuse, accounting and current citations. Retain broader cache-island/planning behavior tests.

### Correct stale policy explanations

- `memory/stamps.ts` still says old caches require foreground preparation after the real combined pipeline removed that restriction. Describe an unknown checkpoint without prescribing scheduler policy.
- `voice/realtime/README.md` still describes lexical frozen-only 3,500-byte retrieval. Describe prepared archive cutoff versus explicit snapshot lookup and context transfer versus receipt; link to `VOICE.md` for detailed policy instead of duplicating limits.

### Implementation and regression checkpoint

All first independent-review findings above are implemented. Initial reports are preserved in `docs/refactor-reviews/01-{core,browser,runtime}.md` (separate read-only sessions using the configured model, not three personas in the parent conversation).

- Optional model scripts use asset ownership and explicit inference budgets; missing-weight subprocess tests pass without downloads. Real weights were not present, so full real-model qualification is not claimed.
- Standalone controller/peer qualification now passes **17 tests**. Unknown fixture resources return 404; bootstrap failure closes the browser context and server.
- Source readers now own cancellation and reference-keyed page state. The call clears its source on close. Tests cover identity changes, late responses, source close, call close and navigation.
- Server startup acquires a directory heartbeat lock after binding and before recovery; shutdown retains it until resource cleanup. A two-process/different-port test proves active run/call rows and discovery identity remain untouched by a rejected second owner, and orderly restart succeeds.
- Native RPC confirms the Unix process group, not just launcher stdio. A real synthetic ignoring descendant proves escalation survives launcher exit; a separate call test proves unconfirmed cleanup retains the lease. Windows still uses direct-helper exit. Container zombies conservatively leave group confirmation false.
- Frozen v1/v2 cache fixtures no longer import or call current key-generation internals. Both versions are exercised through ordinary generation, provider-call accounting and citation assertions. The dynamic cache-island test remains as packing coverage, no longer presented as historical compatibility proof.
- `npm test`: **325 passed**, zero failures/skips. `npm run check`: **passed**. Source-view focused browser tests are being completed, then the full UI suite rerun.
- Static graph: **114 source TS/TSX files, 297 runtime edges, zero cycles**.

The second independent pass includes a final test/comment reviewer and the remaining static-site files.

### Second-pass browser finding: bind source lifetime to dialog visibility

- The browser reviewer confirmed the original extraction/cancellation fixes but found one incomplete ownership transition: during awaited call shutdown, the still-visible dialog permits another source selection. That viewer can then remain mounted when `open` becomes false.
- Fix: render source views only while their owning dialog is open, in addition to immediately clearing the old source when shutdown starts. This preserves source inspection after natural audio completion while making dialog closure an unconditional resource boundary.
- Extend the lifecycle regression to hold the end response, select/page another source during shutdown, then verify closure unmounts and aborts it before releasing the source response.

### Second-pass core finding: confine copied-text compatibility to migration

- The core reviewer found live `EvidenceReader`/`EntryReader` fallback branches for inline/retained text even though initialization migrates those formats transactionally before exposing the database. Migration functions have their own historical readers; these branches are kept alive by invalid synthetic fixtures, not production migration callers.
- Fix: require verified pointers in live readers, use the existing tolerant unavailable marker when absent, and retain all migration-only readers. Convert synthetic snapshot fixtures to verified temporary originals; preserve encoded pointers when renumbering references. Test refusal of inline-only current-schema evidence.

### Second-pass runtime findings: exclusive lifetime, not heartbeat liveness or stop requests

- A heartbeat lock can be stolen from a suspended live server. Replace it with an OS-backed SQLite exclusive transaction on a separate private ownership file (the already-required SQLite dependency supplies cross-platform kernel locks). No timeout, PID-file authority, or non-atomic stale-directory deletion. A stopped process retains its lock; kernel process death releases it. Invalid/inaccessible lock storage fails closed.
- Server shutdown currently awaits some stop requests rather than resource completion; history retirement is not awaited, pi shutdown bypasses escalation, native failure is swallowed, and a deadline exits anyway. This can release directory ownership while children survive.
- Fix: expose confirmed retirement completion from each existing resource owner, cancel/block new activity before draining, await both listeners and all owners, retain native cleanup failures, and keep the process/lock in a visibly failed stopping state if bounded cleanup cannot be confirmed. Do not introduce a generic process framework. Add active-child shutdown, suspended-owner, genuine process-death and invalid-lock regressions.

### Final test/comment findings

- Independently freeze legacy search-cache offsets, hashes and vector bytes: current migration fixtures derive them from today's passage recipe. Keep existing dynamic migration mechanics tests and add a fixed multi-window/UTF-16 case that must retain vectors without re-embedding.
- Remove private-state access from reconciliation and failed-preparation tests: obtain canonical source records directly and retain fixture-owned fake embedders instead of reading `index.current`/`index.model`.
- Update architecture/tray ownership documentation to distinguish server exclusion from companion discovery/heartbeat. Do not document the rejected 30-second server takeover policy.
- Remove the unused public-site `.app-peek` disclosure styles; retain functioning FAQ, source-example and reduced-motion behavior and run site browser tests.

### Second-review fixes and verification

The second reports are preserved in `docs/refactor-reviews/02-{core,browser,runtime,tests}.md`. All confirmed findings in those reports are now implemented:

- `src/server-ownership.ts` uses an exclusive SQLite transaction held by its owning connection, not a stale heartbeat or PID. Different-port contention, suspended owner with an advanced contender clock, genuine owner death/restart, and malformed ownership storage are tested.
- `activity.shutdown()` closes admission and cancels jobs while waiting for release leases. History retirement and pi stop/escalation now return completion promises. Native shutdown preserves unconfirmed cleanup as failure. Server shutdown waits for both listeners and every resource owner; failures/deadlines retain the process and lock rather than permit replacement. Real synthetic history/model children ignoring SIGTERM, unconfirmed native shutdown/replacement refusal, and a held HTTPS request exercise these boundaries.
- Live evidence readers require pointers; historical copied-text compatibility remains only in migrations. Voice fixtures use verified temporary originals. Four new evidence regressions cover strict/tolerant handling, generation/call/review guards, original-before-edit verification and source loss.
- Source rendering is gated by dialog visibility. The browser regression now reselects/pages a source while the end response is held, then verifies it is aborted when the dialog closes.
- Search compatibility uses independently fixed legacy bodies, offsets, hashes and vector bytes, including split UTF-16 boundaries and covered tails. Reconciliation/preparation tests no longer reach into private index fields. Public-site dead styles and ownership documentation are corrected.
- Historical summary fixture mutation check: changing both v1/v2 lookup versions in compiled output made both frozen compatibility tests fail; restoring the build made both pass.
- Historical passage fixture mutation check: changing stride 700 to 701 in compiled output made the frozen search test fail on attempted passage re-embedding; restoring the build made it pass. No mutation remains in source or build output.
- `npm test`: **336 passed**, zero failures/skips. `npm run check`: **passed**.
- Source-lifetime focused UI checks: **2 passed**. Public-site browser qualification: **6 passed**. The prior full UI checkpoint passed **50**, and standalone controller/peer qualification passed **17**; these are being rerun after the latest fixes.
- Static import graph: **115 source TS/TSX files, 297 runtime edges, zero cycles**.

Third independent review cleared the core and browser scopes. Runtime and test reviewers identified the remaining items below before edits; completion is not yet claimed.

### Third-pass runtime finding: include native preflight subprocesses in ownership

- `nativeStatus()` launches unregistered `--version` children. A disconnected status request or closing call during preflight can leave that child outside server/call cleanup, despite registered RPC helpers being handled correctly.
- Fix: give native version checks explicit admission, cancellation/escalation and confirmed completion. Extract the existing native helper process-group lifetime into a native-specific owner shared by RPC and version inspection, not a cross-subsystem process framework. Closing a call awaits its preflight check; terminal voice shutdown stops both checks and calls. Preserve bounded metadata-only inspection, sanitized diagnostics, isolated environment and platform-specific group/direct-executable rules.
- Add a real ignoring version-child regression after browser disconnect, plus close-during-preflight coverage; gate termination explicitly to avoid timing races.

### Third-pass test and documentation findings

- The activity subprocess test can exit zero with an unresolved Promise and never reach its final assertion. Require a completion marker emitted only after successful drainage, cover all lease categories, and mutation-check the notification path.
- The active-child shutdown test assumes contender startup finishes before the 1.5-second escalation. Replace that timing assumption with a fixture-owned gate that holds kill delivery until exclusion is asserted; do not slow production shutdown.
- Correct the remaining frozen-only native lookup line in `ARCHITECTURE.md` and copied-evidence/single-server descriptions in `docs/architecture.html`. The visual guide should summarize and link the pointer-backed/ownership contract rather than maintain a contradictory storage specification. Parent inspection of the same guide also found old fixed-only voice limits, conservative-only batch diagrams and a false “no idle inference” claim despite enabled automatic briefing preparation; update those policy summaries and link their canonical detail rather than duplicating numerical specifications.

### Third-review fixes and final gate

All third-pass findings are implemented. Reports are preserved in `docs/refactor-reviews/03-{core,browser,runtime,tests}.md`; core and browser explicitly report no worthwhile findings remaining.

- Native RPC and metadata preflight share `NativeHelperProcess`, which owns only the native helper's platform-specific group/direct-executable lifetime. Version checks now register completion, cancel/escalate, preserve unconfirmed ownership, and close admission at terminal shutdown. `NativeVoice.close()` includes preflight completion; server shutdown calls the voice owner's combined checks-and-calls drain.
- A disconnected status-request regression starts an actual ignoring version child, holds terminal cleanup behind an explicit fixture gate, checks directory exclusion, then verifies child exit before replacement. Direct preflight close/abort tests also require confirmed exit; terminal admission is checked in an isolated subprocess.
- The activity test covers job/start/call/background leases and requires a final subprocess completion marker. Removing the compiled job-release notification made it fail on the absent marker; rebuilding restored a pass. No mutation remains.
- The history/model shutdown test explicitly gates final kill delivery, so contender startup speed cannot turn successful shutdown into a false failure.
- Architecture text/visual diagrams now summarize original-backed pointers, prepared-history retrieval, enabled automatic preparation and kernel-backed server ownership, linking to canonical detail rather than retaining obsolete copies.
- The focused native/process suite passed **21 tests**; the subsequent full checkpoint passed **338 unit tests**, **50 UI tests**, **23 standalone browser/site tests**, and type/Knip checks.

### Fourth-pass findings: terminal hosts and remaining test/documentation gaps

- Runtime review cleared server/library preflight ownership but found that standalone setup/probe hosts and the `draken voice` launcher could still exit ahead of detached version checks. Fix the whole native terminal workflow: its hosts own cancellation and wait for checks/commands, prevent startup after cancellation, and retain unconfirmed cleanup. Remove the pi command runner's voice forwarding layer by invoking the native terminal workflow directly, rather than racing nested 1.5-second kill timers. The probe server must propagate unconfirmed helper cleanup to its terminal owner.
- The unconfirmed-native subprocess test also needs a final success marker after assertions and awaited cleanup; mutation-check a pending terminal cleanup Promise.
- Correct residual canonical “copy/stored excerpt,” “no idle models” and blanket manual-retry summaries. Distinguish foreground/call interruption from enabled automatic preparation resuming owned unfinished batches; provider failures still require explicit retry. Keep the visual guide linked to that canonical policy.
- The test reviewer explicitly left part of the broad read scope incomplete. Final review partitions the remaining test files into smaller, named scopes and requires complete reads for each, rather than accepting an aggregate claim with truncated output.

### Fifth-pass test fixes

- Make optional real-provider qualification establish its actual prerequisites and use the current build. `tests/live-voice-real.cjs` creates a fresh briefing but omits prepared-history readiness, and defaults to an unrelated `/tmp/draken-live-preview` build. Use the existing synthetic history fixture (real embeddings have a separate qualification), assert readiness before provider work, and default to the repository build while retaining explicit overrides.
- Drive retry coverage from observable committed progress rather than embedding-call ordinal. `tests/memory.test.cjs` assumes a ninth-call failure leaves exactly 64 committed passages, coupling the test to batch size and a wall-clock commit threshold. Derive retry counts from the actual first committed progress report.
- Make agent API tests own local anonymous authentication. `tests/agents.test.cjs` otherwise inherits developer credentials/host configuration and can fail before testing agent settings.
- Apply terminal cancellation ownership to the remaining standalone native-check caller, `tests/realtime-native.cjs`, as well as production setup/probe. Its optional qualification now drains preflight/RPC/backend resources on cancellation rather than orphan its detached helper; executable regressions cover both signals without real-provider acceptance. The two UI/provider qualification scripts also await full native shutdown, including status checks, on completion.

Fifth-pass fixes are implemented. The provider fixture has a provider-free `--check` path and UI regression that requires completed cleanup, an enabled call button, no history/model directory, and an exact hash match with the current built client. Removing synthetic readiness and restoring an unrelated missing static directory each made that regression fail; both mutations were restored. Agent tests passed under explicitly hostile inherited auth/host configuration. The indexing retry test passed both normally and with an experimentally early commit threshold, then the production threshold was restored. The terminal suite passed all **16 tests**. The fresh final test review (`06-test-fixes.md`) clears all four findings and the new qualification/terminal tests. Complete final suites then passed: **354 unit tests**, **51 UI tests**, **23 standalone browser/site tests**, TypeScript and Knip. Final runtime clearance is in `05-terminal-runtime.md`; core/browser clearances remain valid. No inventoried finding or incomplete assigned review scope remains open.
