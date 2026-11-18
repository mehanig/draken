# Instructions for coding assistants

## Use plain English

- Explain things in simple, direct English. Do not use corporate buzzwords or vague technical jargon.
- Do not use words such as “bounded,” “guarded,” or “guardrails” in explanations. Say exactly what the code does or what limit applies.
- For example, say “search at most three times” instead of “bounded retrieval,” and “check source permissions before reading” instead of “guarded access.”
- State what failed, why it failed, and what you will change. Do not substitute jargon for an explanation.

## Keep evidence preparation separate

- Application callers use only `src/evidence/index.ts`. Do not import its internals or add a separate text/voice search-and-selection path.
- The module owns prepared candidate search, request relevance, source selection and checked-original packets. Callers own conversation state, invocation accounting, answering models, saving messages and review.
- Pass cancellation, a fixed history cutoff and the existing accounted model callback. Do not add provider clients, database writes, automatic retries or conversation ownership inside the module.
- Empty matches, unrelated requests, clarification and failures are different outcomes. Never infer irrelevance from an empty search.
- Keep `tests/evidence-boundaries.test.cjs` and the public-contract tests running in normal CI. A new dependency or public export requires an explicit boundary review; do not weaken these tests merely to make a refactor pass.
- Preserve source permissions, original-byte verification, text/voice parity and cancellation tests when changing this boundary.
- Keep responses concise. Use technical terms only when they help, and explain unfamiliar ones.
