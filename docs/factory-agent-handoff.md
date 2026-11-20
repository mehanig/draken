# Review: one Pi session executes the whole workflow

Status: agreed target design, not implemented. Reviewed the complete `master...8e5add0` PR diff (40 files), the architecture report and learning plan in `../software-factory-approach-draken/`, and the installed Pi 1.4.0 SDK, RPC, extension and isolation documentation plus the remote-tool example.

## Where execution currently goes

| Path | Actual handoff | Problem for agent-driven work |
|---|---|---|
| Release workflow | `scripts/factory-release-example.cjs:81–82` passes `RunnerHost.invoke` to `DockerExecutor.invoke`. | A generated binding selects a fixed implementation, not an agent task. |
| Container stage | `src/factory/docker.ts:103–109` starts `node /factory/stage.cjs` and sends `{ capability, invocation }` through stdin. | `scripts/factory-container/stage.cjs` is a host-authored registry/install/audit/release switch. |
| Repository workspace | `src/factory/workspace.ts:77` starts the workspace CLI with repository, ref and output directory. `scripts/factory-workspace.cjs:74` sends the snapshot and environment to the container. | There is no workflow ID, workflow revision or engineering objective in this request. |
| Workspace worker | `scripts/factory-workspace/worker.cjs:34` loops through `environment.setup` and `environment.checks`. | Running an environment recipe was incorrectly treated as the foundation's workflow executor. It is preparation/checking, not implementation. |
| Portable runner | `src/factory-enrichment/runner.ts:50` invokes every action binding separately. | Substituting a new Pi process for each invocation would create the wrong design: one session per step instead of one session per whole workflow. |

No workflow is embedded in the image. The image contains trusted helper code. Runtime requests select fixed stages or supply setup/check commands. The repository itself is transferred into a writable Docker volume at runtime.

## Required execution shape

```text
Verified workflow revision + concrete task + repository policy
                           |
                Host-owned Factory run
                           |
     Validate required environment file and approved base image
                           |
       Create exact-commit checkout; prepare and record baseline
                           |
          ONE persistent Pi session ON THE HOST
          - whole workflow and task as its brief
          - model requests and private session history
          - iterative inspection, edits, tests and repair
                           |
             trusted container tool adapter
                           |
          ONE persistent Docker task workspace
          - file reads/writes/edits
          - searches and directory listing
          - shell commands, builds and tests
                           |
             stop agent tools; freeze candidate
                           |
      host-owned verification, patch collection and result
```

One session means one conversation for the complete workflow, potentially containing many model calls and tool operations. Do not restart it at each workflow step. No subagents, parallel step sessions or automatic task decomposition in this version. Host checks and patch collection need no additional AI session.

## Pi on the host, tools in the container

Use an owned Pi subprocess on the host, controlled through RPC, with a trusted tool adapter. An SDK runner in a separate subprocess is an alternative if required by the selected runtime's supported interfaces; do not embed a freely configured Pi agent in the HTTP server.

Pi provides `createReadTool`, `createWriteTool`, `createEditTool` and `createBashTool` with replaceable operation interfaces. Its `examples/extensions/ssh.ts` demonstrates that division. Adapt the operation interfaces to the owned Docker container; do not copy the example's local fallback or its string-replacement path mapping.

