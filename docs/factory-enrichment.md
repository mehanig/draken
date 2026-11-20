# Factory: real model enrichment and Docker execution

Discovery records how work was done. Enrichment uses an LLM to map that procedure to Factory capabilities and a repository policy. Execution consumes the resulting revision; it does not execute historical text or model-generated shell commands.

This implementation is on the Factory enrichment branch, not in the published 0.10.0 package. Factory page reads still start no work.

## Real test in Draken

The existing release-verification discovery was supplied to **`openai/gpt-6-luna`**, together with the capability catalog and policy. No step-to-action bindings were supplied. The model returned:

```json
{"bindings":[
  {"step":1,"action":"registry","verify":"check-registry"},
  {"step":2,"action":"install","verify":"check-install"},
  {"step":3,"action":"audit","verify":"check-audit"},
  {"step":4,"action":"release","verify":"check-release"}
]}
```

These exact bindings were validated and executed against **Draken 0.10.0**, without intermediate prompts or manual edits.

| Result | Observed |
|---|---|
| Enrichment | One real Luna call for the final revision; 1,991 input and 63 output tokens |
| Estimated model cost | $0.0002306, retained through shared `modelCall` accounting |
| Stage execution | 11 distinct Docker containers, including input/preparation/final checks |
| npm | Requested version is latest, with integrity and provenance metadata |
| Package | Temporary installation, matching CLI version and selected production files |
| Production audit | Zero vulnerabilities |
| Release/deployment | Successful GitHub workflows for the release tag commit |
| Live website | HTTP 200 and version 0.10.0 |
| Cleanup | No run containers, networks or artifact volumes retained |

Four short-lived network brokers were also used; they are not counted as workflow stages. The final run used rootless Docker 29.10.0. Three real enrichment calls across development revisions cost an estimated **$0.0006941 total**. Two earlier full runs passed. The final revision's first execution stopped after audit when a fresh Factory source request failed with `fetch failed`; it did not continue without source validation. An explicit new execution reused that unchanged model-generated plan and passed all eleven stages with **zero additional model calls**. Reuse checks the fresh source, exact policy and reconstructed original model output; it does not supply new bindings. A reuse argument-order bug was also caught and fixed before any stages ran. Failed attempts and receipts remain separate. Repeating this single case is not an independent accuracy evaluation.

Package lifecycle scripts are disabled. This verifies package contents and the CLI version, **not full application startup or native-addon installation**. No merge, tag, publication or deployment operation exists in this profile.

The previous zero-model-call experiment was a hand-configured harness baseline. It is superseded by this real model-enriched example, not relabeled as an LLM result.

## Browser execution

The Factory page now connects to this host. The approved proposal shows a release-version input, **Run**, its generated plan, stage progress, saved results and **Cancel run**. **Generate a new plan (1 model call)** is an explicit option, not something refresh does.

Enable the profile on the server with `DRAKEN_FACTORY_PROPOSAL_ID`, `DRAKEN_DOCKER_BIN`, `DRAKEN_DOCKER_HOST`, `DRAKEN_FACTORY_IMAGE` and explicit `DRAKEN_PI_BIN`. An optional `DRAKEN_FACTORY_PLAN_DIR` points to an existing real model-enrichment run. This integration requires the source checkout and authenticated API; it is not enabled by default in published installations. The proposal must belong to the checkout and the profile only verifies Draken releases.

The authenticated execution API accepts a version, a request UUID and the decision to regenerate—not commands, Docker settings or filesystem paths. Reads verify source access and return saved state only. A browser disconnect does not cancel an accepted job. Explicit cancellation stops its controller and Docker containers; server shutdown waits for cleanup. Only one job can run at a time. An interrupted job with no cleanup confirmation blocks further execution rather than being replayed.

`src/factory/execution.ts` supervises the existing tested CLI pipeline. Requests, plans, events, receipts and process exits persist under the private data directory's `factory-runs/`. Repeated request UUIDs do not create another paid call. Per-run model accounting remains in the pipeline's private one-call store and is shown in Factory; it is not presented as part of ordinary summary-preparation accounting.

The live browser was tested for cancellation, saved-plan execution and fresh enrichment. The fresh UI run made one Luna call (2,005 input / 63 output tokens, estimated $0.000232) and passed all eleven stages. Desktop and 390px layouts were checked. No intermediate approval prompts were needed.

## Implementation

- `src/factory-enrichment/`: portable enrichment contracts, model prompt/compiler and serial execution loop. No imports outside the folder.
- `src/factory/enrichment.ts`: source-verified Factory adapter, plus `enrichFactoryWithModel` calling the application's real `modelCall` with an existing run owner and invocation allowance.
- `src/factory/docker.ts`: fresh-container execution and cleanup. Missing Docker is an error, never a host-execution fallback.
- `scripts/factory-enrichment-model.cjs`: explicit test worker using the same `modelCall` accounting in a private one-call store. It preserves raw output, usage and failed attempts; it does not restart the live paused learning job.
- `scripts/factory-release-example.cjs`: verified discovery → real model enrichment → validation → Docker execution → final verification.
- `scripts/factory-container/`: pinned image, registered stage implementations and restricted network broker.

