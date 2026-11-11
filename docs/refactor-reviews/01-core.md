## Confirmed worthwhile changes

### 1. **P2 — Model extraction broke both real-model qualification entry points**
**Files/functions:** `src/memory/model.ts:13` (`LocalEmbedder` constructor); `tests/memory-real.cjs:15–20`; `tests/memory-performance.cjs:8–25`.

Both scripts still construct `LocalEmbedder(directory)` without the now-required thread count. The constructor immediately throws `Invalid embedding thread budget`. Supplying that argument alone is insufficient: both scripts still call removed `ready()`, the local qualification calls removed `setup()`, and the benchmark reads the removed `fingerprint`.

This breaks the documented `npm run test:memory:local` command and CPU comparison command, regardless of whether valid weights already exist. `npm test` selects `tests/*.test.cjs`, so its reported success does not cover either entry point.

**Change-together rationale:** extracting asset ownership and narrowing the inference class requires migrating *all* inference consumers, including optional qualification tools. These scripts still depend on the former combined asset/inference interface.

**Minimal redesign:**
- Use `modelFilesPresent` / `prepareModelFiles` for asset operations.
- Give direct `LocalEmbedder` construction an explicit, bounded thread budget.
- Read the pinned fingerprint from `MODEL_ID` for the direct-inference benchmark branch.
- Keep the parallel branch using `EmbeddingPool`; do not restore obsolete methods merely to accommodate the scripts.

**Preserve:** explicit download consent, offline inference, synthetic-only data, single-session versus pooled comparison, vector compatibility checks, and existing worker/citation/cancellation qualification.

**Tests:** add a lightweight subprocess smoke test exercising the scripts’ missing-model paths without downloads, expecting their intended missing-model diagnostic rather than constructor/API failures. Then run both documented qualification commands against an existing pinned test model. The existing `model-assets.test.cjs` and `embedding-pool.test.cjs` establish the new owners’ contracts but do not exercise these callers.

### 2. **P3 — Historical summary-cache tests derive their compatibility fixtures from the implementation being tested**
**Files/functions:**
- `tests/tree.test.cjs:335–345`, “validated v1 leaf caches survive…”
- `tests/summary-batches.test.cjs:43–47`, `seedOld`, and the “validated v2 leaf cache islands…” test.
- Related production contract: `src/sync/tree.ts`, `SummaryTree.spec()` / `chunkSpecs()`.

The v1 test obtains the supposedly historical key from today’s `spec.legacyKey`; the v2 test obtains it from today’s `spec.key`. Both use the current private `chunkSpecs()` implementation to manufacture their old cache.

Consequently, changing the historical prompt, payload recipe, or key calculation can change the fixture and lookup together while these tests remain green. They establish reuse of currently generated keys, not compatibility with independently retained historical keys.

**Change-together rationale:** historical cache data must **not** change together with the current key generator. This unnecessary dependency on private planning internals weakens the specific compatibility guarantee used to justify keeping legacy prompts and cache variants.

**Minimal redesign:** retain the broader planning/cache-island tests, but add or replace the compatibility assertions with a small, fixed synthetic snapshot and independently frozen v1/v2 cache keys and outputs. Do not generate those keys through current `SummaryTree` methods.

**Preserve:** reuse of already-paid valid leaves, canonical source IDs rather than sync-local labels, invocation accounting, and processing of uncached gaps.

**Tests:** seed the frozen historical rows, run ordinary generation, and assert zero leaf-provider calls for those rows, correct cache-hit counts, and correct current citations. An intentional change to the legacy prompt/key recipe should fail this regression test rather than silently regenerate its fixture.

### 3. **P3 — Checkpoint-reader comment still documents the removed foreground-only policy**
**File/function:** `src/memory/stamps.ts:57–60`, `loadSourceCheckpoint()`.

The comment says older indexes without a checkpoint “need one foreground preparation.” Current `AutoIndexer.run()` in `src/sync/background.ts:62–73` allows combined automatic preparation to establish that checkpoint when its scheduling conditions are met. `MEMORY.md` and the rewritten `source-batch.test.cjs` explicitly describe and test that behavior.

**Change-together rationale:** the scheduler-policy simplification and its comment/test cleanup were incomplete. The storage reader should describe the meaning of a missing checkpoint, not retain an obsolete scheduling restriction.

**Minimal redesign:** say that `undefined` means an existing cache has no established checkpoint; successful global preparation can establish one while reusing compatible vectors. Leave scheduling eligibility to the scheduler.

**Preserve:** read-only checkpoint loading, the distinction between absent/new storage and an older unknown baseline, strict batch eligibility, and advancement only after successful global preparation.

**Tests:** retain “combined preparation establishes a missing older checkpoint…” plus the 0/1/63-record no-flush and interrupted-preparation checkpoint tests. No new runtime behavior is needed.

