## Result

**One confirmed extraction regression and two worthwhile ownership/cleanup changes remain.** This was a read-only review of current filesystem contents, including the extracted modules—not a HEAD-only review. No tests were executed.

### 1. Credential extraction breaks the standalone live-controller browser suite

**Location:** `tests/live-browser.cjs`, `modules` and `fixture()` (lines 9–42); `client/src/voice/api.ts:2`.

`voice/api.ts` now imports `../auth/session`, but the test server serves only `live-session.js`, `voice/api`, and `peer.mjs`. The browser therefore requests `/client/src/auth/session`; the fixture treats that unknown module request as an API request and returns **204 without JavaScript**. Module loading fails before `window.Controller` is assigned, so the suite cannot reach its lifecycle assertions.

This is a concrete hidden change-together dependency: the fixture manually duplicates the browser module graph. The reported `npm test` and `test:ui` results do not establish this suite’s health: `package.json` runs it separately as `test:live:browser`.

**Minimal change:**
- Add the actual credential module to the fixture’s explicit transpiled-module map.
- Return 404 for unknown non-API paths instead of silently returning 204.
- Make module-loading failure fail fixture setup promptly, with server/context cleanup.
- Rename “a tab hidden during indexing…” to describe **call reservation**; the fixture no longer performs indexing there.

Do not introduce a general test module loader merely for this dependency.

**Preserve:** real credential-header construction, local-only peers, reservation-before-capture, permission-dialog keepalive, stale-event handling, and cleanup assertions.

**Tests:** run `npm run test:live:browser`; retain its assertion that requests carry the synthetic bearer token. Add a fixture startup assertion that the controller imports successfully without page errors. This suite should be included in verification of future browser-boundary extractions.

### 2. The shared historical-source viewer does not own its request lifetime

**Location:** `client/src/components/HistorySource.tsx`, `HistorySource()` (lines 11–17); `client/src/api/index.ts`, `readHistory`; `client/src/components/VoiceCall.tsx`, `close()` and historical-source rendering (lines 112–116, 229).

Three connected behaviors expose the incomplete ownership boundary:

- Viewer cleanup only sets `alive = false`; it never aborts the fetch.
- Changing references after paging starts a request for the **new reference at the old offset**, before the separate reset effect triggers another request at zero. The History page supplies a key; the call consumer does not.
- Closing the call dialog leaves its source component mounted because the dialog remains in the React tree and `close()` does not clear `source`.

These are not merely discarded React updates. `src/routes/memory.ts` deliberately ties reading to HTTP disconnect, and `src/memory/service.ts` queues reads through the single history worker. Abandoned source reads can continue refreshing history or occupying that queue while the call needs retrieval.

**Change-together rationale:** reference identity, pagination, visibility and cancellation describe one source-viewing lifetime. Consumers should not need to know that changing a reference requires a React key to avoid a redundant read.

**Minimal change:**
- Give client `readHistory` an optional `AbortSignal`; create and abort a controller in the viewer’s fetch effect.
- Make reference changes reset pagination atomically—for example, keep a small reference-keyed stateful body inside the exported component, rather than requiring every caller to key it.
- Clear/unmount the selected source when closing the call dialog.

No shared polling framework is needed.

**Preserve:** the shared `HISTORY_PAGE_CHARACTERS` contract, qualification text, neighbors, explicit pagination, error display, and the independence of viewing a source from ending audio or marking work reviewed.

**Tests:** extend `tests/ui/history.spec.ts` and `tests/ui/voice.spec.ts` with delayed source responses:
1. Page reference A forward, then select B; B starts at offset zero without an old-offset request.
2. Closing the source, navigating away, or closing the call aborts its outstanding read.
3. A late response cannot replace the current source.
4. Existing pagination and attribution remain intact.

Current history tests cover browsing and search cancellation, but not this source-viewer lifecycle.

### 3. Remove obsolete hooks from the internal live-session contract

**Location:** `client/src/voice/api.ts`, `CallOptions`; `client/src/voice/live-session.ts`, `start()`, `meter()`, `end()`; `client/src/components/VoiceCall.tsx:86`.

Two internal API variants have no actual consumer:

- `onLevel` is required, but both `VoiceCall` and the standalone controller fixture supply no-ops. The production comment explicitly says the old meter was replaced.
- `LiveVoiceSession.start(syncId, beforeStart?)` retains an optional preparation callback, but its sole production caller passes only `syncId`. The real preparation/readiness callback already runs in `VoiceCall.start()` **before session construction**.

**Change-together rationale:** the controller API still exposes a removed presentation output and a duplicate preparation location. That forces callers to supply meaningless callbacks and obscures the intended preflight/session boundary.

**Minimal change:** remove the unused `onLevel` option/emissions and the unused controller-level `beforeStart` argument/await. Remove the corresponding no-ops and obsolete comment. Keep the `VoiceCall` preflight callback and the controller’s liveness check.

