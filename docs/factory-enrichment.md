# Factory enrichment: first executable slice

Discovery and automation are separate:

1. **Discovery** records how work was done, its applicability, source identity and limitations.
2. **Enrichment** binds that procedure to Factory capabilities and a repository-specific operating policy.
3. **Execution** runs the enriched revision, verifies the result and records what happened.

This is a prototype on top of 0.10.0, not a newly published release. It does not add buttons or explanations to Factory, start background jobs, clear the existing preparation failure, or automatically execute newly discovered work.

## Implemented

`src/factory-enrichment/index.ts` is the public contract. The folder has no imports outside itself. It compiles and runs when copied away from Draken with injected hosts.

- `enrich` keeps the discovered method and limitations intact. Its separate configuration binds each discovered step to an action and its verifier, with an optional repair handler. Missing capabilities or steps produce a non-executable result.
- `proposeEnrichment` supplies a model with the discovery, capabilities and policy. The caller supplies the already-accounted model callback and fresh dependency checks. There is no provider client, automatic retry or separate model allowance. This interface has controlled tests; the example below does **not** evaluate a real model's mapping quality.
- The host policy fixes input validation, environment preparation and endpoint verification. A model cannot replace those checks with easier ones. Verifiers and repair handlers explicitly list which actions they support.
- `runWorkflow` validates inputs, prepares the environment, executes and verifies every step, optionally repairs and retries repeatable actions, then verifies the endpoint. No intermediate human action is required.
- The host owns source/permission checks, repository identity, current policy, registered tool handlers, exclusive task claims and durable event recording. Authorization is checked before and after capabilities, including again after recording a request and before invocation.
- Failed checks stop the run. Unknown action outcomes are not automatically replayed. Actions marked non-repeatable cannot have repair/replay loops. The policy permits at most three attempts per step and a run deadline of at most ten minutes.
- Cancellation reaches the capability host; late results are rejected. Hosts must stop their subprocesses themselves. This is not an operating-system sandbox or a production worker supervisor.

`src/factory/enrichment.ts` adapts existing verified Factory proposals. Explicit model enrichment reuses `readWorkflowComparison`, including uncited and unselected source dependencies. It introduces no alternative transcript-search path. Factory GET remains read-only.

`ready` means the supplied configuration is structurally complete. It is **not** certification of semantic correctness, a claim that historical tasks succeeded, or authority to act outside the host's current policy. Capability descriptions and model bindings still need quality evaluation. Credentials belong in the host, never in task inputs, model payloads or journals.

## Real example: verify the published Draken 0.10.0 release

Input: the existing Factory proposal learned from earlier release history:

1. Check the registry’s latest version for the target release.
2. Fresh-install the published package without development dependencies and verify its version and selected contents.
3. Request a production dependency audit.
4. Check the release or deployment workflow status and wait for it to finish when it is in progress.

This discovery had missing initiating requests and incomplete historical outcomes. Enrichment retains those limitations; a new successful run does not retroactively verify the old releases.

### What Factory added

- Explicit task parameters: package `draken`, repository `mehanig/draken`, version `0.10.0`.
- A policy pinned to the selected discovery revision and repository location, with **no merge, tag, publication or deployment capabilities**.
- A temporary installation environment without developer credentials. Package lifecycle scripts are disabled. Only the installed CLI's version command is executed. This checks package contents and CLI version, not full application startup or native-addon installation.
- Registered actions for registry reads, installation, auditing, and release/website checks. Historical text is never executed as shell code.
- Separate checks for version/integrity/provenance, installed contents and CLI output, zero production audit findings, successful GitHub workflows for the release's exact tag commit, and matching live website copy.
- Workflow polling up to twenty times, three seconds apart, when matching jobs are still running.
- A final check requiring all four verification checks to pass.
- Private, durable policy, enriched-plan, event and result files. The temporary install is removed after the run.

### Observed result

The operator example completed without intermediate prompts:

| Check | Result |
|---|---|
| npm latest | `0.10.0` |
| Fresh installed CLI | `draken 0.10.0` |
| Production dependency vulnerabilities | `0` |
| Release workflow | Successful, matching the release tag commit |
| Website workflow | Successful, matching the release tag commit |
| Live website | HTTP 200, version 0.10.0 |

The run used eleven capability invocations and zero model calls. The action bindings in this example are **explicit operator configuration**, not newly model-discovered bindings. This proves an actual execution/verification path over a real discovered procedure and a new release task; it is not evidence of general autonomous coding or model-planning accuracy. Repair, cancellation, permission changes and failed verification are covered by controlled tests, not claimed as events in this successful release-verification run.

The public execution evidence includes [the release run](https://github.com/mehanig/draken/actions/runs/44728074019), [the website run](https://github.com/mehanig/draken/actions/runs/44729350213), and [the release](https://github.com/mehanig/draken/releases/tag/v0.10.0). Original histories and private run artifacts are not published.

### Running the operator example

On a POSIX host, build the checkout, select the actual release-verification proposal from the authenticated Factory API, and inspect its method before configuring these four bindings. Supply its ID and exact revision from `discoveryFromProposal`; a different revision is rejected.

```sh
npm run build:server
# Supply credentials through your environment; do not paste them into a transcript.
export DRAKEN_FACTORY_TOKEN
export DRAKEN_FACTORY_DISCOVERY_REVISION
node scripts/factory-release-example.cjs \
  http://127.0.0.1:PORT PROPOSAL_ID 0.10.0 /private/new-run-directory
```

The example is specifically configured for Draken release verification, not an automatic router for arbitrary four-step procedures. Its scripts and receipts are local operator tooling, not new server endpoints. Use a new output directory; existing run records are not overwritten or resumed. Private snapshots cannot enforce future source revocation once exported; do not publish them as permanently permission-checked evidence.

## Remaining integration

- Wire model enrichment into the existing preparation owner and invocation accounting, with separately persisted enrichment revisions. Do not infer from page reads or silently retry the stopped learning job.
- Evaluate model-generated bindings against approved capability catalogs; an API accepting a model callback is not a completed automatic-enrichment rollout.
- Add a coding-agent capability host with real workspace isolation, command/network permissions, a durable task queue and process supervision. A worktree alone is not a sandbox.
- Select applicable workflows for new tasks, retain execution records through the normal learning path, and propose updates without rewriting running revisions.

The next proof should use model-generated bindings and a coding task with a real failed check and successful repair, while keeping the discovery/enrichment distinction intact.
