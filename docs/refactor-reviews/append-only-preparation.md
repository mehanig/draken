# Append-only preparation

## Contract

Session records are append-only. Reuse completed leaf receipts and current-state roots rather than repeatedly reopening their original dependencies or reconstructing their prompts. New inputs need new leaf summaries; small tails can accompany existing roots directly in the final briefing input. When a final merge is necessary, produce the current-state input directly instead of generating a broad overview and then immediately compacting it again.

Keep cancellation, invocation accounting, explicit review, agent/session opt-outs, distinct physical pointers, citation validation and selected-original reads. Do not restart cancelled foreground work or reset paid allowances. Historical leaves and broad parents remain cached; a selective current-state root does not replace that history.

Snapshot capture passes its already-read evidence to preparation. Reference aliases preserve their pointers and do not change the original E/C labels. Summary boundaries check source consent, not every original byte again. Rewrites during an in-flight cached build are outside the append-only contract; selected citation and retrieval reads still verify bytes.

Initial history admission adopts the latest compatible completed background receipt. It does not force a full foreground index refresh. New snapshot entries appear in the briefing immediately and become archive-searchable after the next completed index pass. Explicit **Refresh history** still performs a refresh; when no prepared receipt exists, initial preparation still indexes history.

## Measurements

Baseline: 0.8.8 (`0c4f2ae`). Experiments used database copies with original session files read-only. No benchmark sync was created in the live database. Provider requests were capped at four per real-model experiment; completed paid cache was retained between isolated passes.

### Same frozen cached input, synthetic final response

The original 27,748-entry input reused 390 cached results:

| Version | Total preparation | Tree build |
| --- | ---: | ---: |
| 0.8.8 | 265.47 s | 211.64 s |
| Initial append-only implementation | 20.61 s | 7.39 s |
| Final implementation | **15.42 s** | **9.11 s** |

This isolates local preparation but does **not** establish real-model opening time or answer quality.

### Real-model opening with an appended tail

Measured 2026-11-18 on the isolated HTTP application, from `POST /api/syncs/start-chat` to chat readiness:

| Measurement | Result |
| --- | ---: |
| Eligible entries | 28,065 |
| Cached results reused | 400 |
| Newly summarized tail | 44 entries |
| HTTP acceptance | 12.32 s |
| Local tree work, excluding provider timings | **11.06 s** |
| Fresh prior-conversation recap | 3.97 s |
| New-tail summary | 8.62 s |
| Final briefing | 17.19 s |
| End-to-end chat readiness | **54.27 s** |

Three provider calls; no replacement overview calls. The new recap was deliberately uncached while existing older recaps and summary work were preserved. Summary/recap used the configured Luna model; final briefing used Astra. An earlier successful run with the new recap already cached reached readiness in 57.33 seconds with 10.91 seconds of local tree work.

An earlier bounded experiment exposed the compact-root reuse prohibition: adding entries selected a 165-reference broad root instead of its completed compact descendant, causing two overview calls totaling 79.06 seconds. The experiment stopped before a fifth provider request. The implementation now preserves the compact root across appends and prefers it over the broad representation of the same covered leaves.

The measured case meets the requested 60-second opening and 10–15-second local-tree targets. These are observations, not a universal deadline guarantee: provider latency, cold embedding setup, a large unprepared backlog, and required compaction can still exceed them. Browser rendering and native voice connection establishment were not part of the HTTP readiness measurement. No real-model quality claim follows from these timings.

## Regression coverage

- Cached planning, node consumption and final boundaries do not reopen originals already captured for the run.
- A newly captured snapshot is handed to generation without another full evidence read.
- Appends retain completed compact roots and summarize only the uncovered tail; a fitting forest does not trigger an overview.
- Explicit source opt-outs still revoke cached work, including after queued cancellation boundaries, retries and database reopen.
- Physical aliases retain their pointers and E/C representatives; citation/excerpt and original-storage tests remain active.
- Invocation ceilings, final-slot reservation, bounded repair, cancellation and review controls remain active.
- Initial admission reuses prepared history; explicit refresh remains cancellable and actually refreshes.

Qualification passed: **617 unit tests, 59 Playwright UI tests, and 23 browser/site/realtime tests**; server/client build, typecheck and unused-code checks; production-only package smoke and a zero-finding production dependency audit. Browser chat fixtures explicitly refresh their newly added test project because the shared fixture opts out of background indexing; that refresh is not part of the measured opening path.

Tests that required repeated whole-history damage checks or mandatory overview calls were replaced with the append-only contract. The smaller test count is intentional, not evidence of additional test passes.
