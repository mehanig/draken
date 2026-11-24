# Reusable workflow correction: implementation and qualification

## Observed problem

The read-only review of nine saved workflows on 2026-11-24 found two new definitions that fixed the behavior of preparation after reconstruction/comparison failures. Both had no run inputs. They described the feature being implemented, not a procedure usable for another feature.

The two discoveries, `4455e1f01922…` and `13b4578533f4…`, came from the same task pair: `17a55ea…` at revisions 3 and 4 respectively, compared with `2bd004f…` revision 1. Each positive comparison was promoted to another workflow.

Other entries are not uniformly wrong. Release publication, independent release verification, prepared-change PR creation and behavior-preserving comment cleanup have useful distinct methods/endpoints. The UI submission entry carries a one-task exclusion of workflow-discovery work. Two entries describe particular discussions rather than implementation. Do not rename all of these into a generic feature workflow or claim discussions prove implementation.

## Changes

- Extraction, candidate selection, matching, requested discovery and consolidation now distinguish historical feature goals from reusable engineering procedures. Keep meaningful techniques and endpoints; avoid an empty edit/test/commit template.
- Enrichment declares desired behavior and acceptance criteria where the workflow varies by run. Existing concrete input validation and the single-session executor remain unchanged.
- Comparison can return `reuse` with a supplied saved workflow ID and its unchanged definition. Unknown IDs, rewritten definitions and reuse for a shared subprocedure are rejected. A new definition uses `reuse:null`; the field is optional when reading legacy receipts.
- Preparation supplies at most 24 saved definitions from the same location, without adding a separate model call. These definitions are identity candidates, not new historical evidence or authorization. Current comparison sources still undergo original-byte, permission and cancellation checks. Candidate definitions are checked again before and after inference.
- A reuse decision stays in the immutable comparison receipt. It does not create another discovery, enrichment or execution identity. Existing workflows and their guidance are not overwritten. The startup backfill also excludes reuse receipts.
- Comparison and enrichment recipe hashes from 0.15.2 remain accepted. Changing prompts alone does not invalidate old receipts or automatically regenerate their enrichment.

This does not automatically consolidate the nine existing workflows, update their displayed examples, or guarantee semantic deduplication: the model must recognize the existing method and endpoint. Catalog candidates outside the 24 supplied definitions cannot be reused by that comparison.

## Qualification

Contract/integration tests cover cross-feature run inputs, distinct endpoints, invalid reuse, changed definitions during inference, revised-example reuse, no repeated enrichment, retained accounting, startup backfill, and legacy receipt compatibility. These are synthetic tests, not proof of model generalization. After the model-routing and usage-filter changes, the full suite passed **897 tests**, typechecks and Knip passed, and the full browser suite passed **81 tests**. Application callers were checked for the added helpers; no unused-code exclusions were added.

A separate real-model evaluation used an isolated database copy and the normal accounted model callback, with a fixed five-call allowance. The original preparation-failure proposal was read through the fresh-source proposal reader before and after inference. Live discoveries and settings were not changed.

- Model: `openai/gpt-6-astra`.
- Calls: **5/5**, complete accounting, **$0.32013**.
- Receipt directory: `/home/mehanig/.draken/workflow-pilot/reusable-v5-20261124`.
- Evaluation run: 467 **in the isolated copy**, not a live preparation run.

| Case | Observed result |
| --- | --- |
| Real saved preparation-failure pair | **Generalization failed.** The model reused the old feature-specific definition |
| Synthetic filtering versus sorting features | Correctly recognized the shared browser-regression/local-preview procedure |
| Synthetic local preview versus PR delivery | Correctly kept overall workflows separate, identifying only a shared subprocedure |
| Reuse of a supplied definition | Correctly returned the supplied ID unchanged; this tested identity mechanics, not whether that definition was general enough |
| Enrichment of the first result | Produced run inputs, but they still required reconstruction/comparison failure handling; not sufficient feature reuse |

After inspecting these results, the prompt was tightened to distinguish *the product behavior being built* from *the engineering method used to build it*, and to derive the reusable procedure before considering old definitions for reuse.

## Authorized two-call follow-up

The owner approved two additional accounted calls. The same isolated run 467 was continued with its allowance raised from five to seven, preserving all five previous metrics and responses. No automatic retry or new spending ledger was used.

- Additional calls: **2**, **$0.20606**; complete accounting.
- Total: **7/7 calls**, **$0.52619**.
- Receipts: `06-refined-historical-generalization.json`, `07-refined-enrichment.json`, and `followup-result.json` in the same directory.

The real-history generalization now produced:

> Implement and validate a requested Draken change, preserve existing application data, and verify its local deployment.

Its procedure covers inspection, implementation against supplied acceptance criteria, validation, data preservation, local restart/runtime verification and reporting. It explicitly keeps local deployment separate from PR creation or package publication. It returned `reuse:null`, explaining that the two existing definitions incorrectly fixed the historical product behavior. Missing initiating requests, reported results and uncertainty about task continuity remain limitations; this evaluation does not establish historical recurrence or successful execution of a new feature.

Enrichment declared four required inputs: `desired_behavior`, `affected_scope`, `acceptance_criteria`, and `data_preservation_expectations`. Unlike the first attempt, these do not require reconstruction/comparison failure handling.

A subsequent check used the actual generated enrichment to construct two run plans: workflow-list filtering and remembering the selected history view. Both accepted different inputs with identical workflow and enrichment objects. This made **zero model calls** and executed neither task. The receipt is `followup-run-input-check.json`.

## Remaining scope

This establishes improved generalization and usable run inputs for this real saved example on **Astra**, not all nine workflows or actual feature execution. The owner subsequently approved aligning automatic preparation with the evaluated final model. The implementation now routes reconstruction, candidate selection, matching and enrichment through the configured final model, while summaries retain the summary model. The separate reconstruction callback override was removed. Integration tests check routing, shared invocation accounting, cancellation/limits and the absence of a hardcoded provider. This closes the code-level routing difference; it is not a claim that the live server has been restarted or a new feature executed. Changing the model does not automatically replay a failed workflow task: failures remain skipped until explicitly retried, and old attempts retain their receipts and spending.

Settings now filters request costs and counts by recorded model and operation. Unknown historical metadata remains explicitly unknown; run-level briefing and attempt counts stay unfiltered and labelled separately. A read-only check of the real 14-day ledger covered 1,294 calls, two models and eleven operations: model-filtered costs and call counts, and operation-filtered call counts, summed to the unfiltered totals. It made no provider calls. Browser tests cover combined filters, empty results, incomplete pricing, late responses, failed refreshes and narrow layouts. The new client was built into a temporary test directory rather than replacing the running server's public assets.

No live definitions were replaced, no server was restarted, and no PR, merge or release was made. Applying replacements still requires explicit preparation with fresh source checks, preserved old IDs/revisions/receipts, and review of the remaining workflows.