The model supplies bindings, not permissions. Host policy fixes applicability checks, environment preparation and endpoint verification. Verifiers explicitly list supported actions. Unknown capabilities, weaker lifecycle checks or incomplete mappings are rejected; no bindings are silently filled in after inference.

Source access and identity are rechecked before and after inference and execution boundaries. The example requires the discovery to belong to this Draken checkout, rather than adopting an arbitrary source repository as its target. Historical limitations remain attached to the discovery; a successful new run does not retroactively verify old outcomes.

## Container boundaries

Every capability runs in a new container, including verification. The executor requires a local rootless Docker engine with the built-in seccomp profile and CPU, memory and PID enforcement.

- Pinned image ID; UID/GID **65532**.
- Read-only root filesystem, all Linux capabilities dropped, no-new-privileges.
- **1 CPU, 768 MiB memory, 128 processes**, 256 MiB temporary filesystem and 8 MiB container log limit.
- No host bind mounts: no repository checkout, home directory, provider credentials or Docker socket inside workers.
- Actions write their own Docker artifact volume. Later stages receive only declared dependencies, mounted read-only. Failed actions do not promote artifacts.
- Checks have no network. Network actions use an internal Docker network and their own broker with approved hosts.
- The broker allows HTTPS reads and the two npm audit POST endpoints. It rejects publication methods, redirects, private/link-local addresses and arbitrary CONNECT tunnels. DNS is checked, then the selected IP, TLS server name and HTTP Host are fixed together. Workers cannot use a tunnel to bypass hostname restrictions.
- Cancellation removes the container and its child processes; killing the Docker CLI alone is insufficient. Completion is not reported until cleanup succeeds.

These are **rootless Docker containers, not Docker Sandboxes microVMs**. They share the host kernel. Artifact volumes do not yet have size quotas, so this is a trusted registered-stage host—not a claim that arbitrary adversarial coding agents or repositories are production-safe.

The model call itself is a tool-free control-plane operation using the configured Draken provider. Credentials stay on that control plane and are never placed in workflow containers.

## Validation

- 802 automated tests, 72 browser tests, typechecks and unused-code checks passed. Factory browser tests cover explicit execution, cancellation, generation consent, read-only refresh and source-access failure.
- Existing standalone copy/compile/run and pure public-contract tests remain in normal CI.
- New tests cover owner invocation limits, container arguments, absence of host fallback, artifact dependencies, network policy and cleanup.
- `tests/factory-docker-live.cjs` was also run against real rootless Docker. It confirmed non-root execution, read-only root and previous-stage artifacts, absence of the Docker socket/credentials, permitted registry access, denied unapproved/metadata/direct egress, and removal of a running container on cancellation.

The real-Docker proof is an explicit operator test, not a mocked result or a claim that the ordinary CI runner provisions rootless Docker. Provider-model quality still needs more independent cases.

## Reproduce

Use a POSIX checkout and rootless Docker with a delegated cgroup. Build the trusted stage image before paying for enrichment:

```sh
npm run build:server
export DRAKEN_DOCKER_BIN=/path/to/docker
export DRAKEN_DOCKER_HOST=unix:///path/to/rootless-docker.sock
"$DRAKEN_DOCKER_BIN" --host "$DRAKEN_DOCKER_HOST" build \
  -t draken-factory-stage:local scripts/factory-container
export DRAKEN_FACTORY_IMAGE=$("$DRAKEN_DOCKER_BIN" --host "$DRAKEN_DOCKER_HOST" \
  image inspect draken-factory-stage:local --format '{{.Id}}')
node tests/factory-docker-live.cjs
```

Select the release-verification proposal from the authenticated Factory API. Configure the same summary model and explicit Pi executable/auth directory used by your Draken installation. The isolated operator worker requires explicit `DRAKEN_PI_BIN`; it never substitutes a different runtime when private accounting storage has no Pi installation. The application adapter uses its existing owner and normal managed/external provider selection.

```sh
# Supply the API token privately; do not paste credentials into a transcript.
export DRAKEN_FACTORY_TOKEN DRAKEN_PI_BIN PI_CODING_AGENT_DIR DRAKEN_PI_SUMMARY_MODEL
node scripts/factory-release-example.cjs \
  http://127.0.0.1:PORT PROPOSAL_ID 0.10.0 /private/new-run-directory
```

Docker preflight happens before the model call. Each new test directory permits one call, with no automatic retry or manual binding fallback. An optional fifth argument supplies an earlier run directory to reuse its unchanged model-generated enrichment; this makes no new model call and still performs fresh source/policy checks. Raw model input/output, accounting, the enriched revision, effective container settings, stage receipts and final result are retained privately. Exported snapshots cannot enforce future source revocation; do not publish raw stores or transcripts.

## Still separate work

Automatic background enrichment needs approved repository policies and separately persisted revisions wired into the existing preparation owner. Factory task submission is connected through the browser. Automatic queue/restart recovery and a general coding-agent capability are not implemented here. The current test proves real LLM enrichment and containerized execution for one release-verification procedure—not an unattended general-purpose coding factory.
