# Refactor decision log

## Baseline

- User selected structural refactoring, comment cleanup and test cleanup.
- Clean working tree; `npm test`: 306 passing, no skips; `npm run check`: passing.
- No subagent facility is available. Reviews in this session are sequential, not independent subagent reviews.
- This is an ongoing inventory, not a claim that every module has been exhaustively reviewed.

## Decisions (recorded before implementation)

### Put transport errors in a dependency-free module

- Needless link: `src/memory/service.ts`, `src/sync/pi.ts`, `src/sync/usage.ts` and route adapters import the entire sync store just for `HttpError`.
- Hidden link: error identity depends on the store even though errors have no persistence requirements.
- Move the class to `src/errors.ts` and update all consumers rather than retaining a forwarding export.

### Own Express async dispatch and disconnect lifetime in one HTTP module

- Hidden link: sync, voice and live-voice routes copy the same Promise/error forwarding implementation.
- Hidden link: memory and live voice separately implement response-close cancellation and listener cleanup.
- Special case: live voice checks an already-destroyed response but memory does not.
- Share async dispatch and a response-lifetime operation. Keep cancellation opt-in: ordinary preparation must survive a browser disconnect, whereas memory requests and call setup must not.
- Preserve validation, status codes, middleware ordering and error messages.

### Separate evidence selection and discussion scope from model/call orchestration

- Needless link: `src/voice/live-context.ts` imports the model job manager to perform pure lexical retrieval.
- Needless link: text discussion imports `src/voice/history-focus.ts`, although project scope belongs to both text and voice history.
- Move lexical snapshot retrieval to `src/sync/retrieval.ts` and shared discussion scope to `src/memory/focus.ts`; use channel-neutral names.
- Surplus: the manager re-exports process shutdown owned by `src/sync/pi.ts`; server should import its owner directly.

## Special cases retained deliberately

- Authentication failure in the browser ends a dashboard session, but live voice reports failure for call cleanup: do not merge these policies just because both use fetch.
- Explicit source labels outrank lexical matches; bounded retrieval and chronological tie-breaking are product behavior.
- Project-switch, conversation-recall and pronoun handling in history scope are distinct user intents, not removable exceptions.
- Certificate re-encoding protects the private-key boundary; retain it and its security explanation.
- Model retries, legacy readers, timeouts and background ownership require behavioral review, not blanket removal.

## Verification plan

- Preserve existing regression tests during structural changes; update imports to new owners.
- Add behavior tests for synchronous/asynchronous HTTP failures and response-close cancellation/cleanup.
- Review comments and tests last. Remove implementation narration, not external/security constraints. Do not remove useful tests merely to reduce their count.
- Run full server tests, type/unused checks, production build and browser suite where supported.

## Implemented and verified

- All three decisions above are implemented. Imports point directly to owners; no compatibility re-export wrappers were added.
- Removed redundant route/API comments. Kept explanations of privacy/security constraints and source-scope semantics.
- Existing tests remain: the reviewed tests assert meaningful behavior or architectural boundaries, and none failed at baseline. Updated four test files to import the new owners; added five HTTP behavior tests.
- `npm test`: **311 passed**, zero failures/skips.
- `npm run check`: **passed** (server/client TypeScript and Knip).
- Production server/client build: **passed**; Vite retains its existing large-chunk advisory.
- `npx playwright test`: **48 passed**. The first combined build/UI command hit the harness's 200-second timeout after 40 passes; its leftover fixture server was stopped and the entire suite rerun with sufficient time. No test or timeout policy was weakened.
- Follow-up dependency scan found no remaining runtime cycle in the scanned static imports; the adapters/JSONL cycle is type-only in one direction. Voice context now depends on pure retrieval, shared focus lives in memory, and error-only consumers no longer load storage.

## Remaining scope / completion status

This is a completed first structural pass, **not completion of the requested exhaustive codebase refactor**. The database migrations, collector, summary tree, worker/process lifetimes, tray/native helpers and frontend state ownership still need full behavioral/dependency review. The initial inventory and comment/test review are not exhaustive across those areas. No independent subagent review was possible. Real-provider and physical-device acceptance checks were not run; ordinary tests use synthetic fixtures.
