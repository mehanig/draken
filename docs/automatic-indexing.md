# Automatic indexing must not create syncs

## Requested behavior

Automatic work accumulates searchable history. Only an explicit user action creates a sync and starts its briefing. Existing syncs, references, cached summaries, conversations, notes and review state must remain intact.

## Fix and inventory

- Restrict the background owner to scanning and local history indexing. Remove its summary/briefing operations and automatic snapshot creation path.
  - `src/sync/background.ts` currently treats available entries as a trigger for `prepareAutomaticBriefing`, even when the search index is current.
  - `src/sync/automatic.ts` creates immutable snapshots every batch and invokes provider models without a new user action.
- Make `auto_index` the sole preference, preserving saved on/off choices and migrating legacy combined settings without widening permission. Remove combined-mode consent and progress fields.
  - Schema initialization enables both indexing and automatic briefing; the API/UI currently advertise and authorize both together.
- Remove automatic-sync claiming from new user requests. Keep old snapshots as ordinary history, not hidden resumable background jobs. Preserve explicit retry and request-ID idempotency.
- Replace combined-mode tests with regressions proving repeated timer ticks/restarts accumulate entries without syncs, provider calls, notes/review changes, and that an explicit user request creates the complete snapshot.
- Update settings, home and architecture documentation to describe index-only automatic work. Local embeddings/downloads remain distinct from provider summarization.

## Operational containment

The running server's automatic setting was temporarily paused through its authenticated API before implementation, to prevent further unwanted batches. It was enabled beforehand; restore indexing after deploying the corrected build. Do not delete or rewrite the user's existing automatically created syncs.

## Review and validation follow-up

The independent server review found no remaining issues. The UI/test review found two remaining Settings explanations that still implied current automatic provider preparation (source selection and usage history); align them with local indexing and explicitly historical spending. The first full run passed 358 unit tests and static checks; 51 browser tests passed and the new settings rollback test failed because Playwright `uncheck()` requires an unchecked result even when the expected UI behavior is to restore the checked state after a rejected save. Use a click and assert the rollback/error instead; no production timing or behavior change is needed.

Both review findings and the test-action mismatch are fixed. [Server review](indexing-reviews/01-server.md) and [final Settings review](indexing-reviews/02-settings-fixes.md) report no worthwhile findings remaining; the [initial UI/test review](indexing-reviews/01-ui-tests.md) records the completed broader scope and the resolved wording findings.

Final verification: **358 unit tests, 52 UI tests and 23 standalone browser/site tests passed**, with no failures/skips. Server/client TypeScript, Knip and diff checks passed. The static TS/TSX runtime-import graph has 114 files, 291 edges and no cycles. Multi-batch regression coverage accumulates 203 distinct entries across scheduler/database restarts without snapshots/provider work, then freezes all 203 only on an explicit request. The HTTP regression separately generates a 75-entry manual briefing and verifies transport retry idempotency. Tests use synthetic embeddings/providers; no real-provider or physical-device acceptance is claimed.
