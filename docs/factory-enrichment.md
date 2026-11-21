# Factory: enriched workflows in one Pi session

This is a checkout-only prototype in draft PR #54, not part of published 0.10.0. Runtime scripts are not yet included in the npm package. Opening or refreshing Factory starts no inference or execution.

## Execution path

**Verified historical workflow → task-specific enrichment → one Pi session executes the complete enriched workflow → fresh host checks and retained patch.**

1. The operator selects a matching repository workflow, committed ref and concrete task, then clicks **Run**. Sources, including uncited dependencies, are checked again. One server-side owner prevents overlapping runs; unfinished cleanup, including legacy release runs, blocks another start.
2. The host snapshots that exact commit. It requires the committed `.draken/environment.json`, validates the approved image and prepares the isolated workspace. Original setup/check commands establish the baseline. Dirty and untracked host files are not included.
3. The host creates one Pi session. Its first model turn has **no active tools**. It receives the historical procedure, task, immutable policy, environment and baseline, and produces task-specific approaches/checks for every historical step, review guidance, completion criteria and risks.
4. The pure enrichment module validates that output. Historical observations remain unchanged. Draken's additions and mandatory preparation, verification, repair, self-review, completion and escalation requirements are separate. Invalid enrichment stops the run; it is not repaired or retried silently. The validated result is saved in `agent/enrichment.json` and appears in **View log**.
5. The same session receives the complete enrichment and enables container-only `read`, `write`, `edit` and `bash`. It executes the workflow, reviews its diff, repairs findings and retests. A model-written plan cannot grant authority or alter host requirements. Review by this session is **self-review**, not independent review.
6. The host stops the task processes, collects the candidate through a read-only volume mount and pristine Git metadata, then applies it to a fresh volume. Original setup/check commands run again. The receipt records the patch hash and check-definition hash, with scope `frozen-repository-checks`. Passing these checks does **not** establish arbitrary task acceptance.

No publication, push, pull request creation or parallel agents. Unsupported endpoints or permissions must be reported as blockers. The old fixed-release/per-step executor, capability catalog, release UI and saved-binding regeneration path have been removed; private historical receipts remain intact. The checks-only CLI invocation remains an internal diagnostic, not a second Factory Run form.

## Model, accounting and learning

- Both enrichment and execution use the **same final summarization model**, selected by `defaultModels().final`: `DRAKEN_PI_FINAL_MODEL`, then `DRAKEN_PI_MODEL`, then `openai/gpt-6-astra`. There is no separate Factory model override.
- The default allowance is **16 total provider calls**, including enrichment, tool continuations and repair. One session holds the entire conversation. Automatic retries, compaction and cache warming are disabled.
- The host durably reserves each dispatch through the qualified `session.agent.streamFunction`, reconciles response usage and stops on missing or invalid accounting. Failed paid attempts and explicit unknown usage are retained, never converted to zero. A final assistant message alone is not success.
- Source permission checks occur before/after planning, provider/tool work and completion. The server rechecks dependencies before displaying saved results, logs or enrichment. Revocation withholds all of that content.
- Discovery-authorized sessions are saved under the normal Pi session root in `draken-factory/`, with the real repository `cwd` and workflow/policy metadata. Normal consent, activity windows, exclusions and verified preparation still control ingestion. Host verification stays separate; no success label is automatically inserted into learning.

## Required repository declaration

Commit `.draken/environment.json` on the selected ref. It supplies the approved container image, setup commands and frozen checks. It is **not** the workflow or enrichment, and no environment is inferred from manifests or CI. Missing declarations fail before Docker or model work with:

> Missing required file: .draken/environment.json. Add and commit it to the selected branch or commit before running repository checks.

See this repository's declaration for the schema. The candidate cannot weaken the environment, CI, manifests/locks, command entrypoints or existing test/script/configuration files. New regression tests are allowed. These restrictions are deliberately conservative and can block legitimate tasks that require changing protected files.

## Host configuration

Set these on the running Draken server, not in repository-controlled code:

