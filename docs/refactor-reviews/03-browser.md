## Result

**No worthwhile findings remain in the reviewed browser scope.** The previous source-lifetime finding is closed, and the earlier extraction/controller fixes remain intact.

Reviewed current filesystem contents, including the source-lifetime fixture—not just HEAD. No files changed and no tests executed.

## Verification of the closing-race fix

### Dialog visibility now owns source lifetime

**`client/src/components/VoiceCall.tsx::close()` and source rendering**

- `close()` still calls `setSource('')` **before** awaiting `session.current.end()`. The source already open at hang-up therefore unmounts immediately; cancellation does not wait for `/end`.
- Historical-source rendering now requires `open` at line 229. The frozen-snapshot source panel is also gated by `open`.
- A source selected during asynchronous shutdown consequently unmounts when `setOpen(false)` executes—even if selection changed after the initial clear.
- The condition is dialog visibility, **not** `call.phase !== 'ended'`. Sources remain inspectable after audio ends naturally while the dialog remains open.

This is the appropriate minimal ownership boundary: `VoiceCall` owns dialog visibility; `HistorySource` owns reads while mounted. No additional controller or shared lifecycle abstraction is needed.

### The extended regression exercises the previously missing interval

**`tests/ui/voice.spec.ts`, “call sources reset pagination by identity and cancel reads on switching, source close and call close”**

The route order is correct:

1. `await nativePeer(page)` runs at line 110.
2. The test installs its overriding `/end` route afterward, at line 113.
3. That handler fetches the actual server response, disposes the synthetic remote peer, then awaits `ending` before fulfilling the browser response.

Thus nativePeer’s ordinary immediate fulfillment does not defeat the hold.

The test then establishes both cancellation boundaries:

- Starts a held paged read, clicks **End call**, observes the end request, and asserts `fixture.reads[5].aborted` while the dialog is still visible.
- Reselects source A during closure, loads its first page, and starts another held paged read.
- Releases `/end` through `finishEnd()`.
- Asserts the dialog closes, `fixture.reads[7].aborted` becomes true, the historical-source region is absent from the DOM, and microphone tracks are stopped.
- Releases the outstanding source responses only in `finally`, **after those assertions**.

**`tests/ui/history-fixture.ts::delayedSources()`** records cancellation through Playwright’s `requestfailed` event for the exact request object. It does not infer cancellation merely from the component disappearing.

These assertions establish browser-request cancellation. They do not themselves measure history-worker retirement; that boundary has separate implementation and test coverage.

## Earlier findings remain closed

### Shared source identity, extraction and cancellation

**`client/src/components/HistorySource.tsx::{HistorySource, SourcePage}`**

- The exported viewer internally keys `SourcePage` by reference, so callers need not remember a key to reset pagination.
- Each read owns an `AbortController`; offset changes and unmount abort it.
- Aborted requests cannot publish results or errors.
- `client/src/api/index.ts::readHistory()` forwards the signal to fetch.
- Both History and VoiceCall import the component directly; VoiceCall no longer depends on the History page.
- Client pagination and server slicing still use `HISTORY_PAGE_CHARACTERS`.

The voice regression asserts exactly A/0, A/4000, B/0, cancellation on switching and source close, and protection against late responses. `tests/ui/history.spec.ts` checks cancellation on navigation away.

The server connection remains intact: `src/routes/memory.ts` passes the response-lifetime signal into reads; `src/memory/service.ts` removes queued cancelled work or retires the active worker.

### Standalone controller bootstrap

**`tests/live-browser.cjs::{modules, fixture}`**

- Serves the actual transpiled `auth/session.ts` module at the imported path.
- Returns 404 for unknown non-voice-API resources.
- Bounds controller bootstrap to five seconds and checks page errors.
- Closes the context and server if bootstrap fails.
- Retains the synthetic bearer-header assertion.
- Describes the hidden-tab case as call reservation, not indexing.

The explicit small module map remains adequate; a general-purpose module loader is unwarranted. This suite is still a separate command, not part of `npm test`.

### Obsolete controller hooks

**`client/src/voice/api.ts::CallOptions`, `client/src/voice/live-session.ts::start()`**

- No `onLevel` option, emissions or caller no-ops remain.
- Controller `start()` accepts only `syncId`.
- Component-owned `beforeStart` still runs before controller construction, preserving note-save/readiness-at-click behavior.
- Input metering still detects speech after Stop.
- Received-energy observation through `PlaybackCue`, permission-dialog polling, cancellation identity and peer cleanup remain.

