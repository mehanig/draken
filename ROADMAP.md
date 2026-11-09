# Draken sync prototype — next work

## Implemented: conversation-first home and independent syncs

**Sync with Draken** scans new available activity, creates an idempotent frozen snapshot, prepares it and opens a call from the initiating browser action. Compact history cards link to independent `/syncs/:id` detail pages. Included-but-unreviewed evidence is tracked separately from reviewed coverage, so multiple open snapshots do not repeatedly consume the same entries. Discard releases unreviewed entries.

Cached cheap-model recaps carry the three most recent non-discarded syncs into a new discussion. They process all supplied prior briefing/message/note fragments, remain lossy and explicitly not agreement, and never write decisions or coverage. Call UI closure requests a recap; no timer initiates inference. Physical-browser permission/autoplay differences and broader recap fidelity still need evaluation.

## Implemented: full-snapshot hierarchical briefing

The first raw-evidence prototype cut off snapshots at 100 entries / 80,000 characters. That made it possible to brief an early plan while missing its later completion. **That cutoff is removed.** Users should not have to finish dozens of artificial sync batches to learn the current state.

The current pipeline is:

1. Freeze all eligible indexed evidence from the selected sources/history baseline.
2. Use token-budgeted larger chronological batches for the default GPT-6 Luna, preserving all admitted entries and valid old leaf caches.
3. Globally reconcile related work across batches, adding levels only when inputs do not fit. Keep the final model's summaries compact rather than transferring more raw history to Astra. Unknown summary-model overrides retain conservative limits.
4. Cache structured results by source content, model, prompt/version, and node type.
5. Give the final model bounded summaries and verification excerpts, plus previous decisions and recent discussion.
6. Retrieve raw evidence for questions using lexical matches or explicit citation IDs.
7. Require every snapshot entry to pass through successful compression and a valid final reply before completing a sync whose model run has started. Only the user's explicit completion advances coverage.

The home page focuses on starting a conversation and compact history; detail pages retain briefing, notes, evidence, failures, cancellation and cache inspection. Model/budget settings stay server-side: Luna for compression, Astra for the final reply, and 120 invocations per run by default. Generate/Resume/Ask run directly; there is no per-action model permission checkbox. A plain loopback launch also needs no dashboard login; LAN bindings remain authenticated. Legacy partial snapshots can be explicitly expanded without losing their notes, discussion, or historical citations. Unchanged scans make no model calls; unchanged tree inputs reuse cached nodes. Work arriving during a full snapshot remains pending for the next sync.

**Important limits:** a processed entry is not proof that all its facts survived lossy compression. Valid source references do not establish semantic support for every claim. Invocation counts and local tokenizer estimates are not provider token/dollar accounting. Metadata-only call durations are retained, but startup/provider/generation timing is not separated. There is no scheduled/idle inference or durable incremental project-state rollup; automatic hybrid history retrieval is a separate path, not a substitute for full-snapshot processing. Explicit actions run asynchronous preparation and post-call recap jobs.

## Implemented: ChatGPT-only live voice

The earlier local speech prototype has been retired: its engine, installer, browser speech detector and execution routes are removed. Old call records remain inspectable, not executable. There is no second voice option or automatic fallback.

The only voice engine uses the pinned official Codex WebRTC interface and a separate native sign-in to the existing ChatGPT account. One persistent connection carries speech; frozen context and deterministic read-only retrieval avoid per-question pi startup. The main call screen, energy-driven dragon, mute/typing, speaker/headphone controls and conservative ordered transcript storage are integrated. Sources are explicitly supplied context rather than verified output citations; exact played words and agreement are not asserted. No backing coding model, executable tool output, decision writes or coverage advancement are available.

Qualification includes actual subscription audio, synthetic spoken interruption and stop/resume through the main UI, local browser/resource tests, and an isolated actual-snapshot copy. See [the native guide](voice/realtime/README.md). Experimental API stability, quota/idle accounting, physical microphones/speakers/Bluetooth, other browsers and long-session behavior remain open. The remaining voice work is physical-device testing and answer quality, not maintaining another speech engine.

## Next priority: measure and improve briefing quality

- Compare full-history tree results against raw-evidence baselines on synthetic and explicitly approved local samples.
- Measure missed decisions/blockers, stale next steps, false completion claims, cost, and latency. Test stronger conflicting evidence, repeated reversals, multiple workstreams in one workspace, and task continuations split across chunks.
- Extend the current synthetic regressions (1,305-entry tail-outcome reconciliation; snapshots beyond 2,000 entries; caching, budgets, schema/source validation, cancellation, legacy expansion, and restart recovery).
- Evaluate large Luna batches and global reconciliation against the old deeper tree with actual-model known-answer tests, not just fake-provider contract tests or fewer call counts.
- Add actual provider usage and estimated prices rather than presenting invocation counts as cost.
- Qualify append-only closed-batch reuse on broader histories; selection/background changes can still move boundaries. Avoid an endless lossy summary-of-summary chain and keep source provenance and a rebuild path.
- Improve retrieval and correction workflows so users can challenge summaries without discarding their discussions.

## Community-strategy research — still queued

No external community implementation has been evaluated or adopted for this branch yet. Compare coding-session memory/aggregation, hierarchical map/reduce summarization, observation stores, and retrieval-assisted briefing before claiming a preferred implementation.

Evaluation questions:

- Does it process only new activity, or repeatedly summarize entire transcripts?
- Does it distinguish requested, attempted, reported-complete, and observed-validated work?
- Does provenance survive forks, compaction, context edits, late discovery, and partial writes?
- Can it keep secrets and irrelevant tool/file output out of model inputs?
- Does it bound cost/latency without silently dropping developments?
- Are cached summaries versioned and recoverable after failure or restart?
- Can the user inspect originals and correct an inaccurate summary?

Pi's compaction/branch summaries remain useful background, not independent proof of outcomes or a checkpoint of what the user discussed with Draken. Scheduled preparation now shares **one explicit automatic-preparation opt-in** with indexing and uses each snapshot's saved model-call budget. Old local-only permission does not silently authorize paid inference. Browsing and standalone scans still do not start provider summaries; the opted-in server scheduler works independently of browsing. The explicit combined sync action and post-call recap retain their existing behavior.

## Later

- A dedicated settings UI for models and budgets, rather than putting configuration in every sync.
- Searchable full sync history, retention/purge controls, and baseline management.
- Optional read-only Git/CI evidence to verify transcript claims.
- Only after briefing quality is established: proposed tasks and separately approved worker execution.

## Explicitly out of scope for this branch

Docker execution, Claude-specific integration, publishing a package, pushing a branch, or opening a PR.
