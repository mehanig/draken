## Result

**One worthwhile source-lifetime issue remains.** Original findings 1 and 3 are resolved. Finding 2’s shared-viewer identity and cancellation changes are sound, but asynchronous call closing still permits a source viewer to survive the closed dialog.

Reviewed current filesystem contents, including `tests/ui/history-fixture.ts`; no files changed and no tests executed.

## Confirmed finding

### Historical-source visibility can escape asynchronous call closing

**Location:** `client/src/components/VoiceCall.tsx`, `close()` (lines 111–118), source-selection buttons and historical-source rendering (lines 228–230).

`close()` clears `source` **before** awaiting `session.current.end()`. That await can take up to four seconds while the end request completes. During this interval:

1. The dialog remains open.
2. Its source-selection buttons remain usable.
3. Selecting a historical reference mounts another `HistorySource`.
4. When `end()` finishes, `setOpen(false)` closes the native dialog but neither clears the newly selected source nor unmounts its viewer.

Consequently, a pending read selected during hang-up remains mounted after the dialog closes. `HistorySource` correctly aborts on unmount—but this path never unmounts it. This is the remaining form of original finding 2, not an unrelated call defect.

**Change-together rationale:** dialog visibility and the lifetime of its source reads belong to `VoiceCall`. A one-time selection reset before an asynchronous operation does not enforce that ownership. The viewer cannot infer whether its enclosing native dialog is closed.

**Minimal redesign:** make closing the dialog reliably unmount its source viewer. For example, gate historical-source rendering on `open`, or clear the selection again in the same completion branch that sets `open` false. Preventing source reselection during closing is also valid. No new lifecycle framework or particular implementation is necessary.

**Preserve:**
- Immediate cancellation of the source already selected when hang-up begins.
- Ability to inspect sources after audio ends naturally while the dialog remains open.
- Reference-keyed pagination, attribution, surrounding records and error display.
- Independent audio cleanup and recap behavior; source inspection must not mark anything reviewed.

**Test:** extend `tests/ui/voice.spec.ts` with a held `/end` response. Begin closing, select a source while the dialog is still visible, start a held paged read, then release the end response. Assert the dialog closes, the historical-source region is absent from the DOM, and the pending read emits `requestfailed` before its fixture response is released.

The existing call-close test starts its read **before** invoking End, so it verifies the initial clear but misses reselection during the await.

## Verification of every original finding

### 1. Standalone controller bootstrap — resolved

In `tests/live-browser.cjs`:

- The explicit module map includes the actual transpiled `client/src/auth/session.ts`.
- Its paths match the runtime imports from `live-session.ts` and `voice/api.ts`; type-only imports do not require fixture resources.
- Unknown non-voice-API paths return 404 rather than 204.
- Setup waits at most five seconds for `window.Controller`, then asserts no page errors.
- Bootstrap failure closes the browser context and HTTP server.
- The hidden-tab test now describes **call reservation**, not indexing.
- The lifecycle suite still checks the synthetic bearer header.

This is an appropriate small explicit fixture, not a duplicated general module loader. `package.json` still runs it separately as `test:live:browser`; `npm test` alone is not evidence of its health.

### 2. Historical-source identity and cancellation — resolved except for the closing race above

`client/src/components/HistorySource.tsx` now owns:

- Reference identity through an internally keyed `SourcePage`.
- Pagination state scoped to that identity.
- An `AbortController` per read, aborted on offset change or unmount.
- Suppression of updates and errors from aborted requests.

`client/src/api/index.ts::readHistory()` forwards the signal to fetch. The server path remains connected: `src/routes/memory.ts` uses `connected()`, and `src/memory/service.ts` removes queued cancelled work or retires the active worker.

The implementation avoids the old “new reference, old offset” request without requiring consumers to remember a key. The extra key in `pages/History.tsx` is harmless, not a worthwhile redesign target.

**Actual new test coverage:**

- `tests/ui/history-fixture.ts` records requests and observes Playwright’s **`requestfailed`** event for each request. Its `aborted` flag is not merely inferred from component disappearance.
- `tests/ui/voice.spec.ts` asserts exactly A/0, A/4000, B/0; asserts cancellation before releasing the held response; and covers source close and ordinary call close.
- `tests/ui/history.spec.ts` asserts pending-page cancellation on navigation away.
- Releasing the old request cannot replace the current source.
- Qualification rendering and existing historical-source browsing remain covered.

These tests establish browser request cancellation, not an end-to-end measurement of worker retirement. Server cancellation behavior has separate implementation/test evidence.

### 3. Obsolete controller hooks — resolved

`CallOptions.onLevel`, its emissions and caller no-ops are gone. `LiveVoiceSession.start()` accepts only `syncId`; its obsolete preparation callback is gone.

The meaningful boundaries remain:

- `VoiceCall.start()` awaits its component-owned `beforeStart`.
- `Sync` supplies readiness-at-click checking and existing note-save behavior.
- The controller retains its liveness check.
- Microphone metering still recognizes a new spoken question after Stop.
- `PlaybackCue` still supplies received-energy observation.
- `VoicePeer` retains its independently consumed media API.

