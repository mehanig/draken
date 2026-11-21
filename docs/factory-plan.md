# Factory: authoritative implementation plan

This is the current product and architecture plan. It replaces the conflicting proposals and implementation updates formerly mixed together in `../software-factory-approach-draken/`. Those documents are preserved in that folder's `archive/` as research and history, not implementation instructions.

**Read this before changing Factory.** Follow explicit user decisions. If a proposed implementation would change these requirements, identify the conflict and ask before building it. Existing code, old tests, research recommendations and previous assistant-written status reports do not override the intended design. A limitation in today's implementation is not automatically a product requirement.

## 1. Product goal

Discover repository-specific workflows from permitted history, enrich them into reusable execution instructions, and let an agent carry out the selected workflow to its actual endpoint with minimal human coordination.

**The workflow defines the work. Factory supplies a general execution environment.**

PR creation, pushing, merging, reviewing, publishing, deploying, checking CI and inspecting a live website are ordinary workflow steps when included in the authorized task. They are not separate Factory features that each need a new executor, service, tool binding or host-side action adapter. The agent uses ordinary installed tools and APIs to perform them.

For example, a discovered workflow ending in a review-ready PR must not be silently reduced to a local patch. A workflow ending in local preview must not be expanded into publication. Preserve the requested endpoint in both directions.

## 2. Required lifecycle

```text
Permitted history
  → discover repository-specific workflow and its endpoint
  → enrich during preparation
  → persist enriched workflow and its concrete input definitions
  → display saved workflow in Factory
  → user selects it, supplies its inputs and repository ref, and clicks Run
  → ONE host-side Pi session executes the complete workflow through Docker tools
  → record actual results, checks, external outcomes and unresolved blockers
```

- Discovery records what the evidence supports, including gaps and failures.
- Enrichment adds reusable instructions for preparation, execution, checks, review, repair, completion and recovery. Preserve historical observations separately from model-added guidance.
- Enrichment keeps the workflow's intended endpoint, including external actions. Do not remove those actions because an earlier prototype could not perform them.
- Save enrichment during preparation; reuse it across runs. Execution-time planning adapts to current repository state without regenerating the workflow.
- Run collects only saved workflow-defined inputs plus the ref. No generic task/prompt box. No extra fields when the workflow needs none.
- Opening or refreshing Factory does not trigger inference, execution or retries.
- Preparation and execution use the configured final model and normal accounting. The execution allowance is configured once in Execution settings and frozen for each new run.

## 3. Responsibility split

| Part | Owns | Does not own |
|---|---|---|
| Discovery | Historical procedure, applicability, source support, qualifications and endpoint | Inventing successful outcomes or execution permission |
| Enrichment | Reusable steps, inputs, checks, review, repair and completion evidence | Per-action executable bindings or invented credentials |
| Pi execution session | Inspecting current state, choosing commands, completing all applicable steps, checking outcomes and reporting blockers | Changing its authorized scope or claiming success without evidence |
| Host | Workspace/process lifecycle, tools, configured credentials, source permissions, accounting, cancellation, records and repository verification | Reimplementing each workflow action as product code |
| Factory UI | Saved workflows, required inputs, execution settings, Run, progress, results and actionable failures | A second workflow planner or per-action execution architecture |

### One session, ordinary tools

One persistent Pi session owns the entire execution, including inspection, implementation, testing, review, repair and delivery steps. Do not introduce one session per step, subagents or parallel agents as a workaround. Preparation is separate from that execution session.

Pi runs on the host; its file and shell tools operate inside the Docker workspace. No host-tool fallback. Ordinary `git`, `gh`, `npm`, `curl` and language clients should be usable when installed in the chosen environment. Do not add custom PR/publish/deploy tools merely to wrap commands the agent can already run.

Review belongs in the workflow too. Review by the same session is self-review, not independent review. Existing external review or CI can be used when the workflow calls for it; do not invent an independent reviewer or silently add another agent.

### Normal networking

Use ordinary Docker bridge networking. Do not add a broker, custom network client, domain allowlist, destination filter, method restriction or credential-header stripping. Network reachability follows the Docker/host configuration. Network access can reach private services and transmit repository data; do not describe filesystem isolation as network isolation.

### Environment and credentials

Keep the agreed committed `.draken/environment.json` requirement for image, setup and repository checks. It describes the environment, not the workflow. Do not infer a replacement environment or require model-generated environment proposals. A missing tool is an environment prerequisite, not a reason to create an action-specific Factory executor.

The selected workflow's stated endpoint and the user's run authorization determine the intended work, within actual user-configured permissions. Historical instructions alone are not authorization. Do not require repeated human approval merely to advance already-authorized steps. Ask only for a real unresolved decision, missing prerequisite or scope change.

Allow workflow tools to use explicitly configured credentials needed for the authorized task. Pi provider credentials remain on the host; do not confuse them with GitHub/npm/deployment credentials the workflow may need. Do not copy arbitrary host secrets, host Git configuration or the Docker socket into the worker. Use a general credential-provisioning mechanism rather than action-specific executors; if its scope or provisioning is undecided, ask instead of inventing a credential platform.

Missing authentication must be reported specifically, such as “GitHub credentials are not configured for this repository,” not “Factory does not support PR creation.” No blanket `publication: false`, “never push,” or “never publish” rule may override an authorized workflow endpoint.

Provide the authorized repository identity, remote, base/ref and sufficient Git context for the workflow. Excluding host secrets must not accidentally make a valid branch, push or PR impossible. Do not assume an isolated tree snapshot is sufficient for every Git operation.

## 4. Completion and verification

