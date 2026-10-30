# Draken sync prototype — next work

## Implemented: full-snapshot hierarchical briefing

The first raw-evidence prototype cut off snapshots at 100 entries / 80,000 characters. That made it possible to brief an early plan while missing its later completion. **That cutoff is removed.** Users should not have to finish dozens of artificial sync batches to learn the current state.

The current pipeline is:

1. Freeze all eligible indexed evidence from the selected sources/history baseline.
2. Use an explicitly selected cheaper model for chronological session chunks.
3. Reconcile session outcomes hierarchically, group related observations across sessions, and merge workstreams.
4. Cache structured results by source content, model, prompt/version, and node type.
5. Give the final model bounded summaries and verification excerpts, plus previous decisions and recent discussion.
6. Retrieve raw evidence for questions using lexical matches or explicit citation IDs.
7. Require every snapshot entry to pass through successful compression and a valid final reply before completing a sync whose model run has started. Only the user's explicit completion advances coverage.

The UI exposes model choices, consent, progress, node inspection, failures, cancellation, cache reuse, and a per-run invocation ceiling. Legacy partial snapshots can be explicitly expanded without losing their notes, discussion, or historical citations. Unchanged scans make no model calls; unchanged tree inputs reuse cached nodes. Work arriving during a full snapshot remains pending for the next sync.

**Important limits:** a processed entry is not proof that all its facts survived lossy compression. Valid source references do not establish semantic support for every claim. Invocation counts are not token/dollar accounting. There is no background inference, semantic search, or durable incremental project-state rollup yet.

## Next priority: measure and improve briefing quality

- Compare full-history tree results against raw-evidence baselines on synthetic and explicitly approved local samples.
- Measure missed decisions/blockers, stale next steps, false completion claims, cost, and latency. Test stronger conflicting evidence, repeated reversals, multiple workstreams in one workspace, and task continuations split across chunks.
- Extend the current synthetic regressions (1,305-entry tail-outcome reconciliation; snapshots beyond 2,000 entries; caching, budgets, schema/source validation, cancellation, legacy expansion, and restart recovery).
- Improve semantic reconciliation across routing batches; related topic names can still be split when a large set needs multiple grouping calls.
- Add actual provider usage and estimated prices rather than presenting invocation counts as cost.
- Consider stable rolling chunks and incremental per-project observations, but avoid an endless lossy summary-of-summary chain. Keep source provenance and a rebuild path.
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

Pi's compaction/branch summaries remain useful background, not independent proof of outcomes or a checkpoint of what the user discussed with Draken. Automatic background compression would need a **separate explicit opt-in and budget**; the current no-automatic-provider-calls behavior must not silently change.

## Later

- Voice input/output using the same persisted sync workflow.
- Searchable full sync history, retention/purge controls, and baseline management.
- Optional read-only Git/CI evidence to verify transcript claims.
- Only after briefing quality is established: proposed tasks and separately approved worker execution.

## Explicitly out of scope for this branch

Docker execution, Claude-specific integration, publishing a package, pushing a branch, or opening a PR.
