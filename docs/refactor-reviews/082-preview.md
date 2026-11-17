# 0.8.2 — processing estimates on Home

Status: release candidate; final backend review and integrated qualification pending. Not a publication or deployment claim.

## Product contract

- Home's primary numbers describe unique indexed entries needing new leaf summaries versus entries covered by compatible cached leaves, not the unreviewed backlog, provider requests or a bill.
- Available, reserved and reviewed membership totals remain under collapsed Details. No entries are silently omitted or marked reviewed.
- Reconciliation and the final briefing can require inference even with zero pending leaf entries.
- Counts use the actual batch/conservative planner, complete input receipts and verified originals. Prior inclusion, citation counts and receipt membership alone are insufficient.
- Unknown, stale, paused and failed verification have null counts. Ready results carry their physical verification time and describe indexed inputs, not future arrivals or guaranteed cost. Large histories can take a minute or more to check; starting a sync does not require waiting for the estimate.
- Home requests a separate local-only check via POST. Status GETs never start reconstruction. The check invokes neither providers nor embeddings and creates no sync, run, briefing, notes or review, nor grants paid consent.
- One identity-bound owner coalesces checks and drains for foreground work and shutdown. Existing paid preparation, native ownership, source consent, original verification and frozen/adopted evidence policies remain intact.

## Design decisions

1. **Separate membership from processing.** Review totals cannot predict inference demand. Expose planner-derived coverage instead of relabelling the old available count.
2. **Share the planner.** Count unique primary coverage in the same leaf selection and packing path used for actual preparation. Background dependencies and overlapping occurrences do not inflate counts.
3. **Keep the server responsive and its writer exclusive.** The owner drains indexing/native retirement, creates a private asynchronous SQLite backup, and runs provider-forbidden planning and original verification in a worker over that backup. The worker never writes the canonical database. Private directories are 0700 and files 0600.
4. **Retain only legitimate planner metadata.** Worker writes outside four planner tables are forbidden. After actual worker exit, the parent checks source/artifact revisions, models, roots, SQLite data_version and reservation deadlines under an immediate transaction. It atomically imports changed leaf receipts, leaf plans, pending plans and replay attempts, never existing outputs, source rows, history, settings or accounting. Cleanup remains owned, and freshness is checked again after it.
5. **Treat preview as an estimate, never inference authority.** Counts use the worker's verification timestamp with bounded expiration. Actual preparation retains fresh original and consent gates. A count cannot authorize paid work or promote an adopted dependency into initial captured context.
6. **Keep status lightweight.** Temporary revision tracking and expiration invalidate estimates without corpus reads. Paused status becomes stale when admission is possible, allowing the client to recover without a POST restart loop. Failures stay sticky for unchanged inputs but are discarded after a new client input generation.

## Independent review

- Initial independent review reproduced paused-check liveness, a failure surviving a source-generation change, and missing historical-background-provenance invalidation. These were fixed; historical sync-run metadata is also tracked. Irrelevant progress bookkeeping and unchanged rescans do not revoke a ready estimate.
- Final UI-only review reported no actionable findings against checksum-matched client sources. It independently passed 40 browser tests, including 11 new challenges, plus client typecheck/build. It covered late results, prolonged pauses, source changes, failed changes, Start/unmount, null versus zero, collapsed review totals and no automatic paid work/capture.
- Final backend/private-clone review remains pending at this checkpoint. Implementer reports are not independent approval.

## Qualification checkpoints

- Parent final-source build, **692 unit tests**, type/unused checks and whitespace checks passed.
- Parent integrated UI run: **73/74 passed**, with one five-second synthetic briefing-preparation timeout still under investigation. No assertion has been waived or timeout extended.
- An earlier isolated-copy attempt omitted `client/public` assets and caused three persona/audio failures. Correcting the copy restored those checks; this was a harness mistake, not a production-source fix.
- Browser/site, production package/audit and final integrated gates remain pending.

### Provider-forbidden private-copy audits

Only private backups were modified. Original logs were read, never changed; no private source contents were logged. Existing user data, accounting, preferences and cached outputs were fingerprinted before and after.

- Initial same-thread implementation: correct counts but **113,559 ms** cold time and a **33,041 ms** maximum 100 ms timer interval. This blocked release and prompted the owned worker design.
- Final worker implementation, checked copy: **25,797 eligible indexed entries; 23,527 cached; 2,270 needing new leaf processing**.
- Cold: **97,268 ms**, largest 100 ms timer interval **116 ms**, one archive pass and 134 packing passes.
- Warm/reopen: **76,769 ms**, largest 100 ms timer interval **113 ms**, zero archive passes and one packing pass.
- Both worker runs: **zero provider calls**, unchanged durable user data and existing cached outputs. These are verified estimates for those copies, not a promise about later inputs or instantaneous preparation.

## Release gates still required

- Final independent backend review and resolution of any worthwhile findings.
- Clean full integrated UI, browser/site, production package/audit and dependency-cycle qualification.
- PR CI before merge; qualified npm publication before the matching-version website deployment.
- Separately backed-up local upgrade, preserving histories, notes, outputs, vector bytes, settings, cancelled work and paid-background opt-out.

Real-provider answer quality, real embedding-weight inference and physical-device audio acceptance are not established by these synthetic tests or provider-forbidden audits.
