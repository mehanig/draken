# Saved workflow consolidation

Consolidation is explicit preparation, not a Factory page action or a workflow execution. It reconstructs the tasks behind the selected saved workflows, groups procedures with the same supported endpoint, enriches every replacement, and only then activates the replacements together.

## History and source checks

- Original discovery IDs, comparisons, enrichments and execution receipts remain intact. Active-list aliases connect old deep links to their replacements; direct original reads still return the original records.
- Draft replacements stay hidden. The original list remains active until the whole batch succeeds.
- Batch receipts bind the selected source revisions, reconstructed task revisions, model output and grouping. Reads verify every dependency, including unselected context. A revoked or changed dependency can withhold the entire batch.
- One reconstructed task is labelled “Derived from one task”. Multiple IDs alone do not establish independent examples. Without a recorded distinction, the label is “Recurrence unconfirmed”.
- Changing versions, branches and commits belong in run inputs rather than fixed reusable instructions. Different endpoints—such as publishing a release versus verifying one already published—stay separate. Explanations and rejected suggestions do not become implementation instructions.

## Conflicting task assignments

Original records accompanying a process fragment may contain another task's stopping report or a later discussion. Membership follows the fragment's own goal and stages, not every topic mentioned in that context.

Normal reconstruction stops if a proposed result would split an existing task. It retains the paid response and failure instead of silently changing membership or automatically repeating the call.

An explicitly reviewed partition can correct that assignment. `TASK_REVIEW_PROMPT` and `reviewTaskReconstruction` require every supplied fragment to appear exactly once, with source-supported boundaries for each resulting task. The review retains the earlier receipts and all their original dependencies. Its output is saved once; `episode_revisions.assembly_index` selects the relevant task from that output. Earlier revisions remain readable. If an earlier revision now spans multiple tasks, its current identity changes and it cannot establish independent examples.

The background detector does not automatically request or apply these reviews. Applying one is an explicit operator operation, with fresh source checks and the existing preparation owner's invocation allowance. Completed work and failed responses remain in the ledger; reviewing a conflict does not reset the allowance.

## Publishing prepared data

Prepare on a private database copy first. Before a live import, confirm server shutdown and resource ownership, take a backup, and recheck the current source revisions. Import only the new preparation records and task-state changes in one transaction; do not replace the production database or overwrite old records. Verify all replacement enrichments before committing. Restart and check the actual API and UI, including old links, without executing workflows.

Controlled tests cover partition validation, historical revision reads, changed and unselected dependencies, activation, old IDs and read-only navigation. Provider-backed history preparation is a separate check and must be reported separately from those tests.
