# Workflow detection and Factory — first draft

## Status

This PR contains the detection foundation and a read-only Factory preview. **It does not enable automatic workflow learning.** Normal summarization integration and cross-batch episode reconstruction are unfinished. Do not merge this as the completed background-learning feature.

Open `/factory` directly. Existing pages and shared navigation are unchanged. The preview shows only saved identity proposals from the application's database whose complete source dependencies still pass verification. A new installation will show an honest empty state, not imported experiment results.

## Implemented

- Pure procedure-evidence preparation and process extraction contracts. Claims retain requested, attempted, reported, observed and unknown evidence labels and original references.
- Workflow identity comparison using purpose, method and applicability. A shared subprocedure does not make its parent workflows identical. Missing or failed outcomes do not erase an otherwise identifiable method.
- Three additive SQLite tables: `process_extractions`, `work_episodes`, `episode_extractions`. They store derived records and original pointers, not another transcript archive.
- Opt-in extraction and comparison evaluation commands with separate experiment stores, accounting, cancellation, frozen inputs and finite call allowances. These commands are development tools, not the background implementation.
- Authenticated, same-origin, no-store `GET /api/factory`, with cursor pagination and fresh permission/original-byte checks for every supplied dependency, including uncited originals. Invalidated proposals are withheld entirely. External experiment databases and synthetic fixtures are never imported by this endpoint.
- Factory-only presentation of purpose, applicability, steps, qualifications and compared evidence. Model text is rendered as text, not executable markup. Page reads and refreshes start no inference, synchronization or jobs.

The Factory read path currently reuses the experimental source receipt reader. Before production integration, move the shared receipt contract/reader out of the pilot namespace along with the production writer; do not create a second permission or original-reading implementation.

## Required before completing this feature

1. Produce process records alongside normal summarization while preserving existing summary output and UI behavior.
2. Reconstruct episodes across summary batches, retaining revisions, uncertainty and evidence links.
3. Find candidate matches from saved process records and propose workflows in the background, using the existing accounting, cancellation and source-permission infrastructure.
4. Support learning from already-ingested data without a manual sync, a separate learning action or opening Factory. Sync may supply new data but must not own workflow learning.
5. Add Factory-only proposal review and update handling. Background suggestions must not silently replace reviewed workflows. Accepting a workflow never authorizes execution.
6. Validate the complete path on independent historical jobs, including interrupted preparation, revoked sources, partial histories and conflicting evidence.

No workflow notifications, badges, chat/voice additions, shared-navigation changes or changes to other screens are part of this work. No workflow execution, deployment, automatic grouping, automatic full-history backfill or repository scanning is enabled.

## Validation

```sh
npm run check
npm test
npm run build
npx playwright test tests/ui/factory.spec.ts
```

`tests/fixtures/workflow-identity-cases.cjs` contains eight controlled comparisons, including same-goal/different-method, success versus failure, different tools, different instance values, shared validation between different jobs, and a request with no known method. Expected labels are excluded from model inputs. Earlier fixture expectations remain separately preserved.

The learning and evidence modules are copied out of the repository and compiled/run independently in normal tests. Factory tests cover source exclusion, uncited dependency revocation, changed original bytes and parent outputs, external-store rejection, cancellation, authentication, no inference on reads, mobile layouts and inert rendering of model text.

These tests establish regression behavior, not general workflow-detection accuracy or successful extraction from arbitrary histories. Private historical samples, transcripts, SQLite files and local report exports are not part of this PR.