- Keep the actual project files in the container volume. Do not bind-mount the developer checkout or mount Docker's volume data directory into host Pi.
- Use a trusted helper through `docker exec -i` or an equivalent owned transport. Send paths, file contents and operation arguments as structured data, not interpolated host shell commands. Model-generated shell text is interpreted only by a shell inside the container.
- Route **all enabled** coding tools into the container, including `bash`, `grep`, `find` and `ls` if exposed. Filesystem redirection alone leaves a host execution hole. Missing adapters or unavailable containers must fail, never fall back locally.
- Resolve tool paths in the container namespace. Test absolute paths, `..`, symlinks, new-file parents and filenames containing shell syntax. Host spool/output files must not accidentally become model-accessible host paths; retained tool output must be readable through the same container-backed interface.
- Disable unapproved extensions, MCP, codemode and executable project resources. Start from a private host control directory with explicitly configured resources. Do not start ordinary Pi in the user's checkout and assume its default tools are isolated.
- Supply repository instructions as data read through the container adapter. Repository `.pi` configuration must not load executable code into host Pi. Provider credentials and host environment variables must not be forwarded into tool commands.
- Treat the Pi runtime and trusted adapter as part of the host's trusted code. This is tool-execution isolation, not OS isolation of the Pi process. Rootless containers still share the kernel.

The installed documentation is 1.4.0 while Draken's managed runtime has a separate pin. Qualify the exact chosen runtime and tool overrides with contract tests before enabling paid runs.

## What the session receives

A frozen brief must contain the concrete task and requested endpoint, complete workflow revision and ordered steps, applicability/limitations, repository identity and base commit, allowed effects, deadlines and invocation allowance, plus host-selected check requirements. Historical evidence stays distinct from task instructions and operating authority.

The environment declaration is a prerequisite, **not the workflow**. `.draken/environment.json` remains mandatory. Missing files stop before model work or Docker; no automatic image discovery or environment proposal returns.

The existing enrichment format requires per-step capability bindings. Add an explicitly versioned whole-workflow execution contract rather than fabricating a one-step discovery, dropping historical steps, bypassing current validation, or opening a Pi session for each existing binding. Keep the fixed release profile as an accurately labeled previous proof; do not count it as agent-driven execution.

## Ownership and completion

- Reuse the existing verified discovery/evidence boundary, authorization, invocation accounting, durable events, cancellation and Docker policy. Pi/Docker I/O stays outside the portable module.
- Use one exclusive engineering-run owner. The current release and workspace supervisors have separate active maps; their individual checks do not provide a shared single-session limit.
- Record the Pi session ID/path, workflow and policy revisions, workspace identity and repository identity before prompting. Persist the full session privately, not just streamed command output or the final answer.
- Account for every provider request, including compaction and any explicitly permitted retry. The current one-call enrichment worker and workspace `modelCalls: 0` are not adequate session accounting. Disable unaccounted automatic retries; stop if usage cannot be reconciled.
- On cancellation, reject new tool requests, clear queued prompts, abort Pi, stop container processes, await cleanup and retain completed changes. Killing a `docker exec` client alone does not prove the command stopped.
- `agent_settled` or a final 'done' message means the session stopped, not that the task passed. Freeze the candidate and run host-owned checks against it. Keep patch collection distinct from independent acceptance verification.
- Keep the selected environment/check policy immutable for this run even if the agent edits repository files. The agent cannot approve its own weaker endpoint checks, publication rights or larger allowance.
- Link the session to the actual repository identity rather than grouping every container's `/workspace/repo` as one repository. Make it eligible for normal consent-based history ingestion and summarization; do not automatically mark it included, successful or reviewed. Keep verified outcome receipts separate from assistant claims.

## Focused implementation and proof

1. Refactor the existing workspace lifetime into prepare, ready-for-tools, stop and collect phases. Keep one workspace alive throughout the session.
2. Implement the container-backed Pi tool operations and prove no host file/command fallback, including resource auto-loading, cancellation and concurrent tool-call behavior. Serialize mutations for this first version.
3. Pass the selected workflow and task into one accounted host Pi session. Connect the existing Factory Run action to it rather than adding another independent execution page/path.
4. Retain transcript, usage and exact candidate; verify from the frozen host policy and show a truthful result.
5. Demonstrate one genuine workflow where the model inspects code, edits it, encounters a failing check, repairs it and passes final verification. Prove host files remain unchanged and cancellation retains the patch. Report actual calls/costs and failures.

This review changes the design and implementation plan only. No host-Pi/container-tool session has been implemented or run by this review.
