# Instructions for coding assistants

## Use plain English

- Explain things in simple, direct English. Do not use corporate buzzwords or vague technical jargon.
- Do not use words such as “bounded,” “guarded,” or “guardrails” in explanations. Say exactly what the code does or what limit applies.
- For example, say “search at most three times” instead of “bounded retrieval,” and “check source permissions before reading” instead of “guarded access.”
- State what failed, why it failed, and what you will change. Do not substitute jargon for an explanation.

## Keep evidence preparation separate

- Application callers use only `src/evidence/index.ts`. Do not import its internals or add a separate text/voice search-and-selection path.
- The module owns prepared candidate search, request relevance, source selection and checked-original packets. Callers own conversation state, invocation accounting, answering models, saving messages and review.
- `src/evidence/` must have no imports from other Draken code, external packages or Node builtins, including type-only imports. It owns its contract types and uses standard language/platform APIs. Do not add dependency exceptions.
- Inject search, fresh verified-original reads and text cleaning through `EvidenceDependencies`; pass the accounted model callback, cancellation and fixed cutoff in the request. Wire Draken services only in `src/evidence-adapter.ts`, outside the module. Do not add default adapters, provider clients, database writes, automatic retries or conversation ownership inside the module.
- Empty matches, unrelated requests, clarification and failures are different outcomes. Never infer irrelevance from an empty search.
- Keep the import checks, standalone compile/run proof and pure public-contract tests in normal CI. The evidence folder must work when copied away from the repository with only injected host functions. Do not weaken these tests to make a refactor pass.
- Preserve source permissions, original-byte verification, text/voice parity and cancellation tests when changing this boundary.
- Keep responses concise. Use technical terms only when they help, and explain unfamiliar ones.
