### Finding — stale combined-preparation wording remains in Settings

**P3 — `client/src/components/AgentSources.tsx:41` and `client/src/components/PreparationUsage.tsx:49`**

Both components are rendered by the reviewed `IndexSettings.tsx`:

- **Agents & sessions** still says: “Automatic preparation is on by default … turn it off separately if you prefer manual preparation.”
- **Preparation usage** still describes “Automatic and manual preparation” without qualifying automatic provider work as historical.

The first passage advertises default automatic *preparation*, contrary to the new index-only policy; the second leaves that ambiguity beside model-cost reporting. The five changed UI files themselves correctly distinguish indexing from briefing generation.

**Suggested correction:** name **automatic local indexing** in source settings and describe usage as retained preparation history, **including past automatic work**. Add those assertions to the existing settings browser tests, which currently open these surfaces without checking this wording.

### Coverage confirmed by inspection

Read `docs/automatic-indexing.md`, all five requested UI files, all ten requested test files, and the current policy passages in all six requested documentation files. Also inspected the directly rendered Settings/progress components and synthetic provider/memory fixtures.

The tests contain substantive assertions for:

- **Accumulation beyond 64:** `tests/source-batch.test.cjs` progresses through **70 → 73 → 134**, closes/reopens the application and search databases, then reaches **197 → 198 → 203**. It checks durable checkpoints, vector reuse, no automatic snapshots/runs/coverage/messages/calls, and no fake-provider call log.
- **Complete explicit snapshots:** that test freezes **203 distinct entries** with request-ID idempotency. `tests/automatic-briefing.test.cjs` separately exercises the real start-chat HTTP route with **75 entries**, successful briefing generation, and no duplicate provider work on transport retries.
- **History preservation:** whole-table comparisons cover legacy snapshots, references, notes, conversations, summary/recap caches and reviewed coverage across indexing and database reopen. Ready/cancelled legacy automatic snapshots are not claimed by new requests; failed/cancelled generation requires explicit retry.
- **Preference migration:** fresh defaults, explicit canonical on/off precedence, legacy-only migration, invalid values remaining disabled, older databases without preferences, obsolete-key removal, unrelated-setting preservation and read-only settings access.
- **Passive UI behavior:** browser tests assert no mutation requests or capture from status viewing, setup checks, opening Settings and expanding preparation information. Settings GET tests additionally assert unchanged database write counts.

### Limits

This was **read-only inspection**, not execution. The reported **41 focused tests plus TypeScript/Knip passes are the parent’s results**, not mine.

The multi-batch restart regression recreates scheduler/database objects within one process; it is not a full server-process restart test. Embeddings/providers are synthetic or mocked. Browser no-mutation assertions do not independently prove every GET handler has no server-side side effects; production-source verification remains with the separately running review. No private data or generated files were inspected or modified.
