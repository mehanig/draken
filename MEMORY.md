# Historical search

**Just ask.** Draken automatically searches retained older sessions, sync conversations and saved notes when you ask a text question or talk to it. The separate **Search history** page (`/history`) lets you inspect the same records directly.

There is no memory-enable switch, index-update button, search-mode selector or wider-history checkbox. Historical retrieval does not replace the complete-snapshot summary tree or advance review coverage.

## Automatic preparation

The first request with eligible retained history downloads approximately **136 MB** of pinned model/tokenizer files from Hugging Face, verifies their SHA-256 checksums and prepares local embeddings. Later requests reuse them and automatically embed new or changed records. Empty history does not require a model download.

Search combines meaning and exact keywords every time. It waits for both indexes rather than quietly returning keyword-only results while semantic work is incomplete. First use or a large amount of newly collected history can take minutes. Search, text-reply preparation and call setup show the current phase, model-download bytes or completed/total **new or changed unique passages**, unchanged cached work separately, elapsed time and an approximate remaining time once enough passages have been measured. The estimate can change with passage length. Progress is read-only metadata; polling it does not start indexing. Calls finish history preparation before the browser requests microphone permission or acquires a microphone track, and before connecting to ChatGPT. Cancelling or failing preparation leaves the microphone off. Ordinary concurrent requests queue behind one history process, within a fixed bound. Its embedding lanes run bounded batches in parallel; they do not run concurrent database writers. An unchanged index shows **History is up to date**, not a full-archive progress bar.

No session text or queries are uploaded for embedding. Text discussion and ChatGPT voice do receive the relevant historical excerpts, just as they receive frozen snapshot context. Those excerpts are dated background—not newly reviewed progress, agreement or permission to execute work.

Opening/reloading a page does not itself download the model, compute embeddings or start a microphone. Source collection happens through sync/scan actions or the optional server-side background schedule below. The search child itself follows only recorded, verified JSONL pointers beneath the configured per-agent source roots; it does not discover sessions or roam project files. There is no automatic decision saving, API-key fallback or second voice engine.

### Optional background indexing

**Settings → Automatically index history**, available from the top bar on every page, is off by default. Its explicit, persistent opt-in authorizes local scanning and embedding (including the first-use model download) while the server runs, even with no browser open. It does not run provider summaries, create/extend frozen syncs, transcribe audio or advance review. Agent logs are already text; summary generation still happens on the explicit sync action and remains separately costed.

The app's single scheduler checks once a minute when no sync, call or foreground history work is active. A background batch requires at least 64 changed source records, regardless of how long they have waited. There is no timed flush. Smaller pending batches remain eligible for normal on-demand preparation when you sync, start a call or search; that foreground path has no minimum batch size. Metadata hashes detect additions, edits and removals once per original source entry (or discussion/note record). Session/file bookkeeping does not add records, and frozen aliases coalesce with the original rather than multiplying the count. Actual indexing still reconstructs and verifies admitted source bytes. Unchanged checks do not start an embedding request. Source records and embedding passages are different counts. New sessions from enabled agents retain the collector's included-by-default behavior; per-agent/per-session exclusions and the existing baseline remain respected. Codex and Claude sources require separate explicit opt-in in **Settings → Agents & sessions**, even if background indexing is already enabled. Summarization continues to use pi. See [SOURCES.md](SOURCES.md).

Foreground history requests preempt an active background request, waiting for the old child to exit before replacement. Disabling aborts only owned background embedding work; a scan already in progress may finish, but cannot start an embedding batch afterward. Completed vector commits remain reusable. Failures are visible and retry no sooner than five minutes; foreground preemption waits at least one minute. Shutdown awaits the owned scan/work within the existing bounded server shutdown. Reads of settings/progress start no jobs. The preference is a small `sync_settings` entry. A hash-only checkpoint in the derived search database survives restart and advances only after successful unscoped/current-call preparation; a historical or source-filtered search cannot replace it. It is scheduling metadata, not review coverage or a substitute for source verification. Progress remains process-local. An older index without a checkpoint waits for one foreground call preparation or unfiltered history search instead of treating its cached archive as newly changed. Unchanged preparations do not rewrite the checkpoint. There is no original-text copy, new provider, model substitution, vector conversion or timed small-batch flush.

A failed preparation/search reports an error. If a session file changed, moved or disappeared, scan sessions again before retrying; stale derived text is not a substitute for a verified source. Otherwise retry the ordinary question or call; completed embeddings are reused automatically. Cancelling a search, closing call setup or cancelling a text reply stops its owned work. There is no separate maintenance workflow to recover.

## How it works

```text
Canonical metadata in draken.db (read-only to search worker)
             │
             ├── selected session pointers → verified JSONL records
             ├── frozen evidence pointers → exact recorded JSONL/edit selections
             ├── preserved sync discussion (with playback qualifications)
             └── explicitly saved notes
             ↓
Automatic local preparation when needed
             ├── SQLite FTS5 word index
             └── sqlite-vec over local text embeddings
             ↓
Combine matches → bounded source/context reads → dated H citations
```

