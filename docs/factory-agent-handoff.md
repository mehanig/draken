# One Pi session executes the whole workflow

Implemented in the Factory workspace path in draft PR #54. The earlier review identified that fixed release stages and repository setup/check commands were not a coding agent. Those paths remain available as checks; they are not counted as agent execution.

## Execution

1. Factory **Run** receives a selected, freshly verified workflow and a concrete task. `sessionPlan` freezes the complete workflow revision, repository identity, task and host policy as `factory-agent-session-v1`. It does not fabricate a one-step discovery or start agents per binding.
2. Require the committed `.draken/environment.json` before Docker or model work. The host separately approves the image. No environment inference or proposal is available.
3. Transfer the exact committed tree to a private Docker volume, run setup, and record baseline checks. A normal failing baseline is evidence for the agent, not a reason to abandon a repair task. Missing or unconfirmed command results stop the run.
4. Start **one persistent host Pi SDK session** in the owned workspace CLI subprocess. The HTTP server does not embed the agent. The session receives the complete workflow and task once and can inspect, edit, test and repair repeatedly.
5. Every enabled tool operates through structured `docker exec -i` requests inside **one persistent task container**. There are four tools: `read`, `write`, `edit`, and `bash`; listing and search use container bash. Mutations are serialized. There is no local fallback, host output-spool path, or parallel agent.
6. Stop all task-container processes. A fresh, network-disabled collector mounts the workspace read-only and exports a patch using pristine Git metadata.
7. Apply that patch to a fresh checkout in a separate verification volume. Run the original setup/check declarations again. Save the patch hash, check-definition hash, actual container configuration, results and usage separately from the agent's final statement.

`agent_settled` alone is insufficient. The agent must return a valid final status, all calls must have confirmed usage, source authority must still hold, and fresh verification must pass. An agent-reported blocker stops the run rather than turning an unrelated green test suite into success.

**Verification has a stated scope:** frozen repository checks. It is not a universal proof that an arbitrary natural-language task was fulfilled. The receipt explicitly does not infer task acceptance. Broader acceptance policies and PR/publication delivery remain unfinished. Nothing is applied to the host checkout or published.

## Host and container separation

- The host keeps provider credentials, session files, accounting and Docker supervision. No checkout bind mount, Docker socket, host environment or provider credential enters the task container.
- File operations validate container paths, reject traversal and outside/dangling symlinks, and require regular text files for reads. Files are limited to 1 MB. Model command text is interpreted only by container bash, never a host shell.
- Commands stop after at most four minutes. Output stops at 1 MB and returns at most its last 40,000 characters. The complete workspace run has a fifteen-minute deadline; cleanup and patch recovery still run after cancellation.
- Pi uses an explicit empty resource loader, in-memory settings, and exactly four replaced tools. Repository instructions may be read as data. Project extensions, MCP, codemode, skills, prompt templates and executable configuration are not auto-loaded. Compaction, cache warming and automatic retries are disabled.
- The initial policy allows npm registry reads/audits through the existing broker, not unrestricted Internet access. Unsupported workflow endpoints must be reported as blocked.
- Candidate changes to environment/CI policy, `package.json`/`package-lock.json`, declared command entrypoints and existing test/script files require explicit review rather than acceptance. New regression-test files can be added. These restrictions deliberately limit the initial repair profile.
- Pi and its trusted adapter still execute on the host. This is tool-execution isolation, not an OS sandbox for Pi. Containers share the kernel and volumes have no disk quotas.

## Runtime qualification and configuration

The integration explicitly qualifies **Pi SDK 1.4.0**. Draken's managed CLI pin is separate; a different SDK version is rejected, not silently substituted. In addition to the workspace configuration in [factory-workspaces.md](factory-workspaces.md), set on the server:

```sh
export DRAKEN_FACTORY_PI_SDK=/absolute/path/to/@earendil-works/pi-coding-agent/dist/index.js
# Factory uses defaultModels().final: the configured final summarization model.
export DRAKEN_PI_FINAL_MODEL=openai/gpt-6-astra
```

