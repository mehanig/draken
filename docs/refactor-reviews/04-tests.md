## Gate status: **not cleared**

Two worthwhile findings remain. The third-round repairs are present, but **I have not completely closed the earlier truncated-read coverage gap for all top-level tests**, so this is not an exhaustive final clearance.

This review used only read/grep/find/ls. No files were modified and no tests, builds or mutations were executed.

## Confirmed findings

### 1. Another native-ownership subprocess can exit successfully before its final assertions

**Location:** `tests/native-ownership.test.cjs:83–112`, test **“unconfirmed native cleanup retains the call lease and refuses replacement calls.”**

The parent checks only `result.status === 0`. Unlike the repaired activity test and terminal-admission subprocess, this child has no required completion marker.

The fixture deliberately performs real native cleanup before substituting `{ helperExited: false }`. Subsequently it awaits `live.stopLiveCalls()` and checks that the call lease remains held. Once native resources are closed, the remaining call sweeper does not keep Node alive: `src/voice/live.ts:247` explicitly unrefs it.

Consequently, a regression that leaves `stopLiveCalls()` pending after native cleanup can let the child exit zero without reaching the final lease assertion or completing its asynchronous `finally`. The parent’s 15-second timeout does not catch a child that has already exited successfully.

This is a **source-established false-pass path**, not an executed mutation result.

**Change-together rationale:** The test implicitly depends on unrelated production resources keeping the event loop alive until its assertions finish—the same coupling removed from the activity test.

**Minimal redesign:** Require a unique success marker emitted only after the assertions and awaited cleanup finish, as well as exit status zero. Keep this local to the subprocess; no generic test framework is needed.

**Preserve:** Real helper setup/cleanup, simulated unconfirmed exit, replacement-call refusal, cleanup-pending status, shutdown rejection and retained call ownership.

**Establish:** A mutation that leaves the terminal cleanup Promise unresolved after native resources close must fail because the marker is absent. The unmodified case must produce the marker and exit zero.

### 2. Architecture documentation still contains residual persistence and automatic-resumption contradictions

**Locations:**

- `ARCHITECTURE.md:74,103`: “Copy all currently available entries” and, more explicitly, “Stored evidence is a bounded text excerpt.”
- `ARCHITECTURE.md:267–269`: restart explanation presents explicit retry/fresh control as the general rule for interrupted model work.
- `docs/architecture.html:217,221`: “the user must retry” and the explanation that restart should not quietly spend model usage.

The first wording conflicts with the same document’s pointer-only storage contract and current `EvidenceReader`/`EntryReader`: source excerpts are reconstructed, not stored as snapshot text.

The restart wording omits the existing automatic-preparation exception. `src/server.ts` starts the background scheduler after recovery. `src/sync/background.ts`, `AutoIndexer.run()`, admits unfinished owned batches independently of the new-work threshold; `src/sync/automatic.ts` explicitly distinguishes resumable interrupted/cancelled work from provider failures requiring explicit retry.

The visual guide now correctly describes enabled automatic preparation elsewhere, making its blanket restart statement internally inconsistent.

**Change-together rationale:** Persistence and scheduling policies are described independently in several introductory diagrams and explanations. Updating their detailed sections has left contradictory summaries behind.

**Minimal redesign:**

- Replace “copy”/“stored excerpt” wording with frozen membership, attribution and verified reconstruction pointers.
- Qualify restart behavior: calls and foreground work do not automatically restart; enabled automatic preparation may resume owned unfinished batches, while provider failures require explicit retry.
- Link the visual summary to the canonical policy instead of adding another detailed specification.

**Preserve:** No copied-text fallback, original-file unavailability, saved conversations/notes/reference identities, no automatic microphone capture or review, durable cached-work reuse, consent boundaries and provider-failure pauses.

**Establish:** Existing behavioral authorities are sufficient:
- `tests/evidence-boundary.test.cjs`
- pointer/source-loss tests in `tests/storage.test.cjs`
- cancellation/restart and provider-failure tests in `tests/automatic-briefing.test.cjs`
- scheduler/default tests in `tests/automatic-index.test.cjs` and `tests/automatic-defaults.test.cjs`

Do not add brittle exact-prose tests for these edits.

## Confirmed third-round repairs

These were independently checked in source, rather than accepted solely from the decision log:

- **Activity drainage:** `tests/activity.test.cjs` iterates job/start/call/background leases, checks closed admission, checks that shutdown remains pending before release, and requires the corresponding `DRAINED-…` marker afterward. `SyncActivity.changed()` includes all four categories.
- **History/model shutdown gate:** The owner fixture intercepts SIGKILL delivery and releases pending kills only after contender rejection. It retains real synthetic children, exit/PID checks and replacement startup.
- **Disconnected native status:** The test starts a real ignoring version child, destroys the HTTP request, waits for an explicit terminal-cleanup gate, checks directory exclusion, releases cleanup, verifies child disappearance and starts a replacement.
- **Native preflight/admission:** Close/abort cases use real version children and confirmed exit checks. The isolated terminal-admission subprocess requires `CHECKS_STOPPED`.
- **Production timing:** `NativeHelperProcess` currently retains 1,500-ms escalation and bounded exit confirmation. I found no test-driven delay extension in the inspected implementation; without a diff, I cannot independently establish its historical unchangedness.
- **Visual guide:** Pointer-backed evidence, source unavailability, prepared-history voice, context transfer versus handoff receipts, automatic preparation and kernel-backed ownership are now described. Finding 2 concerns residual summaries, not rejection of those corrections.
- **Historical search fixture:** Fixed bodies, offsets, hashes and vector bytes are independent of live passage generation. The storage test forces reuse through new frozen aliases, checks prepared-only reads and zero writes, and verifies changed-source/exclusion behavior.

The reported mutation failures, rebuilt passes and suite totals remain **reported results**, not results I independently executed.

## Retained requirements

Keep the meaningful architectural/privacy regressions and their explanatory comments:

- Verified-original positive controls and refusal of inline-only current-schema evidence.
- Migration rollback and independently frozen historical compatibility fixtures.
- Real process/group ownership, suspended-owner exclusion and conservative unconfirmed-cleanup behavior.
- Source identity, pagination cancellation and dialog-lifetime tests—including selecting another source while call shutdown is held.
- Inference isolation, provider/environment boundaries, release checks and static-site privacy tests.

Historical normalization recipes, platform-specific termination protocols and provider-event ordering guards are not removable duplication merely because they resemble one another. I found no additional narration-only comment deletion worth recommending.

## Coverage and limitations

### Recovered and read completely, without remaining truncated output

- `docs/refactor-decisions.md`
- `docs/refactor-reviews/03-tests.md`
- `ARCHITECTURE.md`, `TRAY.md`, `docs/architecture.html`
- All **11** `tests/fixtures/*.cjs`
- All **15** files under `tests/ui`
- All site text: `site/index.html`, `site/site.css`, `site/site.js`
- Visually inspected all three `site/img/` images
- These top-level tests:
  - `activity.test.cjs`
  - `automatic-briefing.test.cjs`
  - `automatic-defaults.test.cjs`
  - `automatic-index.test.cjs`
  - `browser-foundations.test.cjs`
  - `embedding-pool.test.cjs`
  - `evidence-boundary.test.cjs`
  - `http.test.cjs`
  - `model-assets.test.cjs`
  - `native-ownership.test.cjs`
  - `server-ownership.test.cjs`
  - `site-browser.cjs`
  - `site-release.test.cjs`
  - `storage.test.cjs`

Complete focused production reads included activity, server shutdown, native helper/RPC/preflight ownership, automatic scheduling/preparation, and live evidence readers. Comment searches also covered sync, memory, database, routes, sources, pi runtime, tray and client modules.

### Still incomplete

All top-level tests were inventoried and received initial inspection, but **the remaining `tests/*.cjs` files are not certified as completely read**. Earlier truncated output was not fully recovered for that complement, including substantial suites such as tree, sync, memory, reconciliation and standalone qualification scripts. Requested read ranges alone do not establish coverage.

There was no Git diff/status through the permitted tools, so I cannot prove tracked/untracked classification, identify every changed production comment, or date the documentation inconsistencies. Current newly present files were included in the filesystem inventory.

No credentials, private logs, `.env`, dependencies, generated `dist/public`, test artifacts or real session stores were read. The audio fixture was not inspected. No runtime, provider, device or platform qualification was performed.

**The required exhaustive gate therefore remains open independently of the two findings above.**

CONFIRMED FINDINGS REMAIN