- **Model:** `Xenova/multilingual-e5-small`, pinned revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, quantized ONNX. Uses query/passage prefixes, mean pooling and normalized 384-dimensional vectors. Long token sequences use bounded windows rather than silently embedding only a prefix.
- **Runtime:** CPU WASM through the same pinned `onnxruntime-web`, in one server-side history process. On machines with at least 12 available logical CPUs and 4 GiB of available memory, deltas of at least 32 passages use up to two isolated embedding worker threads, each with one model session and three kernel threads (six total). Smaller/constrained machines keep one lane, with at most four kernel threads and half the available CPUs (minimum one). Reads start no model; queries/small deltas use one lane. A second in-memory model copy costs additional RAM (about 1.7 GB process RSS for two lanes versus roughly 1 GB previously on the qualified host), but adds no on-disk model copies, GPU package or runtime dependency. Lanes retire with the history process, including cancellation; failures stop the request rather than switching runtimes. It is **not imported by the client** and is not transcription or speech synthesis. This avoids native CUDA-install downloads. The runtime package itself occupies additional disk space (about 133 MiB in the qualified Linux install), beyond model files.
- **Tokenizer:** pinned `@huggingface/tokenizers`; no downloaded executable model code.
- **Search:** FTS5/BM25 plus pinned `sqlite-vec` 0.1.9. Approximately 800-character overlapping passages (without redundant short tails already covered by the preceding passage), up to 80 candidate chunks per method, combined ranks and at most eight distinct source results. The minimum cosine-similarity threshold is a heuristic, not a correctness guarantee. Exact identifiers remain important keyword matches.
- **Identity:** content-addressed `H…` references retain source attribution; snapshot-local E/C labels are not global IDs. Duplicate attributions retain scope membership while sharing embeddings and collapsing in results. Changed/excluded records cannot silently replace the text behind an old link.
- **Preparation:** source admission and raw pointer integrity are still revalidated; delta indexing does not skip those checks. A bounded, process-local normalization cache avoids reparsing unchanged records, but is consulted only after rereading and verifying the complete raw-record hash. No cached text substitutes for missing or changed originals, and this cache is never written to disk. Only added/changed/deleted source records update postings and links. Only unique passages without a compatible vector enter the embedding queue. Unchanged refreshes perform no index writes, and a fully cached preparation does not load/download a model; an actual semantic query still ensures its model is ready. At most eight passage inputs are scheduled per batch, with no unbounded queue. Writes commit at batch boundaries after at most 64 passages or roughly a second of computed work. Progress counts only committed delta passages from zero; cached counts sit outside the denominator. A retry counts only work still uncommitted. ETA measures parallel wall-clock throughput and excludes the first cold batch. The existing model fingerprint/cache and original source references remain valid; obsolete fully covered tail chunks are removed only from the derived index.
- **Bounds:** one worker and at most eight queued requests; bounded queries, candidates, source pages and context packets. Preparation/search stops after ten minutes without a progress update, or two hours overall; read operations retain their 30-second limit. A healthy first index is no longer killed merely because it passes 30 minutes. The separate voice-call limit still applies. The worker retires after five idle minutes. Cancellation terminates the owned child when needed; queued work waits for its exit before starting a replacement. Search/read cancellation is isolated from other queued requests. Server shutdown cancels all owned work.
- **Storage:** `records` retains attribution metadata, not another full-text copy. Unique `passages` hold input hashes and embedding state, not text; `chunk_links` retain every source occurrence and offset. `passage_vectors` stores one vector per unique input. `chunks` and `embedding_cache` are join views, not duplicate physical stores. Contentless FTS5 keeps occurrence-level token postings and positions, not original passage strings, so scope membership and keyword document frequencies remain intact. Tokens and vectors are still private derived data, not an anonymization or secure-erasure mechanism. Text for reads and embedding is reconstructed from verified sources in memory. Semantic ranking selects scoped unique passages, expands their scoped occurrences, then bounds the candidate list; ties can rank differently from the former per-occurrence vector layout.
- **Rebuildability:** the separate passages, keyword index and vectors are derived. Fingerprints invalidate incompatible model data. The worker opens `draken.db` read-only and can read only recorded session files beneath the explicitly supplied session root. It has no source-file write, discovery, scan or application-write path.

## Pointer storage and migration

Live `agent_entries` keep metadata, agent/session attribution, parser versions, byte offsets/lengths, raw-record SHA-256 hashes and branch/edit links—not `text`, `effective_text` and replacement copies. Reads verify the configured root, regular-file identity, session header, complete record hash and normalized entry identity. Context edits resolve both the original record and the selected edit. Append scans verify prior pointers when the file changes, including middle rewrites that leave its prefix and old tail intact.

**Pi JSONL files are the authoritative original-text archive, including for old snapshots.** `sync_items` and frozen background context pin the original record coordinates/hash, normalization version, exact selected context-edit pointer when present, any historical excerpt-clipping recipe, and a projected-text hash. Their membership, attribution and E/C identities remain frozen; later appends/edits/branch switches do not redirect them to the live projection. The current schema has no `retained_text` table. Versioned normalization reproduces older evidence exactly while current model-facing redaction remains in force.

