## Result

All **three original findings in `docs/refactor-reviews/01-core.md` are resolved in the current source and regression tests**. However, one additional worthwhile ownership/test-cleanup issue remains: live evidence readers still support copied-text formats that initialization already migrates away.

### Verification of every original finding

1. **Optional embedding qualification consumers — resolved statically.**
   - `tests/memory-real.cjs` now uses `modelFilesPresent` / `prepareModelFiles` and supplies a valid explicit thread budget to `LocalEmbedder`.
   - `tests/memory-performance.cjs` checks assets separately, supplies the direct-inference thread budget, and obtains that branch’s fingerprint from `MODEL_ID`. The pooled branch still uses `EmbeddingPool`.
   - Neither script calls the removed `LocalEmbedder.ready()` or `setup()`.
   - `tests/model-assets.test.cjs` exercises missing-model subprocess paths for the local qualification, benchmark, and direct benchmark child. Assertions require the intended diagnostic, reject the former API failures, and check that no model directory was created.
   - Download consent, offline inference checks, synthetic data, vector comparison, and worker/citation/cancellation qualification remain.
   - **Qualification gap:** I could not execute these scripts against real weights. The missing-model tests do not establish successful inference or completion of the full optional qualification.

2. **Self-derived historical summary-cache fixtures — resolved.**
   - `tests/fixtures/summary-cache.cjs` contains fixed synthetic records, canonical output, and literal v1/v2 keys; it imports no current key generator.
   - The parameterized tests in `tests/tree.test.cjs` seed those rows and invoke ordinary `generateReply()`. They check zero chunk-provider calls, exactly one cache hit, invocation accounting, completion, preserved qualification, and citations to the current snapshot.
   - The v2 fixture exercises the Luna batching path. `tests/summary-batches.test.cjs` retains dynamic cache-island coverage, now accurately described as packing/reuse coverage rather than independent historical compatibility proof.
   - A historical prompt/payload/key change can no longer silently regenerate these fixed fixtures alongside the lookup.

3. **Foreground-only checkpoint comment — resolved.**
   - `src/memory/stamps.ts`, `loadSourceCheckpoint()`, now describes an unknown checkpoint and successful global preparation without assigning scheduling policy to storage.
   - `AutoIndexer.run()` and the tests agree: eligible combined preparation can establish an older missing checkpoint while reusing vectors.
   - `source-batch.test.cjs` retains that regression and interrupted/failed-preparation checkpoint checks; `automatic-index.test.cjs` retains the 0/1/63-record no-timed-flush cases.

## Confirmed worthwhile change

### P3 — Restrict copied-text compatibility to migration, rather than retaining it in live evidence readers

**Files/functions**
- `src/db/evidence.ts:59–61`, `EvidenceReader.read()`.
- `src/sync/source-files.ts:19–32`, `EntryReader.effective()`.
- Related boundary: `src/db/schema.ts`, `initSchema()`; `src/db/{pointer-migration,snapshot-pointers,retained-text}.ts`.
- Tests depending on the live fallback: reference-renumbering tests in `tests/{tree,summary-batches}.test.cjs`; synthetic snapshot writers in `tests/fixtures/voice-sources.cjs`, `tests/live-voice.test.cjs`, and `tests/live-voice-real.cjs`.

**Confirmed behavior and rationale**

`initSchema()` completes both pointer migrations transactionally before returning an application database. The current schema has neither retained-text storage nor the legacy entry-text reference columns. The migration functions use `thawEvidence()` / `retainedText()` directly; they do **not** use the legacy branches in `EvidenceReader` or `EntryReader`.

Nevertheless:

- `EvidenceReader.read()` immediately calls `thawEvidence()` when `source_pointer` is absent. An inline `text` field therefore becomes available evidence **without any original-file verification**. `getSync()` receives no `unavailable` marker, so `assertEvidenceAvailable()` accepts it.
- `EntryReader.effective()` still contains three retained-text branches for columns absent from initialized current storage.
- Several tests keep the first fallback alive by storing thawed API objects directly in `sync_items`. The cache-renumbering tests inadvertently replace valid frozen pointers with copied text simply to change `ref`.

This is an unnecessary coupling between live source authority and migration-only representations, reinforced by invalid current-schema fixtures. It also contradicts the comment claiming that the `EvidenceReader` fallback is a migration/import reader: there is no such production caller in the reviewed source.

This is **not a claim of a remotely writable database or a demonstrated external exploit**. It is a confirmed fail-open representation path and surplus compatibility code at the wrong boundary.

**Minimal redesign**

