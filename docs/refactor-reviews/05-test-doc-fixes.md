## Result

**NO WORTHWHILE FINDINGS REMAIN** in the assigned fixes-review scope. Both fourth-round test/docs findings are resolved in the current files.

### 1. Subprocess completion is now enforced

In `tests/native-ownership.test.cjs`, **“unconfirmed native cleanup retains the call lease and refuses replacement calls”**:

- The final assertion checks that server-wide shutdown retains the unconfirmed call lease.
- The asynchronous `finally` then **awaits** `live.stopLiveCalls().catch(() => {})` and closes the database.
- Only the subsequent `.then()` can print `UNCONFIRMED_OWNERSHIP_CHECKED`, and it suppresses that marker after an assertion failure sets `process.exitCode`.
- The parent requires **both exit status zero and the exact marker**.

Thus, a child exiting while either awaited shutdown remains pending cannot pass merely because Node exits zero. The expected cleanup rejection is deliberately swallowed in `finally`; that does not bypass awaiting its settlement.

The test preserves real helper cleanup before simulating unconfirmed exit, replacement-call refusal, `cleanup_pending` status, shutdown rejection and retained ownership.

**Mutation evidence:** You report that replacing compiled `stopLiveCalls` with a never-settling Promise made the test fail for the absent marker, and that the mutation was restored. This supports the inspected completion ordering; **I did not execute or independently verify that mutation or restoration.**

### 2. Persistence and resumption summaries agree with behavior

`ARCHITECTURE.md` and `docs/architecture.html` now consistently describe:

- Frozen membership, attribution and verified source pointers—not stored source excerpts.
- Reconstruction from original files, with explicit unavailability rather than copied-text fallback.
- Persistence of conversations, notes, reference identities and reusable summaries despite source loss.
- No automatic restart of calls or foreground preparation.
- Enabled automatic preparation potentially resuming its owned unfinished batches, while provider failures remain paused until explicit retry.

These statements match the focused source checks:

- `EvidenceReader.encodeEvidence()` excludes text; reads require verified pointers.
- `EntryReader` reconstructs live projections from originals.
- Server startup performs recovery before starting background indexing.
- `AutoIndexer.run()` admits unfinished batches independently of the new-work threshold.
- Automatic preparation retains durable ownership information and distinguishes cancellation/interruption from its saved failure pause.

The visual restart summary links to the canonical preparation policy. The remaining explicit-retry branch in the Markdown click-flow is appropriately scoped to the foreground **“Sync with Draken”** journey, not presented as a blanket prohibition on automatic resumption.

### Retained exceptions

No further test/comment cleanup or abstraction is warranted here:

- Unix process-group handling, Windows-specific treatment and the Linux orphan-zombie qualification represent real platform constraints.
- The subprocess-local prototype override isolates simulated unconfirmed cleanup without replacing real cleanup.
- Its local success marker is sufficient; a shared subprocess framework would add unnecessary machinery.
- Historical normalization, original-source unavailability, provider-failure pauses and fresh microphone intent remain meaningful compatibility, safety and consent boundaries.

## Completed coverage and limitations

**Read completely, with bounded reads continued through EOF:**

- `/tmp/draken-review-instructions.md`
- `/tmp/draken-independent-review/04-tests.txt`
- `docs/refactor-decisions.md`
- `tests/native-ownership.test.cjs` — all three tests and teardown
- `ARCHITECTURE.md`
- `docs/architecture.html` — including styles, all sections and footer
- Focused supporting files: `src/sync/background.ts`, `src/sync/automatic.ts`, `src/db/evidence.ts`, `src/sync/source-files.ts`

**Selective source verification:** startup ordering in `src/server.ts`; cleanup/status/sweeper behavior in `src/voice/live.ts`; automatic snapshot eligibility and restart recovery in `src/sync/store.ts`.

I did not re-review the unchanged tests, fixtures, UI or site already certified by report 04, or the exact test-file complements assigned to the other reviewers. Terminal-host ownership fixes are excluded and require their separately planned fresh review.

This was read-only inspection. No tests, builds, browser checks, provider/device qualifications, mutations or Git checks were executed; generated output and private runtime data were not read. This clears the two assigned findings, not the independently outstanding review scopes.

**NO WORTHWHILE FINDINGS REMAIN IN REVIEWED SCOPE.**
