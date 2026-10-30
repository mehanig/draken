# Draken sync prototype — next work

## Next priority: large-history briefing without many manual sync batches

Requested during implementation: the volume of session history is the core problem, not an edge case. The initial history window and bounded raw-evidence snapshots are temporary prototype constraints, **not** the intended daily-sync workflow.

### Investigate before choosing a solution

Compare current community implementations of coding-session memory/aggregation, hierarchical (map/reduce) summarization, incremental observation stores, and retrieval-assisted briefing. Pi's compaction/branch summaries are useful existing inputs, but are neither verified outcomes nor a checkpoint of what the user has discussed with Draken. No external community implementation has been evaluated for this branch yet.

Evaluation questions:

- Does it summarize only new activity, or repeatedly process the whole transcript?
- Does it preserve source IDs and distinguish reported success from observed results?
- Does it handle forks, compaction, context edits, late discovery, and partial writes?
- Can it keep secrets and irrelevant tool/file output out of model inputs?
- Does it bound cost and latency without silently dropping developments?
- Are summaries cached/versioned and recoverable after failure/restart?
- Can the user inspect original evidence and correct an inaccurate summary?

### Likely approach to prototype

1. Deterministically filter noise and extract useful evidence before paying for inference.
2. Use a configurable **cheap model** to summarize new evidence chunks per session/workstream into structured observations: request, attempted work, reported changes, validation, blockers, unresolved questions, and evidence IDs.
3. Cache observations by source entry range/content fingerprint, model, and summarizer-prompt version. Summarizing/indexing must remain separate from user sync coverage.
4. Consolidate incremental observations into per-session/project state, explicitly preserving uncertainties and superseded conclusions. Avoid an endless lossy summary-of-summary chain; retain source provenance and rebuild when needed.
5. Let the sync model consume those observations across projects, plus the previous sync's decisions and open items.
6. Retrieve raw evidence on demand for questions or verification. Treat summaries and logs as untrusted data, never agent instructions.
7. Advance coverage only after a completed user sync and only for evidence demonstrably represented by its processed observations. Failed/omitted chunks must be visible and remain pending.

Pi compaction summaries may provide inexpensive background for step 4, but cannot stand in for a source-linked activity delta.

### Acceptance criteria

- A day's large multi-session history produces **one coherent sync**, rather than requiring the user to finish many 100-entry batches.
- Repeat scans and unchanged sessions cause no repeat summarization charges.
- New work arriving during a sync remains eligible for the next one.
- Work from an abandoned branch is not announced as the current outcome.
- Every substantive claim has inspectable evidence; no verification claims are invented by the cheap model.
- The UI exposes processing progress, approximate cost/usage, failures, and coverage gaps.
- Compare against raw-evidence baselines on synthetic and explicitly approved local samples for missed decisions/blockers, false completion claims, cost, and latency.
- Background model use requires a separate explicit opt-in and budget; the current no-automatic-provider-calls behavior must not silently change.

## Later

- Voice input/output using the same persisted sync workflow.
- Better project/workstream grouping when sessions start at a common parent directory.
- Searchable full sync history, retention/purge controls, and baseline management.
- Optional read-only Git/CI evidence to verify transcript claims.
- Only after briefing quality is established: proposed tasks and separately approved worker execution.

## Explicitly out of scope for this branch

Docker execution, Claude-specific integration, publishing a package, pushing a branch, or opening a PR.
