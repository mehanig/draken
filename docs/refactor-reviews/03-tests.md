## Result

The four findings in `docs/refactor-reviews/02-tests.md` have been addressed in their named locations. The new evidence tests provide meaningful protection. **Three worthwhile findings remain:** one false-pass path, one timing-coupled ownership test, and stale architecture documentation.

This was read-only inspection of the working-tree files, not a HEAD-only review. No files were changed or tests executed.

## Confirmed findings

### 1. The activity shutdown test can pass without observing shutdown completion

**Location:** `tests/activity.test.cjs:57–68`, “shutdown cancels owners, refuses new work and waits for the final lease release”; contract: `SyncActivity.shutdown()` and lease release in `src/sync/activity.ts`.

The subprocess runs an async IIFE and the parent checks only `child.status === 0`. If releasing the job fails to resolve `shutdown()`, execution stops at `await done`. A pending Promise does not keep Node alive, so this dependency-free child can exit successfully without reaching `assert.equal(finished, true)`.

For example, removing the `this.changed()` call from the job-release closure leaves this test’s completion assertion unreachable without necessarily failing the subprocess. This is a source-level finding, not an executed mutation result.

**Change-together problem:** The test implicitly relies on the production module retaining an event-loop handle while shutdown is pending. That is unrelated to the lease contract and currently absent.

**Minimal redesign:** Print a unique completion marker only after the final assertion, then require that marker as well as exit status zero in the parent. Alternatively, use a referenced failure watchdog cleared only after completion.

**Preserve and establish:** Keep cancellation, closed admission, and “not finished before release” assertions. Verify that suppressing drain notification fails the repaired test. Small additional cases for call, start, and background leases would independently establish that each ownership category participates in draining; the present test only holds a job lease.

### 2. The active-child shutdown test races contender startup against production escalation

**Location:** `tests/server-ownership.test.cjs:48–68`, “server shutdown awaits history and model escalation before allowing another directory owner.”

After sending SIGTERM to the owner, the test launches another Node server and unconditionally expects rejection. The synthetic children ignore SIGTERM, but production escalation kills them after approximately 1.5 seconds. On a sufficiently delayed machine, the contender can reach ownership acquisition after the first server has correctly finished shutting down. It then legitimately starts rather than returning the expected rejection.

**Change-together problem:** The test’s validity depends on Node/server startup speed relative to production shutdown timing. Changing either can break a correct implementation.

**Minimal redesign:** Give this fixture an explicit release gate. Its existing child-process wrappers can hold final kill delivery until the contender has attempted acquisition, then forward the pending kills. Keep the real synthetic processes and real completion checks; do not merely increase the production delay or test timeout.

**Preserve and establish:** Assert rejection while children are deliberately held alive, then release them, await owner exit, verify child PIDs are gone, and start a replacement. Delaying contender startup should no longer change the result. Retain the separate held-HTTPS and unconfirmed-native-shutdown tests.

### 3. The visual architecture guide still describes copied evidence as the live storage contract

**Locations:** `docs/architecture.html:127–132` and `210–222`; linked as the browser-friendly architecture guide by `ARCHITECTURE.md:3`.

The visual guide says that snapshots contain copied evidence, that a snapshot “copies the text,” and that copied history has an independent lifetime. Its storage table and restart explanation repeat that model.

This contradicts `ARCHITECTURE.md:105,263`, current pointer-only readers, and the new evidence regressions. Snapshot membership, conversations and references survive source loss; reconstructable source text does not.

**Change-together problem:** Two documents independently describe the same persistence/privacy contract, and only one was updated. This is especially consequential because the new tests deliberately prohibit live copied-text fallback.

**Minimal redesign:** Replace the copied-evidence explanations with a short pointer-backed contract: frozen membership and projection, verified originals required for excerpts, explicit unavailability after source loss, and preservation of notes/conversations/reference identities. Link detailed storage and ownership policy to `ARCHITECTURE.md` rather than maintaining another full specification.

The guide’s “Why one server?” paragraph at line 87 should likewise distinguish enforced directory ownership from process-local activity, rather than explaining single-server operation only as an architectural assumption.

**Preserve and establish:** Preserve the guide’s static, self-contained, no-live-data properties. Use `tests/evidence-boundary.test.cjs`, source-loss tests in `tests/storage.test.cjs`, and server-ownership tests as the behavioral authorities. No brittle exact-prose assertion is needed.

I cannot establish when these stale passages were introduced; this is a confirmed current documentation inconsistency.

