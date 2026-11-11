## Final gate: PASS for the reviewed core scope

No additional worthwhile coupling, compatibility, ownership, or surplus-code finding was confirmed. **All findings from `01-core.md` and `02-core.md` are resolved in the current working tree.**

This is an independent **static, read-only gate**, not an independent execution of the reported 336 tests or mutation checks.

## Verification of recorded fixes

### 1. Copied-text compatibility is confined to migrations

- **`src/db/evidence.ts`, `EvidenceReader.read()`** requires `source_pointer`. Inline text is no longer an alternative authority. Missing pointers throw in strict mode; tolerant reads return empty text, the unavailable marker, preserved attribution, and the saved canonical source key.
- **`src/sync/source-files.ts`, `EntryReader.effective()`** has no retained-text alternatives. A nonempty edited projection verifies the original record before resolving and verifying its edit.
- Searches across production source found retained-text imports and legacy-column handling only in **`src/db/pointer-migration.ts`**, **`src/db/snapshot-pointers.ts`**, and their migration helper.
- **`src/db/schema.ts`, `initSchema()`** still performs the historical conversions transactionally before exposing initialized storage. The historical readers remain independent of the stricter live readers.

**Tests establish the intended distinction:**  
`tests/evidence-boundary.test.cjs` covers inline-only primary and context evidence, strict/tolerant behavior, unchanged persisted input, stable identity, generation/call/review refusal before provider or durable-work side effects, preserved conversations and editable notes, and original-before-edit verification.

`tests/storage.test.cjs` retains migration round trips, rollback on unavailable/changed/ambiguous originals, historical normalization and clipping, exact edit selection, moved files, and unavailable-source behavior. Removing the live fallback has not removed the historical conversion path.

### 2. Voice fixtures now exercise original-backed evidence

- **`tests/fixtures/source-entry.cjs`, `frozenEvidence()`** writes synthetic JSONL originals, reads their verified projection, then freezes it through `EvidenceReader`.
- **`tests/fixtures/voice-sources.cjs`** persists encoded pointers rather than API projections containing copied text.
- The fixture writers in **`tests/live-voice.test.cjs`** and **`tests/live-voice-real.cjs`** use that helper and temporary source roots.
- The citation-heavy regression in **`tests/evidence-boundary.test.cjs`** checks all 37 references, absence of stored `text`, presence of pointer/key metadata, and loss of availability after removing the synthetic original.

The fixtures now test the production authority boundary instead of preserving a test-only compatibility path.

### 3. Reference renumbering preserves frozen pointers

Both **`tests/tree.test.cjs`** and **`tests/summary-batches.test.cjs`** read the persisted encoded row and change only `ref`. They no longer serialize thawed `getSync()` evidence back into storage.

Their assertions retain the important behavior: canonical summary reuse across new local labels, current citations in the final answer, and only the final provider call—including the one-call-budget case.

### 4. Historical compatibility fixtures are independently fixed

**Summary caches**
- **`tests/fixtures/summary-cache.cjs`** contains literal v1/v2 keys, fixed synthetic originals, and canonical output; it imports no current key generator.
- Ordinary `generateReply()` tests assert zero leaf-provider calls, one cache hit, invocation accounting, completion, qualification preservation, and citations to the current snapshot.
- The dynamic cache-island test remains useful planning coverage and is no longer presented as independent historical compatibility proof.

**Search caches**
- **`tests/fixtures/search-cache.cjs`** fixes historical bodies, offsets, hash literals, and little-endian vector bytes independently of `passages()`.
- **`tests/storage.test.cjs`** exercises migration, ordinary preparation, newly frozen aliases, ordinary search, cold prepared-only searches, and offset reads.
- Its fake embedder rejects passage inference. Creating new aliases is particularly important: it forces the live recipe to find the historical hashes rather than merely accepting already-embedded legacy links.
- The fixture covers a split surrogate boundary, a redundant covered tail, and a necessary second Unicode window. It checks vector preservation, occurrence IDs, FTS behavior, no prepared-read writes, and source/admission enforcement.

The parent’s reported summary-version and passage-stride mutations are consistent with these assertions. **I did not rerun those mutations or inspect compiled output.**

### 5. Optional qualification consumers use the extracted owners

- **`tests/memory-real.cjs`** uses asset presence/preparation functions and supplies an explicit bounded inference-thread count.
- **`tests/memory-performance.cjs`** uses asset presence checks, an explicit direct-inference budget, and `MODEL_ID` for that branch’s fingerprint; pooled inference still uses `EmbeddingPool`.
- Explicit download consent, offline-inference checks, synthetic data, vector comparison, and worker/citation/cancellation qualification remain.
- **`tests/model-assets.test.cjs`** exercises missing-weight subprocess paths and checks the intended diagnostic, absence of obsolete-API failures, and absence of downloads/model-directory creation.