Missing or altered originals are explicitly unavailable, not substituted with search text. Snapshot pages still show discussion, notes and stable citation identities. Generating replies, calling, expanding or marking the snapshot reviewed requires its evidence to be available. Restore the original files and rescan if live pointers moved or their file identity changed. Frozen reads can follow a newly registered path only after checking the session, record hashes and projection. An explicit scan updates current missing/admission state; it does not reconstruct lost snapshot bodies.

The one-way `pointer-v2` migration verifies every existing body against recorded original session prefixes before removing it. Unavailable, ambiguous or unmatchable originals stop and roll back conversion, preserving the old database rather than deleting or guessing evidence. Legacy edit matches must be unique, on a descendant branch and not dated after the snapshot; they carry `legacy_edit_match` because exact edit selection was not originally recorded. New snapshots record that selection directly. Entry IDs, projected evidence, notes, review coverage and summary caches are preserved. The `history-index-v3-contentless` search migration removes passage-body storage while retaining compatible vector bytes, occurrence/reference IDs and keyword frequencies without inference or an embedding-model change. Each database's conversion is transactional and can retry after failure. Unknown formats or conflicting vectors fail visibly instead of silently rebuilding.

Back up both current databases before deployment and qualify migration on private copies. Older binaries are not compatible with the pointer schema. SQLite can retain freed pages and WAL files: reclaiming them with an offline checkpoint/VACUUM is a separate deployment step, not automatic history deletion or page-open maintenance. The search worker closes SQLite on orderly retirement and requests a 4 MiB retained-journal limit after normal checkpoints; active transactions/readers can still require a larger WAL. Backups and pinned model files are additional disk use and are not included in compacted database-size claims. Pre-migration rollback backups still contain the old copied text; migration does not delete or securely erase those backups.

## Scope and qualifications

Source inclusion, missing-session state, active branches for unsnapshotted entries and the existing history baseline are respected. Frozen evidence remains historical, including superseded branch material. Reviewed records remain searchable. Discarded sync discussion/notes are excluded, while discarded work can still be eligible through an active selected session.

Each lookup prepares the candidates observed at its start. Exclusions and edits are rechecked after inference; removed/changed candidates are pruned. Arrivals during a lookup wait for the next lookup, which prepares them automatically. This avoids mixing fresh keyword-only records into results described as fully hybrid.

Sync discussion is its own retained record: excluding a session does not erase text previously discussed in a sync. Recaps/current briefings are not separately indexed as primary evidence, though preserved discussion can contain historical assistant summaries; attribution remains visible.

Search covers admitted normalized source projections and retained Draken discussion—not every byte of the original JSONL files. Excerpt, ranking and packet limits can omit important information. No match is not proof something never happened. Similarity is not proof a source supports an answer. The local multilingual qualification is not a comprehensive relevance benchmark.

Open-sync notes have no retained edit timestamp and are not backdated. Date filters exclude undated notes. Calls use their start time as the historical cutoff so the active call does not retrieve its new questions as old history. A date filter does not reconstruct an earlier database state: context edits may change retained text without supplying a separate edit date.

Generated/interrupted speech stays qualified as generated/interrupted. Historical requests are data, not instructions. Prompts distinguish plans, reported work, observed validation and uncertainty. Models can still make semantic mistakes; inspect supporting records. Retrieval cannot save decisions, execute tools, complete syncs or advance coverage.

## Private files and packaging

Under `DRAKEN_DATA_DIR` (default `~/.draken`):

- `draken.db`: canonical live/frozen pointers and metadata, Draken conversations, notes and generated summaries; not rewritten by retrieval.
- `memory/index.sqlite` and sidecars: passage hashes/unique vectors, source-occurrence mappings and contentless keyword postings.
- `memory/model/`: three pinned model/tokenizer files, downloaded automatically when first needed.

The directory is private (0700); database/model files are 0600. Embeddings are private data too. None belongs in a commit or npm tarball. Exclusions remove queryable derived records/cache on refresh; this is **not secure erasure** of filesystem blocks, WAL files, backups or canonical snapshots.

The npm package contains code/dependencies, not downloaded weights or private indexes. No database service, extra account, GPU package or user-selected search backend is required. Extension/model/runtime failures are visible; there is no alternate provider or keyword-only fallback.

## Checks

Ordinary tests use synthetic records and deterministic or empty embedding fixtures, with real FTS5/vector tests. They do not download/run the real model. Browser fixtures exercise automatic search and source reading without setup controls, plus no capture on navigation. Existing native-only and review-boundary tests remain.

Optional real-model qualification and CPU comparison commands live in [CONTRIBUTING.md](CONTRIBUTING.md#local-model-qualification). Those are isolated test tools, not steps required to use search. Ordinary search/text/call requests prepare the index automatically; there is no separate model setup command for users.

Synthetic retrieval and throughput checks do not establish exhaustive recall, real-provider answer quality or performance on every machine.
