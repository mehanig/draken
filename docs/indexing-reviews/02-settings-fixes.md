**NO WORTHWHILE FINDINGS REMAIN.**

Read both review documents and all three requested files completely.

- `client/src/components/AgentSources.tsx` now explicitly describes **automatic local indexing**, limits the default-on statement to new installations, and states that indexing does **not create syncs or generate briefings**.
- `client/src/components/PreparationUsage.tsx` identifies automatic preparation as **past work retained in usage history**, explicitly says current automatic indexing makes no provider model calls, and preserves the cost-estimate qualifications.
- `tests/ui/settings.spec.ts` asserts the source-policy wording and historical usage distinction. The rollback test’s `click()` correctly attempts the change without requiring an unchecked outcome. Its error and restored-checked assertions remain, alongside exact PATCH payload/order checks, successful subsequent disablement, reload persistence, explicit retry, mutation restrictions, and zero capture. This fixes the Playwright action mismatch without weakening coverage.

Read-only inspection only; no execution, modifications, or private-data access.