Factory shares the final summarization model selection (`DRAKEN_PI_FINAL_MODEL`, then `DRAKEN_PI_MODEL`, then `openai/gpt-6-astra`). The former separate `DRAKEN_FACTORY_AGENT_MODEL` override is ignored. Credentials/model definitions come from the selected Pi configuration, only on the host. No paid work occurs on GET or refresh. The agent form appears on workflows matching the operator-approved repository. It asks for the task and commit/ref and uses the existing workspace start/cancel/log endpoints. The plain **Repository checks** form remains a zero-model recipe run.

The CLI also accepts an explicit fourth argument containing `{plan, authorization}`. `authorization.kind: "operator"` is for operator-authored local trials; it is not a public API escape from discovery checks. Browser requests cannot select this authority. Discovery runs revalidate the authenticated Factory source before model/tool work and after completion; source-derived runs and logs are hidden after revocation, including revocation of uncited dependencies.

## Ownership, accounting and learning

- Release checks and workspace execution share one server-side execution owner. Persisted interrupted/unknown resource state blocks another start. This does not prevent a trusted operator from manually running separate CLI processes outside the server.
- Every Pi provider dispatch is reserved in a private, fsynced journal through the qualified `agent.streamFunction` interface. Responses record actual usage and cost. The default allowance is 16 calls; the explicit plan allows 1–64. Unknown usage stops further calls. No automatic retry or resume is attempted.
- Cancellation aborts Pi, rejects new tools and removes the actual container, not just its `docker exec` client. Completed changes are collected; failed collection retains the volume and reports interruption.
- Save the real session ID, workflow/revision, policy and base commit. Discovery runs store their real Pi session under the configured normal Pi source root's `draken-factory/` directory, with the actual repository as session `cwd`, not `/workspace/repo`. Operator trials remain private to their run by default.
- Normal consent, exclusions, activity windows and preparation still decide ingestion and learning. The code does not insert successful/reviewed learning records or retroactively upgrade historical evidence. Host verification remains a separate receipt; automatic outcome-learning joins are not implemented.

## Observed proof and retained failures

A real Luna session repaired a committed integer-parser bug:

- Three complete workflow steps: inspect/reproduce, repair without weakening existing tests, and retest.
- Baseline and the agent's reproduction failed before editing. The agent changed `index.cjs`, reran the preserved tests and additional edge checks, and passed `git diff --check`.
- Fresh host-controlled verification passed from the frozen base plus collected patch. The host checkout was unchanged; a committed executable project-extension probe did not run on the host.
- Final qualified proof: session `01a1fb37-227a-778a-be0b-327745fd4e49`, **6 actual model calls**, **$0.00089804**. Session assistant-message count matched the dispatch journal. Private receipts: `runtime/agent-workflow-1795214695441/run-4`.

Development failures remain retained. An initial tool-selection mismatch stopped before any model call. A subsequent trial used the wrong Pi property (`streamFn` rather than `streamFunction`) and incorrectly reported zero calls. Its retained transcript recovered **6 calls / $0.00073426** in an explicit accounting-correction receipt; the original report was not erased. The corrected intermediate proof used **6 calls / $0.00078782**. These are repeated development trials, not three independent model-quality evaluations.

`tests/factory-agent-live.cjs` uses real Docker with a **deterministic SDK fixture, not a provider**. It proves request-limit enforcement, container-only paths and commands, literal shell-character filenames, symlink rejection, output limits, command timeout, rejection of changed check entrypoints, fresh verification, cancellation, read-only collection and unchanged host files. Successful receipt directory: `/tmp/factory-agent-live-LmVfU4`; an earlier test-harness resource-key failure is retained separately. Ordinary CI runs contract/source/ownership tests without Docker or paid calls.

Local deployment shows both matching workflow/task forms at desktop and 390px widths, with no page errors or overflow. Refresh made zero Factory POSTs. The pre-existing background-learning error remains unchanged; no retry was started.

Current validation: **814 automated tests**, type checks, unused-code checks, client build, and **74 full browser tests** (including nine focused Factory tests) passed. Real-agent and Docker proofs are separate opt-in checks. Restart reconciliation, automatic delivery, broad task-acceptance policies and parallel agents remain outside this implementation.
