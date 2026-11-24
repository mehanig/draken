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

Contract/integration tests cover cross-feature run inputs, distinct endpoints, invalid reuse, changed definitions during inference, revised-example reuse, no repeated enrichment, retained accounting, startup backfill, and legacy receipt compatibility. These are synthetic tests, not proof of model generalization. The full suite passed **892 tests**, typechecks and Knip passed, and **19 Factory/navigation/settings/preparation browser tests** passed. Application callers were checked for the added helpers; no unused-code exclusions were added.

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

After inspecting these results, the prompt was tightened to distinguish *the product behavior being built* from *the engineering method used to build it*, and to derive the reusable procedure before considering old definitions for reuse. That refinement has **not** received another real-model evaluation. The five-call allowance was not increased or reset. Do not present this change as qualified for rewriting the live workflow list.

## Next qualification

With an explicitly authorized additional evaluation allowance, rerun the real-history generalization and enrichment cases using the refined prompt. Require a procedure usable for a different requested behavior, with acceptance criteria supplied per run—not simply the old feature rewritten as an input description. Preserve historical facts, meaningful applicability and delivery scope. If that fails, investigate the supplied task representation before adding more prompt wording or another model stage.
