# Instructions for coding assistants

**More defensive does not automatically mean better.**

## Use plain English

- Explain things in simple, direct English. Do not use corporate buzzwords or vague technical jargon.
- Do not use words such as “bounded,” “guarded,” or “guardrails” in explanations. Say exactly what the code does or what limit applies.
- For example, say “search at most three times” instead of “bounded retrieval,” and “check source permissions before reading” instead of “guarded access.”
- State what failed, why it failed, and what you will change. Do not substitute jargon for an explanation.

## Do not invent checks or repeat completed work

- Implement the requested behavior, not an imagined stricter product. Do not add validation, verification, prerequisites, restrictions or failure conditions merely because they seem safer or more thorough. Each must address an explicit user requirement, an applicable documented contract or a concrete failure in the requested operation. A hypothetical concern is not enough.
- Apply requirements only where they belong. A check required when preparing evidence or accepting input does not automatically belong in page loads, saved-result reads or every later operation. Existing checks and passing tests are not proof that those checks are necessary.
- Treat saved results as saved results. Display them from storage; do not repeat inference, reopen original inputs, walk provenance chains or revalidate completed preparation unless the requested behavior explicitly requires it. Preserve ordinary application authentication and authorization without turning them into a reason to redo preparation.
- Before adding work to a frequently used path, identify its actual cost: database queries, file reads, network requests and growth with the number of records. Prefer doing necessary work once at the operation that owns it, rather than making every reader repeat it.
- Measure the affected user-facing path with representative saved data before calling the change finished. Correct output and green tests do not excuse a slow page. Report any material delay and its cause; do not silently accept it.
- When a check causes complexity or latency, first ask whether it is required at that point. Remove unnecessary work rather than building caches, background jobs or more infrastructure around it. If an existing contract conflicts with the requested behavior, explain the specific conflict and ask instead of silently expanding the scope.

## Session sources are append-only

- Session history is append-only. Original session content stays in the session files. Persist pointers and metadata, not copies of raw or normalized session content, in the database. Do not add a transcript archive, content table or content-import migration.
- Reuse already prepared results and records already loaded in memory. Do not reopen session files, compare original bytes or hashes, or walk provenance chains merely to revalidate completed work. This applies to evidence retrieval, workflow matching, consolidation, enrichment and saved-result reads—not just page loads.
- When an operation actually needs session text that is not already loaded, read it through its stored pointer. Reading needed content is different from repeatedly verifying unchanged content.
- Process newly appended records without revalidating unchanged history. An append does not invalidate existing pointers or prepared results.
- Keep source permissions and revocation checks separate from content verification. Check current access using stored metadata; do not use permission checks as a reason to reread original session files.
- This rule supersedes older requirements for fresh original-source verification on every use. Do not preserve repeated verification merely because existing code, tests or documentation require it.

## Check every PR for dead code

- Before opening or updating a PR, check its changes and the code they replace for dead code. Remove obsolete helpers, branches, imports, types and response fields that no longer have a supported caller.
- Trace application callers, not just references. Tests calling a helper do not prove the application still uses it. Remove tests that only preserve obsolete behavior; keep coverage for current requirements, permissions, accounting and cancellation.
- Run the unused-code checks and manually review the PR diff. Do not hide unused code with ignore rules or retain a replaced implementation just to keep its tests passing.

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
- Inject permitted session metadata, search, pointer-based access to original session records or reuse of records already loaded in memory, and text cleaning through `EvidenceDependencies`; pass the accounted model callback, cancellation and fixed cutoff in the request. Wire Draken services only in `src/evidence-adapter.ts`, outside the module. Do not add default adapters, provider clients, database writes, automatic retries or conversation ownership inside the module.
- Empty matches, unrelated requests, clarification and failures are different outcomes. Never infer irrelevance from an empty search.
- Keep the import checks, standalone compile/run proof and pure public-contract tests in normal CI. The evidence folder must work when copied away from the repository with only injected host functions. Do not weaken these tests to make a refactor pass.
- Preserve source permissions, first-time original-byte verification, text/voice parity and cancellation tests when changing this boundary. Tests must not require repeated original-source verification of records already processed into the database or memory.
- Keep responses concise. Use technical terms only when they help, and explain unfamiliar ones.