**Preserve:** input metering itself—it still detects a new spoken question after Stop. Also preserve received-energy observation through `PlaybackCue`, speaker/headphone gating, and reservation-before-microphone ordering. Do **not** shorten or change the separately consumed `VoicePeer` API.

**Tests:** existing `tests/live-browser.cjs` interruption/gating cases and `tests/ui/voice.spec.ts` readiness-at-click, preparation and denial cases establish the behavior to retain once finding 1 is fixed. Type-check all callers after removing the unused surface.

## Retained requirements—not cleanup targets

- **Credential storage versus transport policy:** sharing `auth/session.ts` is appropriate; dashboard reload-on-401 and voice error propagation should not be collapsed into one policy.
- **Navigation:** ordinary-anchor interception must preserve modified clicks. Transient call intent must remain non-persistent so reload/back navigation cannot silently acquire a microphone.
- **Different lifetimes:** dashboard polling, visible-settings polling, busy-sync polling, and call-event polling have different stopping conditions. In particular, call polling during a permission dialog maintains a server reservation; it is not surplus background polling.
- **Voice special cases:** server-keyed waiting state versus unkeyed provider events, same-provider-turn typed continuation, stopped-answer epochs, silent input after permission denial, and the muted decoder element address real protocol/browser behavior.
- **Presentation:** decoded-sample animation remains used by the standalone preview; live received-energy animation is a different supported input, not an unused fallback. Reduced motion, software-renderer limits, WebGL fallback, and explicit disposal remain justified.
- **Compatibility and evidence:** legacy call-history rendering, unavailable-original-source states, explicit source qualifications, and frozen-snapshot distinctions should remain.
- Existing behavioral and privacy tests are not redundant merely because several assert “no capture” or “nothing reviewed.” They exercise different entry points.

No speculative redesign is promoted to a finding.

## Reviewed files and coverage

**All files under `client/src/` were read:**

- Root: `App.tsx`, `main.tsx`, `navigation.ts`, `request-id.ts`, `types.ts`, `vite-env.d.ts`.
- Infrastructure: `api/index.ts`, `auth/session.ts`, `audio/playback.ts`, `contexts/AuthContext.tsx`.
- Pages: `pages/Home.tsx`, `pages/History.tsx`, `pages/Login.tsx`, `pages/Sync.tsx`.
- Components: `components/AgentSources.tsx`, `AutomaticPreparation.tsx`, `EvidenceList.tsx`, `HistoryProgress.tsx`, `HistorySource.tsx`, `IndexSettings.tsx`, `PreparationUsage.tsx`, `SetupPanel.tsx`, `SummaryTree.tsx`, `SyncCost.tsx`, `TextChat.tsx`, `VoiceCall.tsx`, `VoiceCaptions.tsx`.
- Voice: `voice/api.ts`, `voice/live-session.ts`.
- Persona: `persona/PersonaStage.tsx`, `background.ts`, `dragon.ts`, `geometry.ts`, `motion.ts`, `scene.ts`, `studio.ts`, `types.ts`, `preview.tsx`, `persona.css`, `preview.css`.
- Styles: `styles/index.css`.

**Peer/configuration:** `voice/realtime/peer.mjs`, `peer.d.mts`; `client/package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `index.html`, `persona.html`.

**All `tests/ui/` files:** `appearance.spec.ts`, `automatic.spec.ts`, `call-cancel.spec.ts`, `chat.spec.ts`, `history.spec.ts`, `persona.spec.ts`, `preparation-info.spec.ts`, `settings.spec.ts`, `setup.spec.ts`, `sync.spec.ts`, `usage.spec.ts`, `voice.spec.ts`, `native-fixture.ts`, `server.cjs`.

**Additional relevant tests:** `tests/browser-foundations.test.cjs`, `persona.test.cjs`, `live-browser.cjs`, `realtime-browser.cjs`, `realtime.test.cjs`, `voice-boundary.test.cjs`, `live-voice-real.cjs`.

**Supporting context:** `docs/refactor-decisions.md`, `PERSONA.md`, root `package.json`, `playwright.config.ts`, `knip.jsonc`, `voice/realtime/probe-browser.mjs`, `src/memory/types.ts`, `src/memory/service.ts`, `src/routes/memory.ts`; targeted inspection of `src/memory/index.ts`’s source-reading implementation.

**Coverage gaps:** no execution, build, browser/device/provider qualification, dependency-security audit, or Git-baseline comparison was possible with the supplied read-only tools. Finding 1 follows directly from the extraction/import mismatch; findings 2–3 are current ownership/surplus issues, not claims about when they originated. Generated assets, installed dependencies, credentials, logs and source session stores were not read.

**CONFIRMED FINDINGS REMAIN**