Successful real-weight qualification remains an execution gap, not an unresolved extraction defect.

### 6. Checkpoint policy and test ownership are corrected

- **`src/memory/stamps.ts`, `loadSourceCheckpoint()`** describes an unknown checkpoint without imposing foreground-only scheduling.
- **`src/sync/background.ts`, `AutoIndexer.run()`**, `source-batch.test.cjs`, and `automatic-index.test.cjs` agree on combined preparation, durable checkpoints, compatible-vector reuse, and no timed flush for 0/1/63-record tails.
- Reconciliation tests obtain canonical records through `historySources()`. Failed-preparation tests retain fixture-owned embedders rather than reaching into `HistoryIndex.current` or `.model`.

## Special cases retained after review

These express existing contracts, not removable design omissions:

- **Historical compatibility:** versioned normalization, migration-only copied-text readers, unique historical edit matching, independent migration-era passage constants, and transactional refusal protect existing evidence.
- **Live authority:** original/header/hash verification, original-before-edit checks, unavailable-source presentation, and frozen versus currently admitted history serve different purposes.
- **Retrieval:** explicit-reference/offset reads, reconciliation intent independent of packet size, project switching versus conversation recall, cutoff checks, and omission of an old checkpoint when its follow-ups cannot fit are meaningful policies.
- **Summary execution:** paid-cache reuse, canonical versus local citation namespaces, bounded repair, reserved final invocation, and conservative non-Luna budgets remain justified.
- **Ownership:** activity leases, preparation completion promises, durable run state, history-child retirement, and inference-lane termination are distinct responsibilities. The new shutdown paths reject admission and await their owned resources rather than treating cancellation requests as completion.
- **Assets:** cheap presence hints, checksum verification, prepared-only no-download behavior, and inference isolation should remain separate.

No speculative redesign is recommended.

## Reviewed files and coverage

**All assigned source files were read completely from the current filesystem:**

- **`src/db/`**: `agent-migration.ts`, `evidence.ts`, `pointer-migration.ts`, `retained-text.ts`, `schema.ts`, `snapshot-pointers.ts`.
- **`src/sync/`**: `activity.ts`, `answer-references.ts`, `automatic.ts`, `background.ts`, `collector.ts`, `cost.ts`, `jsonl.ts`, `manager.ts`, `models.ts`, `normalize.ts`, `pi-output.ts`, `pi.ts`, `preparation.ts`, `recap.ts`, `reconciliation.ts`, `references.ts`, `retrieval.ts`, `source-files.ts`, `store.ts`, `summary-budget.ts`, `tree.ts`, `usage.ts`.
- **`src/sources/`**: `adapters.ts`, `registry.ts`.
- **`src/memory/`**: `context.ts`, `embedding-contract.ts`, `embedding-pool.ts`, `embedding-worker.ts`, `focus.ts`, `index.ts`, `model-assets.ts`, `model-files.ts`, `model.ts`, `packet.ts`, `passages.ts`, `readiness.ts`, `reconcile.ts`, `service.ts`, `sources.ts`, `stamps.ts`, `storage.ts`, `types.ts`, `worker.ts`.
- **Shared**: `src/types.ts`, `src/errors.ts`, `src/data-dir.ts`.

**Tests read completely:**  
`tests/{activity,agents,answer-references,automatic-briefing,automatic-defaults,automatic-index,chat,embedding-pool,evidence-boundary,history-relevance,memory,model-assets,pi-output,recap-format,reconciliation,server-ownership,source-batch,storage,summary-batches,sync-home,sync,tree,usage,voice-boundary}.test.cjs`; `tests/memory-real.cjs`; `tests/memory-performance.cjs`.

**Fixtures read completely:**  
`tests/fixtures/{fake-memory,legacy-storage,search-cache,source-entry,summary-cache,voice-sources}.cjs`.

**Supporting review:** complete `src/routes/sync.ts`, `MEMORY.md`, `package.json`, `docs/refactor-decisions.md`, and `docs/refactor-reviews/{01-core,02-core}.md`; targeted fixture-setup reads/searches in `tests/live-voice{.test,-real}.cjs`.

**Coverage gaps**
- No assigned source-file omissions. Other tests and outside-scope callers were not exhaustively reviewed; the two live-voice files received fixture-focused review only.
- No tests, builds, mutation checks, downloads, real-model/provider qualifications, or physical-device checks were executed. The reported **336 passing tests** remains parent-supplied execution evidence.
- Filesystem review included the enumerated new files, but Git provenance was not established.
- No prohibited credential stores, private logs, `.env` files, dependency trees, generated assets, test artifacts, or actual source-session stores were read.

**NO WORTHWHILE FINDINGS REMAIN IN REVIEWED SCOPE**