- Completion means reaching the selected workflow's endpoint, not merely ending the agent turn, collecting a patch or passing unrelated repository tests.
- Record actual commands/results and relevant evidence: for example, branch/commit identity, PR URL and state, published package version, deployment result or observed live behavior. These are examples of evidence, not a fixed catalog of supported actions.
- Enrichment defines task-relevant checks. The session executes them and evaluates their results. General host verification supplements that evidence; it does not need a new action-specific implementation for every endpoint.
- Preserve original host verification definitions and report their results honestly. Legitimate task edits to tests, scripts, manifests or CI are not inherently forbidden. Distinguish a necessary repository change from weakening a check to fake success; do not use blanket file-category bans as a substitute.
- Checks required before a delivery step must occur before it. Host checks run after delivery cannot be described as pre-delivery approval. Keep any required ordering within the complete workflow; do not replace delivery with patch-only completion to avoid solving ordering.
- Report completed, blocked, failed and cancelled outcomes accurately. Preserve reasons and partial results; do not turn an unmet endpoint into success because baseline checks passed.
- After an uncertain external action, inspect its state before repeating it. Do not silently rerun failed workflows or duplicate external side effects.

## 5. Existing responsibilities that remain

Preserve source consent and revocation checks, verification of original evidence, accounting including failed paid attempts and unknown usage, explicit cancellation, run identity, retained patches/results, and ownership checks when cleanup is uncertain. Keep the host checkout unchanged and tools inside the container. Retain the current explicit runtime/resource limits rather than quietly changing them during unrelated work.

Keep discovery and enrichment modules independent of host services. Integrate through their public contracts and retain standalone tests. Learning from execution must distinguish recorded outcomes from the agent's claims; do not retroactively turn incomplete historical evidence into proof of success.

These responsibilities are general execution support. They are not grounds to invent network restrictions, action catalogs or blanket delivery prohibitions.

## 6. Known implementation gaps — not target restrictions

At `6e93c1c`, this plan is **not fully implemented**. This documentation correction does not change runtime behavior.

| Current issue | Required correction |
|---|---|
| `src/factory-enrichment/session.ts` sets `publication: false`; enrichment and agent prompts prohibit publication | Remove blanket prohibitions and preserve the selected, authorized endpoint across contracts, prompts, saved guidance and tests |
| Broad protected-file checks reject edits to existing tests/scripts/manifests/CI | Audit against legitimate workflow needs; preserve trustworthy verification without excluding whole classes of engineering tasks |
| Snapshot excludes earlier history and host remotes/configuration | Determine the Git context needed for an authorized branch/push/PR and supply it without importing host secrets |
| Workflow authentication/tool availability is not demonstrated end to end | Establish the needed general environment/credential configuration; report missing prerequisites specifically, not as unsupported actions |
| Repository-check success and agent blocker reporting do not fully express workflow outcomes | Preserve the actual endpoint, evidence and blocked/failed/cancelled distinctions; inspect check/delivery ordering |
| Execution scripts are checkout-only; SDK selection and restart recovery have remaining work | Track these as host-runtime tasks, not reasons for per-action executors |

Ordinary Docker networking and preparation-time saved enrichment are already implemented. Do not rebuild those as new subsystems. Audit the complete active path before choosing the next changes; the table identifies known gaps, not proof that no others exist.

## 7. Required implementation review

Before coding, state which requirement the change serves and inspect the whole affected path: preparation prompt → saved contract → run configuration → agent instructions → tools/environment → validation → UI/result. Look for contradictory restrictions in every layer, not only the latest failing line.

For each proposed new module or restriction, answer:

1. Is this a general runtime need, or a workflow step the agent can execute with ordinary tools?
2. Does it preserve the selected endpoint and one-session lifecycle?
3. Is the restriction explicitly required by the user, or am I inventing a product decision?
4. Can the existing environment and interfaces do this without another execution path?

If the answer reveals a design change, ask before implementing it. Do not write an implementation choice into the plan afterward as if it were an agreed requirement. Keep historical reports separate; update the current plan only for actual decisions.

## 8. Acceptance evidence

| Case | Required result |
|---|---|
| Code change → review-ready PR | The same session changes code, runs relevant checks, reviews/repairs, pushes an authorized branch and creates the PR through normal tools. Record the actual PR and commit identity. No PR-specific Factory executor |
| Authorized release workflow | The same session follows the repository's release process, including publication/deployment when called for, and verifies the stated endpoint. No release-specific Factory executor |
| Local-preview-only workflow | Stops at preview; does not push, publish or deploy because another workflow did so |
| Missing credentials/tool | Reports the actual missing prerequisite without claiming completion or declaring the action categorically unsupported |
| Another ordinary tool/API step | Can be expressed in saved guidance and performed through existing tools without adding an action enum, binding compiler or new runner |
| Repeated run / page refresh | Run reuses saved enrichment; refresh starts no work. No accidental duplicate execution |
| Failed, cancelled or uncertain execution | Retains usage, evidence and partial work, reports the real state, and does not replay external actions blindly |

Unit tests, simulated SDK tests and Docker smoke tests establish their specific mechanics, not model-driven task completion. Before calling an endpoint supported end to end, demonstrate it with a real agent run against an explicitly authorized test target. Use disposable/test repositories or publication targets where appropriate; do not publish a real package just to satisfy a test without authorization. Report what was actually tested and what remains untested. Check callers and unused code, and remove obsolete paths rather than keeping parallel implementations.

**Success criterion:** a newly learned workflow can include ordinary engineering actions without Factory needing new action-specific code, and execution either reaches its authorized endpoint with evidence or reports the actual blocker.