Searches found no remaining `onLevel` or controller-level `beforeStart` in the inspected client, test and peer sources.

### Call identity and cancellation — retained and substantively tested

`LiveVoiceSession.start()` creates its cancellation UUID before sending creation, submits that identity, verifies the returned ID, and uses it for cleanup even if the create response is lost. `end()` aborts controller requests and closes the peer; peer closing aborts negotiation and stops transferred tracks.

Relevant assertions remain in:

- `tests/ui/call-cancel.spec.ts`: real server reservation committed while the create response is withheld; End releases that exact reservation without capture.
- `tests/live-browser.cjs`: reservation-before-capture, failed/aborted reservation, hidden-tab refusal, permission-dialog keepalive, late microphone cleanup, negotiation cancellation and no reload capture.
- `tests/realtime-browser.cjs`: actual local WebRTC cleanup, replacement/late tracks, negotiation abort and observer-failure isolation.
- Targeted reservation/cancellation cases in `tests/live-voice.test.cjs`.

## Retained requirements—not cleanup targets

- **Different authentication policies:** dashboard 401 handling clears/reloads the dashboard session; voice errors propagate into call cleanup. Shared credentials do not require identical transport policy.
- **Navigation and intent:** modified anchor clicks retain browser behavior. Auto-call intent remains transient rather than persisted in navigation history.
- **Different polling lifetimes:** home/settings/preparation polling and call-event polling have different owners. Polling during microphone permission keeps the reserved call alive.
- **Provider/browser special cases:** keyed server waiting state versus unkeyed WebRTC events, typed continuation within one provider turn, stopped-answer epochs, silent input after denial, and Chromium’s muted decoder element remain justified.
- **Presentation variants:** decoded-sample animation is genuinely used by the standalone preview; live received energy is separately used by calls. Reduced motion, renderer budgets, fallback and explicit disposal remain meaningful.
- **Evidence compatibility:** legacy calls, unavailable originals, generated-not-heard qualifications, frozen snapshots and explicit source pagination remain supported behavior.
- **Tests:** privacy assertions at different entry points are not redundant. Existing lifecycle tests should not be replaced with implementation-shape checks.

No speculative redesign is promoted to a finding.

## Reviewed files and coverage

**All files under `client/src/` were read:**

- Root: `App.tsx`, `main.tsx`, `navigation.ts`, `request-id.ts`, `types.ts`, `vite-env.d.ts`.
- Infrastructure: `api/index.ts`, `audio/playback.ts`, `auth/session.ts`, `contexts/AuthContext.tsx`.
- Pages: `Home.tsx`, `History.tsx`, `Login.tsx`, `Sync.tsx`.
- Components: `AgentSources.tsx`, `AutomaticPreparation.tsx`, `EvidenceList.tsx`, `HistoryProgress.tsx`, `HistorySource.tsx`, `IndexSettings.tsx`, `PreparationUsage.tsx`, `SetupPanel.tsx`, `SummaryTree.tsx`, `SyncCost.tsx`, `TextChat.tsx`, `VoiceCall.tsx`, `VoiceCaptions.tsx`.
- Persona: `PersonaStage.tsx`, `background.ts`, `dragon.ts`, `geometry.ts`, `motion.ts`, `scene.ts`, `studio.ts`, `types.ts`, `preview.tsx`, `persona.css`, `preview.css`.
- Styles: `styles/index.css`.

**All `tests/ui/` files were read:** `appearance.spec.ts`, `automatic.spec.ts`, `call-cancel.spec.ts`, `chat.spec.ts`, **`history-fixture.ts`**, `history.spec.ts`, `native-fixture.ts`, `persona.spec.ts`, `preparation-info.spec.ts`, `server.cjs`, `settings.spec.ts`, `setup.spec.ts`, `sync.spec.ts`, `usage.spec.ts`, `voice.spec.ts`.

**Additional complete reads:** `voice/realtime/peer.mjs`, `peer.d.mts`, `probe-browser.mjs`; `tests/browser-foundations.test.cjs`, `persona.test.cjs`, `live-browser.cjs`, `realtime-browser.cjs`, `realtime.test.cjs`, `voice-boundary.test.cjs`, `live-voice-real.cjs`, `http.test.cjs`; `src/routes/http.ts`, `src/routes/memory.ts`, `src/memory/types.ts`, `src/memory/service.ts`; root/client `package.json`, `client/vite.config.ts`, `playwright.config.ts`, `knip.jsonc`, `PERSONA.md`, and both requested review/decision documents.

**Targeted inspection only:** reservation/cancellation tests in `tests/live-voice.test.cjs`; cancellation/test inventory in `tests/memory.test.cjs`; pagination implementation in `src/memory/index.ts`.

**Coverage gaps:** no execution, build, Git-baseline comparison, real-provider qualification, physical-device/browser qualification or dependency audit. Reported test counts in the decision log were not independently reproduced. No credential stores, private logs, `.env` files, installed dependencies, generated assets, test artifacts or source session stores were read.

**CONFIRMED FINDINGS REMAIN**
