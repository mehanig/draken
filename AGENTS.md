# Instructions for coding assistants

## Use plain English

- Explain things in simple, direct English. Do not use corporate buzzwords or vague technical jargon.
- Do not use words such as “bounded,” “guarded,” or “guardrails” in explanations. Say exactly what the code does or what limit applies.
- For example, say “search at most three times” instead of “bounded retrieval,” and “check source permissions before reading” instead of “guarded access.”
- State what failed, why it failed, and what you will change. Do not substitute jargon for an explanation.

## Keep UI content focused

- Think like a product marketer: make the value clear and the page easy to scan, not crowded with explanations.
- Design for a returning user who already knows how the product works. Prioritize their content, decisions and next actions—not descriptions of the implementation.
- Remove text, labels, status messages and controls that do not help the user understand something important or take action. Avoid repeated disclaimers, obvious instructions and redundant headings.
- Delete unnecessary explanations instead of moving them behind a collection of info icons. Use an info icon or disclosure only when the extra detail genuinely helps.
- Keep real limitations, consequential warnings and actionable errors visible. Removing clutter must not hide problems or make unsupported claims.

## Follow the Factory plan

- Before changing Factory, read `docs/factory-plan.md`. It is the authoritative current design; research and old implementation reports in `../software-factory-approach-draken/archive/` are not requirements.
- Workflows define their full endpoint. PR creation, push, review, publication and deployment are ordinary agent-executed workflow steps when authorized—not separate Factory features requiring dedicated executors.
- Enrich during preparation, save the result, then run the complete workflow in one host Pi session using container tools. Do not regenerate enrichment per run or split execution into step sessions.
- Use ordinary Docker networking and ordinary tool clients. Do not invent brokers, action catalogs, blanket delivery bans or other product restrictions.
- Distinguish provider credentials kept on the host from explicitly configured credentials needed by workflow tools. Missing credentials are a specific prerequisite, not proof that an action is unsupported.
- Before adding a module or restriction, check whether existing tools can execute the workflow step. If the change alters the agreed design, ask first. Passing tests does not establish that the design or requested endpoint was satisfied.
- Audit the full preparation-to-result path for contradictory restrictions. Keep current implementation limitations separate from intended requirements; do not rewrite the plan to justify existing code.

## Keep evidence preparation separate

- Application callers use only `src/evidence/index.ts`. Do not import its internals or add a separate text/voice search-and-selection path.
- The module owns prepared candidate search, request relevance, source selection and checked-original packets. Callers own conversation state, invocation accounting, answering models, saving messages and review.
- `src/evidence/` must have no imports from other Draken code, external packages or Node builtins, including type-only imports. It owns its contract types and uses standard language/platform APIs. Do not add dependency exceptions.
- Keep question interpretation (project, follow-up, recall and recency) inside the evidence module's model planning step. Do not add caller-side intent regexes, word lists or guessed project restrictions. Citation syntax validation and local search tokenization are mechanical checks, not intent detection.
- Inject permitted session metadata, search, fresh verified-original reads and text cleaning through `EvidenceDependencies`; pass the accounted model callback, cancellation and fixed cutoff in the request. Wire Draken services only in `src/evidence-adapter.ts`, outside the module. Do not add default adapters, provider clients, database writes, automatic retries or conversation ownership inside the module.
- Empty matches, unrelated requests, clarification and failures are different outcomes. Never infer irrelevance from an empty search.
- Keep the import checks, standalone compile/run proof and pure public-contract tests in normal CI. The evidence folder must work when copied away from the repository with only injected host functions. Do not weaken these tests to make a refactor pass.
- Preserve source permissions, original-byte verification, text/voice parity and cancellation tests when changing this boundary.
- Keep responses concise. Use technical terms only when they help, and explain unfamiliar ones.
