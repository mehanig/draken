# Factory: current implementation and operating guide

**Design authority: [Factory plan](factory-plan.md).** This guide describes the current code, not the desired limits of the product. The current publication prohibition, broad protected-file checks and incomplete Git/credential setup are implementation gaps to correct—not requirements to preserve. Updating the plan has not yet removed them from runtime code. Workflow actions such as PR creation and publication belong to the agent's complete workflow, not separate Factory executors.

Checkout-only prototype in draft PR #54, not published 0.10.0. Runtime scripts are not yet shipped in npm. Opening or refreshing Factory starts no inference or execution.

## Intended lifecycle

**Discover → enrich during preparation → save the enriched workflow → display it in Factory → Run tasks using the saved enrichment.**

Discovery records historical observations. Enrichment adds reusable preparation, execution, checks, self-review, recovery, completion criteria and risks. It defines the concrete inputs the workflow needs, if any, and is not tied to a particular checkout or execution session. Factory renders those saved input definitions, not a generic task/prompt box. The server derives the execution objective from the selected workflow and validates only its declared input values. The later coding session adapts its task plan after inspecting the repository; it does **not** regenerate workflow enrichment.

- Normal background preparation enriches new verified discoveries before that preparation job completes. It uses the existing preparation owner, consent/cancellation checks and remaining invocation allowance.
- Enrichment uses the final summarization model (`defaultModels().final`, currently `openai/gpt-6-astra`), through normal `modelCall` accounting. It is one call, with no repair loop or silent retry.
- `workflow_enrichments` stores each attempt, raw output, validated output, model and accounting-owner ID. The saved result is tied to the discovery revision, host-policy version and enrichment-prompt revision. Historical observations remain unchanged; model guidance and mandatory host requirements are separate.
- Factory shows the saved execution guidance, review checks, completion criteria, risks and host requirements. Older discoveries without enrichment are marked **Awaiting enrichment — not ready to run**, with an explicit **Enrich workflow** action. Failed attempts offer an explicit retry. These actions use the same preparation owner; they do not clear or retry an unrelated background-learning error.
- A completed enrichment is reused across task submissions, restarts and model-selection changes. Changed source revisions or relevant host policy require a current enrichment. Bump `ENRICHMENT_POLICY_VERSION` when host permissions or required checks change. A changed enrichment prompt also invalidates reuse. Corrupt or incompatible saved output is not execution-ready.
- Source permissions and uncited dependencies are checked before and after model work and before display or execution. Revocation withholds the workflow and its enrichment. GET/refresh never creates, updates or retries enrichment.

## Run lifecycle

1. Select a prepared workflow, fill only its defined inputs (for example, a release version), choose the committed ref and click **Run**. A workflow with no additional inputs has no prompt box. The API checks current sources and loads the saved enrichment. Missing/stale enrichment fails before creating a workspace; Run never prepares it implicitly.
2. The host snapshots that exact commit and requires committed `.draken/environment.json` with a host-approved pinned image, setup and frozen checks. Dirty/untracked host files, earlier Git history, remotes/configuration and credentials are excluded. Submodules/LFS are rejected rather than silently omitted.
3. Setup and baseline checks run in an isolated persistent workspace. One host-side Pi session receives the task, saved enriched workflow, environment and baseline. All enabled read/write/edit/bash tools operate inside the container; there is no host fallback. The first prompt is execution, not enrichment.
4. The session inspects, plans the particular task, implements, tests, self-reviews, repairs and reports completion or blockers. Same-session self-review is **not independent review**. The run allowance is configured once under **Execution settings** on Factory (1–64 provider calls; initial default 16), rather than repeated under each workflow. A change applies to new runs; each run freezes its allowance and repeated request IDs cannot change it. The separately saved enrichment does not consume that allowance. Automatic retries, compaction and cache warming are disabled.
5. The host stops actual task processes, collects the patch using a read-only mount and pristine Git metadata, applies it to a fresh volume and runs the original setup/checks. The receipt records patch/check-definition hashes and scope `frozen-repository-checks`. Passing those checks does **not** infer arbitrary task acceptance.

**Current implementation limitations:** prompts/contracts prohibit publication, push and PR creation; candidate validation rejects changes to existing tests, scripts, CI, manifests/locks and environment policy, while allowing new regression tests. These restrictions can prevent legitimate workflow endpoints and conflict with the current plan. They remain in the code pending correction. A missing credential or permission must still produce a specific blocker, not an invented grant. The agreed one-session design separately excludes subagents and parallel agents.

## Required environment and host configuration

Commit `.draken/environment.json` on the selected ref. It supplies image, setup and frozen checks—not the workflow or enrichment. No image/environment is inferred from manifests or CI. Missing declarations fail before Docker or execution-model work:

> Missing required file: .draken/environment.json. Add and commit it to the selected branch or commit before running repository checks.

Host-selected configuration:

- `DRAKEN_WORKSPACE_REPO`: permitted Git repository.
- `DRAKEN_DOCKER_BIN` and `DRAKEN_DOCKER_HOST`: absolute Docker CLI and local rootless Unix socket.
- `DRAKEN_WORKSPACE_ALLOWED_IMAGES`: JSON array of approved pinned image references.
- `DRAKEN_FACTORY_PI_SDK`: qualified **Pi SDK 1.4.0** `dist/index.js` path.
- Normal final-model configuration/credentials: `DRAKEN_PI_FINAL_MODEL`, then `DRAKEN_PI_MODEL`, then `openai/gpt-6-astra`. No Factory-specific model override.

