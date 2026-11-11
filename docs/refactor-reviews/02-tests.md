## Confirmed worthwhile changes

### 1. Freeze search-cache compatibility fixtures independently of the extracted passage recipe

**Files/functions:**  
- `tests/storage.test.cjs:135–160`, “search migration keeps every compatible vector byte…”  
- `tests/memory.test.cjs:316–335`, “covered-tail migration preserves…”  
- `tests/fixtures/legacy-storage.cjs`, `legacyIndex()`  
- Contract under test: `src/memory/passages.ts`, `passage()` / `passages()`.

These migration tests first build an index with today’s `HistoryIndex`, then copy its chunk offsets, hashes and embeddings into a reconstructed legacy schema. Consequently, the historical fixture changes alongside the current passage recipe. They test migration mechanics, but do not independently establish that extracting the shared hash/window recipe preserved existing cache compatibility.

This is the same hidden coupling that the fixed `summary-cache.cjs` fixture correctly removed for summary caches. Here it matters because indexing, reconstruction and prepared-only validation now share one recipe; agreement among those consumers is insufficient evidence of historical compatibility.

**Minimal redesign:** Add a small fixed synthetic historical search fixture with independently recorded offsets, hashes and vector bytes. Include a multi-window record and a UTF-16 boundary/covered-tail example. Seed the legacy schema directly, migrate it, then exercise ordinary preparation and prepared-only retrieval. Keep the existing dynamically constructed migration tests for deduplication, rollback and scope coverage.

**Preserve/test:** Exact cached vectors and references, historical 700/800 window semantics, no passage re-embedding, source verification and scope admission. The independent test should fail if the live recipe changes stride, slicing or hash framing without a compatible migration.

### 2. Stop tests from reaching through `HistoryIndex`’s private state

**Files/functions:**  
- `tests/reconciliation.test.cjs:120`, “a retrieved follow-up is checked again…” uses `index.current`.  
- `tests/source-batch.test.cjs:82,89`, failure/retry tests use `index.model`.

These are unnecessary links to private implementation details. The reconciliation test needs canonical source records, not the index’s private current-record cache. The scheduler tests already construct and inject the fake embedder, so retrieving it through the implementation’s private field adds no behavioral coverage. TypeScript’s `private` happens to remain accessible to these CommonJS tests.

**Minimal redesign:**  
- Obtain reconciliation inputs from the seeded canonical records through `historySources(db)`, or construct the small `SourceRecord` input directly. Do not prepare an index solely to read its internal cache.  
- Retain the injected fake embedder in the `source-batch` fixture and change its behavior through that fixture-owned reference.

**Preserve/test:** Keep the existing assertions for transitive later-report reconciliation, failed preparation retaining the durable checkpoint, restart retry and vector reuse. Changing the private field names or cache representation should no longer require changing these tests.

### 3. Update server/tray ownership documentation together with the new lock owner

**Files/functions:**  
- `ARCHITECTURE.md:35,48,50`  
- `TRAY.md:34–44`  
- `src/tray/worker.ts:69–70`, ownership explanation in `runTrayWorker()`  
- Actual implementation: `src/server.ts`, `startServer()` / `bound()` / `shutdown()`.

The architecture guide still describes single-server operation chiefly as an assumption and documents occupied-port protection, but omits the new exclusive data-directory lock. `TRAY.md` documents only the companion lock. The tray comment also still presents discovery as preventing another listener from running recovery against the database.

The current correctness boundary is different: **the server acquires directory ownership after binding and before initialization/recovery**, independently of the tray’s discovery check. The tray lock prevents duplicate companions; it is not the database/server ownership lock.

**Minimal redesign:** Document this distinction once in `ARCHITECTURE.md`, including the startup ordering and approximately 30-second unclean-exit recovery. Link or briefly distinguish it in `TRAY.md`. Reword the tray comment to explain that discovery avoids an unnecessary competing launch and preserves external-server presentation, rather than being the exclusive-recovery guarantee.