## Retained requirements—not cleanup targets

- **Authentication:** shared credential storage does not imply shared failure policy. Dashboard 401 clearing/reload and voice error propagation into cleanup remain intentionally different.
- **Navigation:** modified clicks preserve ordinary browser behavior; auto-call intent remains transient so reload/back navigation does not silently start capture.
- **Polling:** dashboard, settings, preparation and call polling have distinct owners. Permission-dialog polling keeps the reserved call alive.
- **Provider/browser behavior:** keyed server waiting state, unkeyed WebRTC events, same-turn typed continuation, stopped-answer epochs, silent input after microphone denial and Chromium’s muted decoder element remain justified.
- **Presentation:** sample-based preview animation and live received-energy animation have actual consumers. Reduced motion, software-renderer budgets, WebGL fallback and disposal remain meaningful.
- **Evidence compatibility:** legacy call records, generated-versus-heard qualifications, unavailable originals, frozen snapshots, neighboring records and explicit pagination remain supported behavior.
- **Tests/comments:** privacy assertions across different entry points are not redundant. No further comment or test cleanup rose to a worthwhile actionable finding.

No speculative redesign is promoted to a finding.

## Reviewed files and coverage

### Complete reads: all `client/src/`

- Root: `App.tsx`, `main.tsx`, `navigation.ts`, `request-id.ts`, `types.ts`, `vite-env.d.ts`.
- Infrastructure: `api/index.ts`, `audio/playback.ts`, `auth/session.ts`, `contexts/AuthContext.tsx`.
- Pages: `pages/Home.tsx`, `History.tsx`, `Login.tsx`, `Sync.tsx`.
- Components: `components/AgentSources.tsx`, `AutomaticPreparation.tsx`, `EvidenceList.tsx`, `HistoryProgress.tsx`, `HistorySource.tsx`, `IndexSettings.tsx`, `PreparationUsage.tsx`, `SetupPanel.tsx`, `SummaryTree.tsx`, `SyncCost.tsx`, `TextChat.tsx`, `VoiceCall.tsx`, `VoiceCaptions.tsx`.
- Voice: `voice/api.ts`, `voice/live-session.ts`.
- Persona: `persona/PersonaStage.tsx`, `background.ts`, `dragon.ts`, `geometry.ts`, `motion.ts`, `scene.ts`, `studio.ts`, `types.ts`, `preview.tsx`, `persona.css`, `preview.css`.
- Styles: `styles/index.css`.

### Complete reads: browser peer and tests

- `voice/realtime/peer.mjs`, `peer.d.mts`, `probe-browser.mjs`.
- All `tests/ui/`: `appearance.spec.ts`, `automatic.spec.ts`, `call-cancel.spec.ts`, `chat.spec.ts`, `history-fixture.ts`, `history.spec.ts`, `native-fixture.ts`, `persona.spec.ts`, `preparation-info.spec.ts`, `server.cjs`, `settings.spec.ts`, `setup.spec.ts`, `sync.spec.ts`, `usage.spec.ts`, `voice.spec.ts`.
- Additional tests: `tests/browser-foundations.test.cjs`, `persona.test.cjs`, `live-browser.cjs`, `realtime-browser.cjs`, `realtime.test.cjs`, `voice-boundary.test.cjs`, `live-voice-real.cjs`, `http.test.cjs`.

### Supporting context

Complete reads of:

- `docs/refactor-decisions.md`, `docs/refactor-reviews/01-browser.md`, `docs/refactor-reviews/02-browser.md`, `PERSONA.md`.
- Root/client `package.json`, `client/vite.config.ts`, `playwright.config.ts`.
- `src/routes/http.ts`, `src/routes/memory.ts`, `src/memory/types.ts`, `src/memory/service.ts`.

Targeted inspection only:

- Source pagination in `src/memory/index.ts`.
- Cancellation/retirement tests in `tests/memory.test.cjs`.
- Reservation identity and preparation-cancellation cases in `tests/live-voice.test.cjs`.

### Coverage gaps

No execution, build, Git-baseline comparison, dependency audit, real-provider qualification or physical-device/cross-browser qualification was performed. The reported passing focused tests were not independently rerun. Optional qualification scripts were inspected, not certified by execution.

No credential stores, private logs, `.env` files, installed dependencies, generated assets, test artifacts or source session stores were read.

**NO WORTHWHILE FINDINGS REMAIN IN REVIEWED SCOPE**