- Keep `retained-text.ts` and both historical migrations intact.
- Remove retained-text alternatives from `EntryReader`; continue verifying the original record before resolving an edit.
- Require a frozen pointer in live `EvidenceReader.read()`. Treat a missing pointer through its existing strict/tolerant unavailable-evidence behavior, rather than accepting inline text.
- In reference-renumbering tests, update only `ref` in the persisted encoded row, preserving `source_pointer` and `source_key`.
- Make synthetic voice snapshots use temporary JSONL originals and frozen pointers, using the existing fixture utilities rather than adding a production compatibility switch.
- Correct the affected comments to distinguish migration readers from live readers.

**Behavior to preserve**

Exact v1/v2 normalization, historical pointer formats, selected context edits, clipped context, migration rollback, current citation identities, unavailable-source pages that retain conversations/notes, and refusal to generate/call/review unavailable evidence.

**Tests establishing the boundary**

- Retain `storage.test.cjs` migration round trips, missing/ambiguous-original rollback, historical normalization, edit pinning, and unavailable-source guards.
- Add a current-schema row with inline text but no pointer: tolerant snapshot reading must mark it unavailable; strict reading and generation/review guards must refuse it.
- Keep both cache-renumbering tests green using pointer-preserving mutations.
- Retain voice citation-heavy and optional qualification scenarios after converting their fixtures to verified synthetic pointers.

This narrows the earlier review’s “retain legacy readers” conclusion: **migration compatibility is required; these live-reader alternatives are not.**

## Retained requirements—not removal candidates

- Identity-bound leases, cancellation without premature release, background ownership spanning sequential work, and preparation completion promises have distinct necessary roles.
- History-child retirement and embedding-lane termination remain separate lifetime protocols.
- Cheap model presence checks are readiness hints; checksum verification and no-download prepared retrieval remain necessary.
- Live passage identity now has one recipe; historical normalization and migration-era passage rules should remain independently frozen.
- Explicit retrieval reconciliation, offset reads, cutoff/admission checks, and omission of an old checkpoint when its linked follow-ups cannot fit are meaningful requirements.
- Legacy summary prompts, canonical cache IDs, bounded repairs, invocation reservation, conservative unknown-model budgets, and transactional migration refusal remain justified.

No speculative redesign is recommended.

## Reviewed files and coverage

**All assigned source files were read completely from the current filesystem:**

- `src/sync/`: `activity.ts`, `answer-references.ts`, `automatic.ts`, `background.ts`, `collector.ts`, `cost.ts`, `jsonl.ts`, `manager.ts`, `models.ts`, `normalize.ts`, `pi-output.ts`, `pi.ts`, `preparation.ts`, `recap.ts`, `reconciliation.ts`, `references.ts`, `retrieval.ts`, `source-files.ts`, `store.ts`, `summary-budget.ts`, `tree.ts`, `usage.ts`.
- `src/db/`: `agent-migration.ts`, `evidence.ts`, `pointer-migration.ts`, `retained-text.ts`, `schema.ts`, `snapshot-pointers.ts`.
- `src/sources/`: `adapters.ts`, `registry.ts`.
- `src/memory/`: `context.ts`, `embedding-contract.ts`, `embedding-pool.ts`, `embedding-worker.ts`, `focus.ts`, `index.ts`, `model-assets.ts`, `model-files.ts`, `model.ts`, `packet.ts`, `passages.ts`, `readiness.ts`, `reconcile.ts`, `service.ts`, `sources.ts`, `stamps.ts`, `storage.ts`, `types.ts`, `worker.ts`.
- `src/types.ts`, `src/errors.ts`, `src/data-dir.ts`.

**Tests read completely:**  
`tests/{activity,agents,automatic-briefing,automatic-index,embedding-pool,memory,model-assets,reconciliation,source-batch,storage,summary-batches,tree,voice-boundary}.test.cjs`; `tests/memory-real.cjs`; `tests/memory-performance.cjs`.

**Fixtures read completely:**  
`tests/fixtures/{summary-cache,source-entry,legacy-storage,voice-sources}.cjs`.

**Supporting review:** complete `src/routes/sync.ts`, the two requested review/decision documents, `MEMORY.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, and `package.json`; targeted fixture-setup excerpts in `tests/live-voice{,-real}.cjs`, searches across test snapshot writers, and targeted searches in voice retrieval/delivery callers.

**Coverage gaps:** no assigned source-file omissions. Other tests and outside-scope callers were not exhaustively reviewed. This was static, read-only review: no builds, tests, model downloads, or real-provider/model qualifications were executed. Filesystem enumeration included current new files, but Git provenance was not established. No prohibited credential stores, private logs, generated assets, dependency trees, or actual session stores were read.

**CONFIRMED FINDINGS REMAIN**