**Preserve/test:** Keep private IPC as the tray’s shutdown authority and retain external-server non-adoption. Existing behavioral coverage already establishes the central contract:
- `tests/server-state.test.cjs`: different-port duplicate cannot alter active rows or discovery; orderly restart succeeds.
- `tests/pi-setup.test.cjs`: occupied-port launch does not initialize another database.
- `tests/tray.test.cjs`: companion exclusivity and external-server non-interference.

No source-string assertion is needed for this documentation correction.

### 4. Remove the orphaned public-site disclosure styles

**File:** `site/site.css:5`, the `.app-peek` selector family.

The stylesheet retains a complete disclosure/figure variant—summary layout, marker suppression, open-state rotation, image and caption styling—but `site/index.html` contains no `.app-peek`, and `site/site.js` only updates the existing source-example panel. There is no consumer in the public-site source.

**Minimal redesign:** Delete only the `.app-peek` rules. Do not merge or redesign the functioning FAQ disclosures.

**Preserve/test:** The source-example buttons, keyboard activation, FAQ toggling, reduced motion and responsive layout remain covered by `tests/site-browser.cjs`. Run its existing viewport cases; no replacement test for the absence of a CSS class is warranted.

## Retained requirements

I found no justification for deleting the static privacy/product-boundary assertions in `persona.test.cjs`, `voice-boundary.test.cjs`, release/package checks or inference-isolation tests. They can detect meaningful boundary violations.

Likewise, keep the comments explaining private-key re-encoding, legacy normalization/cache compatibility, source-versus-review semantics, provider event ordering, Windows IPC shutdown, Unix process-group confirmation and late-response cancellation. These explain constraints rather than merely narrating implementation.

The new source-view cancellation/identity tests and fixed summary-cache fixtures exercise meaningful behavior. The comments pass did not produce another confirmed worthwhile deletion; I would not manufacture one from ordinary section headings or short contract descriptions.

## Reviewed-file inventory

Paths below are grouped by directory; suffix notation denotes every listed file, not sampling.

**Read completely — `tests/*.test.cjs`:**  
`activity`, `agents`, `answer-references`, `automatic-briefing`, `automatic-defaults`, `automatic-index`, `browser-foundations`, `chat`, `embedding-pool`, `history-relevance`, `http`, `live-voice`, `memory`, `model-assets`, `native-launch`, `native-ownership`, `persona`, `pi-output`, `pi-setup`, `realtime-backend`, `realtime`, `recap-format`, `reconciliation`, `release`, `server-state`, `site-release`, `source-batch`, `storage`, `summary-batches`, `sync-home`, `sync`, `tls`, `tray`, `tree`, `usage`, `voice-boundary`, `voice-continuation`, `voice-history-delivery`.

**Read completely — other `tests/*.cjs`:**  
`live-browser`, `live-voice-real`, `memory-performance`, `memory-real`, `package-smoke`, `realtime-browser`, `realtime-native`, `runtime-smoke`, `site-browser`, `tray-native`, `voice-continuation-real`.

**Read completely — `tests/fixtures/*.cjs`:**  
`agent-logs`, `fake-codex`, `fake-memory`, `fake-npm`, `fake-pi`, `fake-tray-worker`, `legacy-storage`, `source-entry`, `summary-cache`, `voice-sources`.

**Read completely — `tests/ui/`:**  
`appearance.spec.ts`, `automatic.spec.ts`, `call-cancel.spec.ts`, `chat.spec.ts`, `history-fixture.ts`, `history.spec.ts`, `native-fixture.ts`, `persona.spec.ts`, `preparation-info.spec.ts`, `server.cjs`, `settings.spec.ts`, `setup.spec.ts`, `sync.spec.ts`, `usage.spec.ts`, `voice.spec.ts`.

**Source-comment inventory reviewed across all enumerated files:**