## Retained requirements—not removal candidates

- **Activity ownership:** identity-bound, idempotent release and cancellation without immediate lease removal are justified. Preparation’s completion promises and errors serve different purposes from the activity registry. The start route releases its reservation immediately before synchronous snapshot creation; it does not call the store while its own reservation still makes `activity.busy` true.
- **Worker ownership:** history-child retirement must continue gating replacement startup; embedding-lane termination and native-helper-exit confirmation solve different lifetime problems. They should not become one generic shutdown wrapper.
- **Model assets:** cheap size-based presence is only a readiness hint; checksum verification and no-download prepared lookups remain necessary. Keeping tokenizer/WASM loading out of coordinator/readiness imports is worthwhile.
- **Passage identity:** the shared live passage recipe correctly joins indexing, reconstruction and prepared validation. Migration-era constants and legacy normalization recipes should remain frozen independently.
- **Retrieval:** explicit reconciliation intent is now separate from packet size. Offset reads, admission/cutoff checks, and omission of an earlier checkpoint when its selected follow-ups cannot fit remain meaningful exceptions.
- **Persistence and summaries:** transactional refusal of ambiguous migrations, original-byte verification, frozen edit selection, bounded same-model repairs, final-invocation reservation, and conservative unknown-model budgets protect existing evidence and paid work.

I did not confirm another production behavior regression in the assigned source files. No speculative redesign is recommended.

## Reviewed files and coverage

I read the current filesystem contents, including the newly introduced modules, rather than relying on HEAD or the decision log’s conclusions.

**All assigned source files reviewed completely:**

- `src/sync/`: `activity.ts`, `answer-references.ts`, `automatic.ts`, `background.ts`, `collector.ts`, `cost.ts`, `jsonl.ts`, `manager.ts`, `models.ts`, `normalize.ts`, `pi-output.ts`, `pi.ts`, `preparation.ts`, `recap.ts`, `reconciliation.ts`, `references.ts`, `retrieval.ts`, `source-files.ts`, `store.ts`, `summary-budget.ts`, `tree.ts`, `usage.ts`.
- `src/db/`: `agent-migration.ts`, `evidence.ts`, `pointer-migration.ts`, `retained-text.ts`, `schema.ts`, `snapshot-pointers.ts`.
- `src/sources/`: `adapters.ts`, `registry.ts`.
- `src/memory/`: `context.ts`, `embedding-contract.ts`, `embedding-pool.ts`, `embedding-worker.ts`, `focus.ts`, `index.ts`, `model-assets.ts`, `model-files.ts`, `model.ts`, `packet.ts`, `passages.ts`, `readiness.ts`, `reconcile.ts`, `service.ts`, `sources.ts`, `stamps.ts`, `storage.ts`, `types.ts`, `worker.ts`.
- `src/types.ts`, `src/errors.ts`, `src/data-dir.ts`.

**Tests reviewed completely** (under `tests/`):
`activity.test.cjs`, `agents.test.cjs`, `answer-references.test.cjs`, `automatic-briefing.test.cjs`, `automatic-defaults.test.cjs`, `automatic-index.test.cjs`, `chat.test.cjs`, `embedding-pool.test.cjs`, `history-relevance.test.cjs`, `live-voice.test.cjs`, `memory.test.cjs`, `model-assets.test.cjs`, `pi-output.test.cjs`, `pi-setup.test.cjs`, `recap-format.test.cjs`, `reconciliation.test.cjs`, `server-state.test.cjs`, `source-batch.test.cjs`, `storage.test.cjs`, `summary-batches.test.cjs`, `sync-home.test.cjs`, `sync.test.cjs`, `tree.test.cjs`, `usage.test.cjs`, `voice-boundary.test.cjs`, `voice-history-delivery.test.cjs`, `memory-real.cjs`, `memory-performance.cjs`.

**Supporting fixtures reviewed:** `tests/fixtures/{agent-logs,fake-memory,fake-pi,legacy-storage,source-entry}.cjs`.

**Contract/context checks:** complete `src/routes/{sync,memory,live-voice}.ts`, `docs/refactor-decisions.md`, `MEMORY.md`, and `package.json`; targeted excerpts/searches in `src/voice/live.ts`, `src/server.ts`, other callers of extracted owners, and `CONTRIBUTING.md`.

**Coverage gaps:** no assigned source-file omissions. This was static, read-only review: no tests/builds or real-model qualifications were executed, no Git provenance was established, and outside-scope callers were not exhaustively reviewed. Other browser, physical-device, release and real-provider suites were not reviewed. No credential stores, private logs, generated assets, dependency trees or actual session stores were read.

**CONFIRMED FINDINGS REMAIN**
