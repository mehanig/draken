# 0.9.0: shared evidence selection for text and voice

## Change

Keep the existing SQLite keyword search, local embeddings and prepared-history cutoff. Alternate result lists, skipping duplicate originals before advancing to another list. Remove hand-written role/age/keyword score bonuses and the later-report graph.

For both text and voice, gather up to 64 candidates. The configured summary model sees 800-character excerpts, source metadata and recent user questions, and returns at most eight source IDs. It does not write an intermediate answer. Reread selected originals after inference and include their neighboring request/result messages. The answering model receives at most 24 sources and 32,000 UTF-8 bytes. Shortened excerpts retain closing qualifications.

Text normally makes two calls, or three if its existing citation correction is needed. Voice uses the same selector, then its existing native voice model answers. Up to three distinct voice lookups share the turn's invocation allowance; duplicate lookups are reused. Invalid selection stops further selection for that turn. Stop, a new question and ending a call cancel unfinished selection and prevent old evidence delivery.

The existing paid-call accounting code was moved out of the summary tree so voice can reuse it. Voice selection uses existing run records, tagged separately from text-chat progress/retry jobs. No new dependencies, database tables, migration, worker, search engine or cache format.

## Checks

- 627 unit tests and 59 application UI tests passed in the complete sequential rerun.
- 23 browser/site/realtime tests and production-only package smoke passed.
- Build, typecheck and unused-code checks passed.
- Tests exercise actual source reads, exclusion/damage during selection, cutoff/project scope, neighboring command results, contradictory records, empty selections, malformed IDs, byte limits, invocation limits and cancellation.
- Voice tests cover spoken and typed questions, continuation after selection, shared refinement spending, Stop, end-call, replacement questions and no extra text-answer call.
- An initial parallel qualification had a native fixture missing its request log. Its isolated rerun and the subsequent complete unit run passed. The obsolete UI expectation of zero voice pi calls was replaced with checks for selection-only calls.

## Real-provider replay and limits

Replayed four questions through the real text-chat generation path on a copied application database and a read-only search database, without the saved briefing. The running server and live conversation were not modified. All four completed with one Luna selection call and one Astra answer call; no citation correction was needed.

- Latest-release question: retrieved publication/deployment and later background-completion evidence and answered that 0.8.9 was shipped and running locally.
- Performance explanation: found the repeated local-work diagnosis and an early optimization benchmark, correctly qualifying the synthetic final response. It did **not** retrieve the latest real-opening measurement. Candidate coverage is still incomplete.
- Another project's implementation/acceptance question: retained the difference between implementation, simulator results and unverified device/provider acceptance.
- An unrecorded project's deployment question: selected no sources and declined to invent a deployment location.

These four runs took 8.1–17.5 seconds overall. Selection took 2.1–3.2 seconds, with catalog-based estimates of roughly $0.0021–$0.0026 per selection. An earlier selector probe hit its 60-second test deadline. These are observations, not latency, billing or general answer-quality guarantees.

The selector cannot choose a source absent from the candidate pool. It can also include irrelevant sources or miss useful ones. Real native-provider audio was not requalified by these replays; voice integration was exercised with the synthetic native helper and browser audio fixture.
