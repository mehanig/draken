# Background workflow detection and Factory

## How it runs

Workflow detection is connected to normal summarization—not to a Sync action or a Factory visit.

1. Every **new leaf summarization call** returns the ordinary observations and limitations plus a separate `process` record. This uses the same provider invocation, accounting and verified source inputs. Normal summary output remains unchanged in structure.
2. Valid process fragments are saved with original pointers, per-claim evidence labels and coverage gaps. No second transcript archive is created. Procedural claims are checked against fresh originals after inference; an invalid process result does not replace the ordinary summary.
3. The existing background summarization owner drains pending process records. An accounted model call selects at most three candidates from at most 24 earlier process records. It then compares purpose, method and applicability. Repeated/overlapping source batches are not treated as separate examples.
4. Identity proposals are saved in the application database and displayed **only on `/factory`**. A shared subprocedure does not identify its parent jobs as the same workflow. Failed or unknown outcomes remain separate from workflow identity.

The background job uses the existing automatic-preparation settings, idle checks, cancellation and invocation allowance. Disabling automatic summarization pauses paid background workflow learning. Process records produced by explicit foreground summarization can be matched later by the background owner, even when an open conversation holds all pending history.

There is no independent scheduler, provider client or fresh allowance for the detector. Failed matching stops automatic paid retries through the existing preparation failure/retry mechanism. Settings and Factory report the failed step, saved cause and attempt call count rather than calling every failure a summary failure. Local indexing has separate status and errors; a model-preparation failure does not stop it. Status reads use saved database records only, and do not clear errors or retry work. If a historical cause was not retained, the UI says so. Cancelled work retains its spent allowance and resumes with completed summaries and candidate selections cached. Process validation can use the summarizer’s existing second attempt, within the same invocation allowance, while retaining an already-valid ordinary summary. A failed correction or exhausted allowance does not discard that summary. Failed process extraction records retain the validation field/error and an output hash; they are not disguised as empty matches. Cached failures do not start automatic retry jobs.

## Factory and source access

Open Factory from the top bar or directly at `/factory`. On screens up to 760px wide, navigation and account controls sit in a hamburger menu. Reads and Refresh start no inference, synchronization or jobs.

Factory shows purpose, applicability, proposed steps, outcome qualifications and compared evidence. It reports whether learning is enabled, paused or stopped by a preparation error. The main page shows repository groups, proposal counts, workflow applicability and steps. Generic explanations, info icons and historical failure counters are omitted. Actual limitations remain visible, evidence is expandable, and stopped learning has a short link to its retry settings. The page remains a proposal viewer, not an executor or an approval mechanism.

`GET /api/factory` uses the existing authenticated, same-origin, no-store API boundary. Preparation revalidates its supplied source dependencies—including uncited originals and unselected candidates—before and after inference. Factory displays the persisted result from the database without repeating that preparation or checking historical sources. Changed or removed originals do not hide saved workflows. Source reads use the public evidence contract and application wiring in `src/evidence-adapter.ts`; the production reader no longer imports the pilot reader or opens external experiment databases.

## Repository and folder groups

Factory groups proposals by the Git repository containing the session’s recorded working folder. Subdirectories and linked worktrees share the common Git directory identity. Nested repositories and separate clones stay separate, even if their names or remotes match. No Git commands or remote requests are used to determine the location.

Candidate selection filters by this location **before** taking up to 24 candidates. Different repositories and different non-Git folders are never compared. Existing comparisons with a pair spanning locations are withheld. Non-Git directories are labelled **Not a Git repository** and show their full path; missing or unreadable locations are withheld, not guessed to be non-Git.

New records retain their location identity, and location changes during extraction or matching reject the result. Older records without that metadata use the current layout of their verified recorded folder. This is session-location attribution, not an inference about where individual commands ran. The group path identifies the recorded location; this attribution rule is documented here rather than repeated on every card.

## Storage and limits

The three additive tables remain `process_extractions`, `work_episodes` and `episode_extractions`. Episode queue state is stored alongside the existing fragment records. Summary extractions link to their shared summary invocation; selection and comparison attempts link to their owning background run.

- Existing valid summary caches remain reusable. They are **not** automatically regenerated for workflow backfill. New summaries collect process records. An explicitly requested preparation can select one to six existing leaf keys through the same background owner. It checks current source permissions and the activity window, prepares process records without changing cached summaries, and retains failed attempts. It allows at most one validation correction per selected leaf, within the job’s allowance. Page reads and ordinary background ticks do not request this preparation.
- Records spanning summary batches remain explicitly labelled fragments. This change does not claim complete episode reconstruction, recurrence counts or exhaustive discovery across a large library.
- Candidate selection examines at most 24 earlier records and compares at most three per new fragment. It does not compare every pair in history or use a predefined technology taxonomy.
- No automatic workflow grouping, review acceptance, execution, deployment or repository scanning is enabled. Reviewed-library editing and cross-batch episode assembly remain separate future work.
- Historical experiments stay in their separate stores. They are never imported into Factory as real application proposals.

## Verification

```sh
npm run check
npm test
npm run build
npx playwright test tests/ui/factory.spec.ts tests/ui/settings.spec.ts tests/ui/history.spec.ts tests/ui/appearance.spec.ts
```

`tests/workflow-background.test.cjs` exercises the real background summarization owner with a controlled provider: session history → ordinary summaries and process records → candidate selection → matching → a saved Factory proposal, without creating a sync or visiting Factory. It also checks opt-out, learning from already-ingested data, foreground-produced records, duplicate source batches, cancellation/resume accounting, invocation limits, failed-call retry policy, and source changes during inference.

Other tests cover original-byte/permission checks, unselected dependencies, schema/reference validation, independently compiled pure modules, old summary-cache reconstruction, authentication, read-only page requests, mobile layouts and inert rendering of model text.

Local validation passed 771 automated tests and 15 selected browser tests, plus typechecks, unused-code checks and server/client builds.

Two real-provider smoke runs used the same two controlled parser-repair examples in separate isolated data directories, not user history. Each completed the background pipeline and produced one source-verified Factory proposal using `openai/gpt-6-luna` in four calls. Total cost was $0.0023014 across eight calls. Unchanged repeats made no further calls; the final saved proposal was also verified with the then-current reader while no provider was available. This is integration evidence, not a general accuracy benchmark. Private smoke-test stores and transcripts are not part of the PR.

An explicitly requested local preparation of four saved leaves from real release history produced two verified proposals. Two earlier extraction-format failures were retained; after clarifying the string-array contract, the successful run used 14 calls. This was a selected starting set, not automatic discovery across all history. The live page was checked at desktop and mobile widths. Its current presentation removes generic explanatory copy and info icons entirely.
