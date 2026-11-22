# Factory: saved workflows, one execution session

See [the Factory plan](factory-plan.md) for the product design. Discover → enrich during preparation → save → display → run the selected workflow. Opening Factory starts no model calls. Run uses saved guidance, concrete workflow-defined inputs and the selected repository ref; it does not regenerate enrichment.

## Execution

The host creates a Docker workspace from the selected committed revision and its reachable Git history. Dirty/untracked host files, host Git configuration, hooks and credentials are not copied. Committed filenames are not filtered. Submodules and LFS declarations are not rejected: the workflow can initialize/fetch their content using ordinary Git tools, its configured remote and credentials.

The committed `.draken/environment.json` chooses an approved pinned image, optional setup commands and optional suggested checks. Setup runs before the agent. **Checks, review, repair and delivery belong to the workflow**, not a fixed host-side baseline/patch-verification sequence. The agent receives the suggested checks and decides how they apply. Required checks must precede dependent delivery actions.

One host-side Pi session executes the complete user-approved workflow. Its read/write/edit/bash tools run inside the container, with no host fallback. Any repository file may be edited, including tests, manifests, scripts and CI. Ordinary Git, HTTP, npm and other installed clients can push, create PRs, publish or deploy when those actions belong to the selected workflow. No action catalog or special PR/release executor exists.

The container uses normal Docker bridge networking, without application domain, destination or HTTP-method filters. Rootless Docker, non-root/read-only container roots, dropped capabilities and CPU/memory/PID limits remain. The repository volume and temporary directory are writable; host files and the Docker socket are not mounted. Containers share the host kernel and volumes have no disk quota. Network access can transmit repository data and reach services available through Docker.

## Host configuration

- `DRAKEN_WORKSPACE_REPO`: the Git repository available for runs.
- `DRAKEN_DOCKER_BIN`, `DRAKEN_DOCKER_HOST`: Docker CLI and local rootless socket.
- `DRAKEN_WORKSPACE_ALLOWED_IMAGES`: JSON array of approved digest-pinned images.
- `DRAKEN_FACTORY_PI_SDK`: qualified Pi SDK 1.4.0 `dist/index.js`.
- `DRAKEN_WORKSPACE_REMOTE`: optional remote URL to configure as `origin` inside the workspace. Use a credential-free URL. Host Git configuration is not copied.
- `DRAKEN_WORKSPACE_ENV_FILE`: optional private Docker-format environment file, explicitly supplied to the task container. Use it for workflow credentials and configuration, such as `GH_TOKEN`, registry settings or Git identity. Bash inherits the container environment. The host's ambient environment and Pi provider credentials are not automatically forwarded. Container inspection receipts omit environment values. Tools can use these credentials, so supply only credentials appropriate to the approved work; do not print them in command output.
- Model selection uses the normal final model: `DRAKEN_PI_FINAL_MODEL`, then `DRAKEN_PI_MODEL`, then `openai/gpt-6-astra`.

The environment file remains required on the selected commit. Missing tools or credentials are specific prerequisites to report, not unsupported Factory action types. No automatic image inference or credential discovery occurs. The execution scripts are included in the package file list; execution still requires the above configuration and an installed qualified SDK.

## Results and ownership

The agent records checks and external outcome evidence in its session and reports `completed` or `blocked`. A missing PR, publication or other required endpoint is not completion merely because local tests pass. Same-session review is self-review, not independent review. A blocked result remains blocked in the run and stage display.

After execution/cancellation, the supervisor stops the task container and collects a binary patch using fresh Git metadata and a read-only mount. This preserves committed and uncommitted task edits relative to the starting commit; it is a receipt, not a second acceptance stage. There is no protected-filename rejection or automatic post-session verifier. External actions already performed are not undone by cancellation, and unknown outcomes must be inspected before retrying them.

Source consent/revocation is checked before model/tool work and before serving saved source-derived content. Requests are durable and idempotent. One execution owner prevents overlapping runs and blocks starts when cleanup is uncertain; legacy receipts remain retained. Cancellation stops actual container processes. Failed collection retains the volume for inspection.

Provider requests are reserved durably and reconciled with usage; unknown usage is not zero. Automatic retries, compaction and cache warming are disabled. Execution settings set the call allowance once (1–64, initially 16), frozen per run. The existing 15-minute overall deadline, four-minute command maximum, output/file limits and resource limits remain. Preparation has separate accounting; no background learning error is cleared implicitly.

## Preparation and compatibility

Saved enrichment belongs to the discovery revision, host-policy version and prompt revision. Host policy v4 removes the old publication/file bans and fixed checking sequence. Prior enrichment must be explicitly prepared under the current policy; old rows and failed paid attempts remain intact. Run never silently refreshes enrichment or reruns an earlier execution.

Normal preparation and explicit enrichment use the existing owner, source checks and accounted model callback. Discovery observations and model-added guidance remain separate. Real execution sessions can enter normal history ingestion only under ordinary source consent; agent claims are not automatically verified outcomes.

## Implementation and tests

- `src/factory-enrichment/`: portable contracts, saved guidance validation and task binding.
- `src/factory/`: discovery/enrichment persistence, source checks, run settings and ownership.
- `scripts/factory-workspace.cjs`: snapshot, setup, one agent session, patch collection and cleanup.
- `scripts/factory-workspace/agent.cjs`: Pi tools, session and accounting; `tool.cjs`: container operations; `worker.cjs`: checkout/setup and patch collection.

The former checks-only CLI, baseline/fresh-verification runner, filename classifier and snapshot file-type bans have been removed. Tests cover ordinary networking, configured environment propagation without ambient host secrets, Git history/remote setup, edits to formerly forbidden files, blocked outcomes, source checks, accounting, cancellation and patch retention. Actual SDK protocol tests use simulated responses; Docker fixtures establish runtime mechanics, not real model task quality. Claim an external endpoint only when a real run supplies its evidence.
