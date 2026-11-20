# Background workflow detection and Factory

## How it runs

Workflow detection is connected to normal summarization—not to a Sync action or a Factory visit.

1. Every **new leaf summarization call** returns the ordinary observations and limitations plus a separate `process` record. This uses the same provider invocation, accounting and verified source inputs. Normal summary output remains unchanged in structure.
2. Valid process fragments are saved with original pointers, per-claim evidence labels and coverage gaps. No second transcript archive is created. Procedural claims are checked against fresh originals after inference; an invalid process result does not replace the ordinary summary.
3. The existing background summarization owner drains pending process records. An accounted model call selects at most three candidates from at most 24 earlier process records. It then compares purpose, method and applicability. Repeated/overlapping source batches are not treated as separate examples.
4. Identity proposals are saved in the application database and displayed **only on `/factory`**. A shared subprocedure does not identify its parent jobs as the same workflow. Failed or unknown outcomes remain separate from workflow identity.

The background job uses the existing automatic-preparation settings, idle checks, cancellation and invocation allowance. Disabling automatic summarization pauses paid background workflow learning. Process records produced by explicit foreground summarization can be matched later by the background owner, even when an open conversation holds all pending history.

There is no independent scheduler, provider client or fresh allowance for the detector. Failed matching stops automatic paid retries through the existing preparation failure/retry mechanism. Cancelled work retains its spent allowance and resumes with completed summaries and candidate selections cached. Invalid process extraction is recorded as a failure and shown on Factory; it is not disguised as an empty match or automatically regenerated.

## Factory and source access

Open `/factory` directly. Existing pages and shared navigation are unchanged. Reads and “Refresh saved results” start no inference, synchronization or jobs.

Factory shows purpose, applicability, proposed steps, outcome qualifications and compared evidence. It reports whether learning is enabled, paused or stopped by a preparation error. The page remains a proposal viewer, not an executor or an approval mechanism.

`GET /api/factory` uses the existing authenticated, same-origin, no-store API boundary. All supplied source dependencies—including uncited originals and unselected candidates seen during selection—are revalidated before inference, after inference and before serving a proposal. Unavailable derived content is withheld entirely. Source reads use the public evidence contract and application wiring in `src/evidence-adapter.ts`; the production reader no longer imports the pilot reader or opens external experiment databases.

## Storage and limits

The three additive tables remain `process_extractions`, `work_episodes` and `episode_extractions`. Episode queue state is stored alongside the existing fragment records. Summary extractions link to their shared summary invocation; selection and comparison attempts link to their owning background run.

- Existing valid summary caches remain reusable. They are **not** automatically regenerated for workflow backfill. New summaries collect process records.
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

Local validation passed 750 automated tests and 14 selected browser tests, plus typechecks, unused-code checks and server/client builds.

Two real-provider smoke runs used the same two controlled parser-repair examples in separate isolated data directories, not user history. Each completed the background pipeline and produced one source-verified Factory proposal using `openai/gpt-6-luna` in four calls. Total cost was $0.0023014 across eight calls. Unchanged repeats made no further calls; the final saved proposal was also verified with the current reader while no provider was available. This is integration evidence, not a general accuracy benchmark. Private smoke-test stores and transcripts are not part of the PR.