The SDK remains separately qualified from the managed CLI. A different SDK is rejected, not silently substituted. Never forward provider credentials to the container.

The browser invokes `scripts/factory-workspace.cjs REPOSITORY REF NEW_PRIVATE_OUTPUT_DIRECTORY BRIEF_FILE`. The source-authorized `factory-agent-session-v2` brief contains the exact saved `factory-workflow-enrichment-v4` result. The host checks that the current API still exposes that same enrichment before provider/tool work. Private operator briefs must also contain a valid prepared enrichment. Omitting the brief is a checks-only diagnostic, not a second Factory Run mode. Manual CLI invocations are outside the server's execution lock.

## Ownership, isolation, accounting and learning

One server-side execution owner rejects overlapping runs and uncertain cleanup, including old release receipts. Workflow preparation uses the existing summary-preparation owner, not a second scheduler. Explicit preparation requests have durable request IDs; repeating an attempted request cannot make another provider call. Failed raw output and accounting remain retained.

The host owns Pi, credentials, sources, accounting and Docker control. An explicit empty resource loader disables executable project extensions, MCP/codemode, skills and templates. Repository instructions may be read as data. Workers are non-root with read-only roots, dropped capabilities, seccomp, no host checkout/socket mounts, and CPU/memory/PID limits. Engineering workers use 2 CPUs, 4 GiB RAM, 512 PIDs and 1 GiB temporary storage. Workers and fresh verification containers use ordinary Docker bridge networking. There is no application network filter, broker, proxy, custom client, domain allowlist or HTTP-method restriction. Network reachability follows the Docker/host configuration; Draken does not block LAN/private destinations or strip request headers. Provider credentials remain on the host and are not supplied to the worker. Rootless containers share the host kernel and have no volume disk quota; host Pi/adapters remain trusted code.

Execution requests are durably reserved through `session.agent.streamFunction`, reconciled with returned usage, and stopped on unknown accounting. Explicit unknown usage is never displayed as zero. A settled assistant alone does not establish completion. Runs have a 15-minute deadline; bash has a 240-second maximum, process-group cancellation and 1 MB output limit, returning the final 40,000 characters. File tools support regular text files up to 1 MB and reject traversal/outside symlinks. Cancellation stops the actual task container before patch collection. Failed collection retains the volume; uncertain cleanup blocks starts.

Private `factory-workspaces/<run>/` receipts retain request/exit files, baseline/events, the reused enrichment, session/accounting/result, patch, verification and cleanup. Legacy `factory-runs/` receipts remain retained without an execution API/UI. Discovery-authorized sessions are saved under the normal Pi source root in `draken-factory/` with the actual repository identity. Normal consent, activity windows, exclusions and verified preparation control ingestion. Host verification is separate; no automatic success labels are inserted into learning.

## Network access

Use normal commands: `npm`, `curl`, `git`, Node `fetch`, or another installed client. No special network interface is required. The broker and custom network helper have been deleted, and npm uses its ordinary configuration. Outbound access can transmit repository data and reach services available to the container; container filesystem isolation is not network isolation. Network access does not itself authorize publication or deployment.

Host policy is now `factory-host-policy-v3`. Older enrichments referring to the removed broker require preparation under the current policy. Failed runs and their receipts remain unchanged; deployment does not rerun them.

## Code and validation

- `src/factory-enrichment/`: independent reusable enrichment and execution contracts; no application/package/Node imports. Copied-module compile/run and dependency checks remain in CI.
- `src/factory/discovery.ts`, `enrichment.ts`: verified source identity, persisted preparation attempts and current saved-enrichment reads.
- `src/sync/summary-preparation.ts`: existing accounting/cancellation owner for automatic and explicit workflow preparation.
- `src/factory/workspace.ts`, `execution-owner.ts`: source-sensitive Run/read/log operations and execution ownership.
- `scripts/factory-workspace/`: execution-only Pi adapter, source/enrichment authorization, container tools and worker.

Tests cover automatic preparation using the final model and shared allowance, explicit retries/idempotency without resetting learning errors, raw failure retention, source revocation, missing/stale enrichment, unchanged reuse across tasks, page reads with no model calls, UI preparation/display/reuse and one execution prompt. Typechecks and Knip check for unused imports/exports/files; the old per-run enrichment prompt and tool-switching path have been removed.

Opt-in real-Docker tests use deterministic responses to prove lifecycle, ordinary networking, file/tool isolation, protected-check rejection, fresh verification, cancellation and patch recovery. The actual SDK 1.4.0 contract test uses simulated transport/container operations to prove one execution prompt, saved-enrichment reuse, tool continuations and reconciled usage. These are not model-quality proofs. Real container checks exercise ordinary npm lookup/install/audit, curl against GitHub and the deployment website, and git ls-remote. An owned test server on the container's private interface verifies that ordinary HTTP write methods and caller-supplied headers work without an application filter. Broker-only tests were removed with the broker.

Earlier paid Luna parser-repair and fixed-release receipts remain historical, not evidence for the current lifecycle or Astra task quality. The earlier six-call/$0.00073426 accounting correction remains retained. End-to-end endpoint verification, usable Git/credential setup for agent-executed delivery, automatic restart reconciliation, outcome-learning joins, SDK consolidation and packaged distribution remain unfinished. Delivery is not a request to implement a separate host-side executor for each action.