## Verification of the previous findings

- **Independent historical search fixture: fixed.**  
  `tests/fixtures/search-cache.cjs` supplies fixed offsets, bodies, literal hashes and vector bytes rather than extracting them from a live index. It includes a split-surrogate boundary, a removable covered tail, and an essential second Unicode window.

  The test beginning at `tests/storage.test.cjs:162` directly seeds legacy storage. Importantly, newly frozen aliases force current indexing to reuse the historical hashes rather than merely accepting migrated embedded rows. Its embedder rejects passage inference. Ordinary and cold prepared-only searches check vector preservation, scope, zero cache writes, original-file verification and subsequent admission changes. This is substantially stronger than agreement among consumers of the shared recipe.

- **Private index access: fixed.**  
  Searching `tests/` found no `index.current` or `index.model` access. The reconciliation test obtains records through `historySources(db)`. Source-batch failure tests retain and modify their fixture-owned injected embedder.

- **Named ownership documentation and tray comment: fixed.**  
  `ARCHITECTURE.md`, `TRAY.md`, and `src/tray/worker.ts` now distinguish server kernel-backed exclusion from companion heartbeat/discovery. They correctly avoid the previously proposed server heartbeat-takeover policy. The visual-guide drift above remains a separate missed consumer.

- **Orphan site CSS: removed.**  
  No `.app-peek` matches remain in the site HTML/CSS/JS. The functioning source example and FAQ behavior remain; no absence-of-selector test is warranted.

The reported cache-version and stride mutation results, **336 unit tests**, and **6 site-browser tests** were not independently executed here.

## New tests and retained requirements

The new `tests/evidence-boundary.test.cjs` assertions are not vacuous:

- Verified originals provide a positive control before pointer removal.
- Inline-only current-schema evidence is rejected even when matching original text exists.
- Strict and tolerant reading, item/context paths, attribution and reference preservation are checked.
- Reply/call/review guards assert evidence-specific failures and absence of durable side effects.
- Provider invocation is counted and forbidden.
- Explicit notes and existing conversations remain accessible.
- A valid edit cannot substitute for a missing original pointer.
- Citation-heavy fixtures demonstrably depend on their temporary originals.

Retain these tests and the separate migration rollback/compatibility tests. Live-reader simplification is justified by migration ownership, not by abandoning historical compatibility.

Also retain:

- Suspended-owner/process-death and malformed-lock-storage tests.
- Native descendant/process-group confirmation, including conservative zombie handling.
- Source-view identity, cancellation and dialog-lifetime tests.
- Static privacy/product-boundary, inference-isolation and release/package assertions.
- Comments explaining migration recipes, UTF-16 persisted windows, source attribution, private-key handling, provider ordering and platform-specific shutdown.

I found no additional narration-only comment deletion worth recommending. Different process protocols and migration normalization recipes should not be merged merely to reduce apparent duplication.

## Reviewed coverage and limits

**Inspection inventory:** both requested review documents; all enumerated top-level `tests/*.cjs`; all 11 `tests/fixtures/*.cjs`; all 15 files under `tests/ui`; and `site/index.html`, `site/site.js`, `site/site.css`.

Relevant production inspection covered server/directory ownership, activity and shutdown, tray ownership, evidence/live-entry readers and pointer migrations, memory passages/storage/index/readiness/service, background/call preparation, HTTP cancellation, native RPC, and shared historical-source rendering. Documentation inspection included `ARCHITECTURE.md`, `TRAY.md`, `docs/architecture.html`, and `voice/realtime/README.md`.

**Important completeness qualification:** broad initial file reads included truncated outputs. Focused rereads established the findings and fix checks above, but I cannot honestly claim exhaustive line-by-line coverage of every large test or production file. The inventory describes files inspected, not a full behavioral certification.

**Remaining gaps:**

- No builds, tests, mutations, real-provider checks, native-platform or physical-device qualification were run.
- UI and optional qualification scripts were inspected, not exercised.
- Binary audio/image assets were not inspected.
- No Git diff/status was available through the permitted tools; current files, including newly present tests/fixtures, were reviewed without proving their tracked/untracked classification or commit of introduction.
- No credential stores, private logs, `.env`, dependencies, generated output, test artifacts or real session stores were read.

Beyond the identified test repairs, platform execution and completion of the truncated-file review are coverage work—not evidence of another confirmed defect.

**CONFIRMED FINDINGS REMAIN**