- `DRAKEN_WORKSPACE_REPO`: permitted local Git repository.
- `DRAKEN_DOCKER_BIN`: absolute Docker CLI path.
- `DRAKEN_DOCKER_HOST`: local rootless `unix:///...` socket.
- `DRAKEN_WORKSPACE_ALLOWED_IMAGES`: JSON array of approved pinned image references matching the declaration.
- `DRAKEN_FACTORY_PI_SDK`: absolute `dist/index.js` path for the separately qualified **Pi SDK 1.4.0**.
- Normal final-model configuration and credentials.

The SDK qualification is still separate from Draken's managed CLI version. Another SDK version is rejected, not silently substituted; unifying those installations requires qualification. Never put provider credentials in the worker container.

The browser starts `scripts/factory-workspace.cjs REPOSITORY REF NEW_PRIVATE_OUTPUT_DIRECTORY BRIEF_FILE` with a source-authorized brief and authenticated source checks. Operator-authored briefs are allowed only through the private CLI mode. Manual trusted CLI runs are outside the server's execution lock. Omitting the brief runs only the declared setup/check diagnostic, with no agent or model calls.

## Isolation, cancellation and receipts

The host owns Pi, credentials, session storage, accounting, source checks and Docker control. Every coding tool uses the persistent container; there is no host fallback. Extension/MCP/codemode/skill/template discovery is disabled through an explicit empty resource loader. Repository instructions can be read as data, not executable host resources.

Workers are non-root, with read-only roots, dropped capabilities, seccomp, no Docker socket or host checkout mounts, and enforced CPU/memory/PID limits. Engineering workers use 2 CPUs, 4 GiB RAM, 512 PIDs and 1 GiB temporary storage. Network access goes through a restricted npm read/audit broker; arbitrary external requests and publication are unavailable. Rootless containers still share the host kernel and have no volume disk quota. Host Pi and adapters remain trusted code.

A run has a 15-minute deadline. Bash commands have a 240-second maximum and stop their process group on timeout/cancellation; output is limited to 1 MB, with the final 40,000 characters returned. File tools accept regular text files of at most 1 MB and reject traversal and paths outside the workspace, including symlinks. Cancellation stops the actual task container before read-only patch collection. Failed collection retains the volume; uncertain cleanup blocks new starts.

Private receipts live under the data directory's `factory-workspaces/<run>/`: request/exit files, event log, baseline, agent session/accounting/enrichment/result, candidate patch, fresh verification and cleanup records. Legacy `factory-runs/` receipts are retained and inspected for unfinished cleanup, but no longer have an execution API or UI.

## Code and validation

- `src/factory-enrichment/`: independent public contract, plan validation and substantive enrichment; no application/package/Node imports.
- `src/factory/discovery.ts`: converts only freshly verified proposals.
- `src/factory/workspace.ts`, `execution-owner.ts`: authenticated starts, source-sensitive reads, accounting display and ownership.
- `src/factory/docker.ts`: shared isolation flags and rootless-engine checks.
- `scripts/factory-workspace/`: authorization, persistent host session, container tools, restricted broker and workspace worker.

Normal tests cover the pure boundary and copied standalone module, every-step/review/completion validation, source revocation, no implicit retries, shared call allowance, unknown usage, API ownership/authentication and browser refresh/start/cancel behavior.

Opt-in `tests/factory-agent-live.cjs` exercises real Docker with a deterministic SDK fixture: enrichment then execution, call limits, tool/path isolation, network restrictions, protected-check rejection, fresh verification, cancellation, patch recovery and unchanged host checkout. `tests/factory-pi-contract-live.cjs` exercises the actual qualified SDK with simulated provider responses and simulated container operations: tool-free enrichment, execution with four tools, three reconciled turns and one saved conversation. Neither test proves model/task quality or incurs provider calls.

Earlier real-agent development proof used **Luna**, before this cleanup and before the shared-model switch: six calls, $0.00089804, a strict-integer parser fix and fresh host checks. An earlier accounting bug's six-call/$0.00073426 correction remains retained separately. Older fixed-release enrichment/container receipts are historical proofs of that removed implementation. None is a paid Astra demonstration of the new enrichment path or complete task-to-PR delivery.

Still unfinished: task-specific independent acceptance, permitted delivery, automatic restart reconciliation, richer outcome-to-learning joins, SDK-version consolidation and packaged runtime distribution. Existing background-learning errors are not cleared or retried by this change.