- `src/`: `cli.ts`, `data-dir.ts`, `errors.ts`, `npm-cli.ts`, `server-state.ts`, `server-status.ts`, `server.ts`, `types.ts`.
- `src/auth/`: `middleware.ts`.
- `src/db/`: `agent-migration.ts`, `evidence.ts`, `pointer-migration.ts`, `retained-text.ts`, `schema.ts`, `snapshot-pointers.ts`.
- `src/memory/`: `context.ts`, `embedding-contract.ts`, `embedding-pool.ts`, `embedding-worker.ts`, `focus.ts`, `index.ts`, `model-assets.ts`, `model-files.ts`, `model.ts`, `packet.ts`, `passages.ts`, `readiness.ts`, `reconcile.ts`, `service.ts`, `sources.ts`, `stamps.ts`, `storage.ts`, `types.ts`, `worker.ts`.
- `src/pi/`: `runtime.ts`, `setup.ts`.
- `src/routes/`: `auth.ts`, `http.ts`, `live-voice.ts`, `memory.ts`, `sync.ts`, `voice.ts`.
- `src/sources/`: `adapters.ts`, `registry.ts`.
- `src/sync/`: `activity.ts`, `answer-references.ts`, `automatic.ts`, `background.ts`, `collector.ts`, `cost.ts`, `jsonl.ts`, `manager.ts`, `models.ts`, `normalize.ts`, `pi-output.ts`, `pi.ts`, `preparation.ts`, `recap.ts`, `reconciliation.ts`, `references.ts`, `retrieval.ts`, `source-files.ts`, `store.ts`, `summary-budget.ts`, `tree.ts`, `usage.ts`.
- `src/tray/`: `controller.ts`, `launcher.ts`, `native.ts`, `processes.ts`, `worker.ts`.
- `src/voice/`: `continuation.ts`, `history-delivery.ts`, `legacy-history.ts`, `live-context.ts`, `live.ts`.
- `client/src/`: `App.tsx`, `main.tsx`, `navigation.ts`, `request-id.ts`, `types.ts`, `vite-env.d.ts`; `api/index.ts`, `audio/playback.ts`, `auth/session.ts`, `contexts/AuthContext.tsx`.
- `client/src/components/`: `AgentSources.tsx`, `AutomaticPreparation.tsx`, `EvidenceList.tsx`, `HistoryProgress.tsx`, `HistorySource.tsx`, `IndexSettings.tsx`, `PreparationUsage.tsx`, `SetupPanel.tsx`, `SummaryTree.tsx`, `SyncCost.tsx`, `TextChat.tsx`, `VoiceCall.tsx`, `VoiceCaptions.tsx`.
- `client/src/pages/`: `History.tsx`, `Home.tsx`, `Login.tsx`, `Sync.tsx`.
- `client/src/persona/`: `PersonaStage.tsx`, `background.ts`, `dragon.ts`, `geometry.ts`, `motion.ts`, `persona.css`, `preview.css`, `preview.tsx`, `scene.ts`, `studio.ts`, `types.ts`; also `client/src/styles/index.css`, `client/src/voice/api.ts`, `client/src/voice/live-session.ts`.
- `voice/`: `tls.mjs`; `realtime/backend.mjs`, `native.mjs`, `peer.d.mts`, `peer.mjs`, `probe-browser.mjs`, `probe-server.mjs`, `probe.html`, `probe.mjs`, `rpc.mjs`, `setup.mjs`.
- `tray/`: `macos.js`, `windows.ps1`.
- `scripts/`: `release-version.cjs`, `site-release.cjs`.

**Also read completely:** `docs/refactor-decisions.md`, `ARCHITECTURE.md`, `TRAY.md`, `voice/realtime/README.md`, `site/site.js`, `site/index.html`, `site/site.css`. Relevant production implementations were read to verify the findings, including server/tray ownership, activity, history storage/indexing/reconciliation, preparation, HTTP helpers, model assets and shared source viewing.

## Coverage gaps

- This was read-only inspection of current files, including newly present fixtures/tests—not a HEAD-only review. No files were modified.
- No tests, builds, mutation experiments, provider calls or platform/device checks were executed. Reported passing results in the decision log were not treated as independently verified.
- Source-comment coverage is an exhaustive comment inventory, **not** a claim of full behavioral review of every production module listed above.
- Binary audio/image fixtures and tray assets were not inspected. Credential stores, private logs, `.env`, dependencies, generated assets, test artifacts and real session stores were not read.
- The available tools did not provide a Git diff, so findings identify current coupling and coverage weaknesses rather than asserting their exact commit of introduction.

**CONFIRMED FINDINGS REMAIN**
