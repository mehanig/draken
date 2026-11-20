# Repository workspaces

Factory can now check out a complete committed repository tree into a private Docker volume, prepare its development environment, and run its declared workflow there. Setup and checks share the same workspace, including installed dependencies and code edits. Nothing is applied to the host checkout.

This is the engineering-workspace foundation, not a general coding agent. The current runner executes repository-declared setup/check commands; it does not receive a learned workflow or engineering objective. The agreed next design is **one host-side Pi session for the entire workflow, with all coding tools operating inside one persistent Docker workspace**. Environment setup/check commands are prerequisites, not a replacement for that workflow. Independent step sessions and parallelism are deferred. See [the handoff review and implementation plan](factory-agent-handoff.md). This session integration, independent acceptance testing and PR delivery are not implemented yet.

## Repository declaration

Commit `.draken/environment.json`. Draken's declaration pins a full Node 22.23.5 development image. Its CI currently uses Node 22.23.4; the workspace tests verify the newer patch version rather than claiming an exact CI image match:

```json
{
  "schema": 1,
  "image": "node@sha256:APPROVED_DIGEST",
  "setup": [
    { "name": "Install dependencies", "argv": ["npm", "ci", "--ignore-scripts"] }
  ],
  "checks": [
    { "name": "Test", "argv": ["npm", "test"] }
  ]
}
```

Each command may specify `cwd`, such as `./client`. Commands run inside the workspace, never on the host. The repository cannot add mounts, credentials, privileges, network destinations or resource limits through this file.

The host must separately approve the exact base image. Version one requires a Linux image containing Node and Git. Custom toolchains can be included in an approved base, but arbitrary repository Dockerfiles are not executed automatically. Draken builds a small trusted wrapper containing its worker and request broker, records the resulting image ID, and caches Docker layers. Dependencies are installed afresh from each checkout, not shared between runs.

## Missing declarations

A committed `.draken/environment.json` is required. If it is missing from the selected commit, the run stops with: **Missing required file: .draken/environment.json. Add and commit it to the selected branch or commit before running repository checks.**

Draken does not infer an image from manifests or CI, propose an environment, or call a model. The missing-file check happens before Docker is invoked. The former `DRAKEN_WORKSPACE_PROPOSE` flag no longer enables proposals.

## Checkout and isolation

- Resolve the requested branch or commit once, then transfer its Git objects into a fresh **single-commit checkout** with the exact original commit ID.
- Include all committed tree files, including files marked `export-ignore`. Uncommitted/untracked files, old history, local Git configuration, credentials and remote URLs are not copied.
- Reject submodules and Git LFS rather than silently providing an incomplete tree. Common tracked credential paths are rejected too; this is not a comprehensive secret scanner. Review repositories before granting access.
- No host bind mounts or Docker socket. Non-root user, read-only image filesystem, dropped capabilities, no-new-privileges and built-in seccomp.
- Workspace processes receive 2 CPUs, 4 GiB memory, at most 512 processes and a 1 GiB temporary filesystem. Temporary executables are allowed for compilers and test helpers.
- An internal network connects to a separate broker. This initial profile permits npm registry reads and audit requests only; it provides neither arbitrary Internet access nor credentials.
- Each command has a four-minute limit; workspace execution has a fifteen-minute limit. There are no automatic command retries.
- After execution or cancellation, stop repository processes. A fresh, network-disabled collector mounts the workspace **read-only**, uses pristine Git metadata from the original snapshot, and retains a binary patch including new non-ignored files.
- If patch collection fails, retain the volume and report an interrupted run needing inspection. Never delete the only copy of unfinished work while claiming successful cleanup.

These are rootless containers sharing the host kernel, not microVMs. Artifact volumes do not yet have disk quotas. This is not a claim of complete isolation for arbitrary hostile repositories.

## Run locally

Configure rootless Docker and explicitly approve an already-pulled image:

```sh
export DRAKEN_DOCKER_BIN=/path/to/docker
export DRAKEN_DOCKER_HOST=unix:///path/to/rootless-docker.sock
export DRAKEN_WORKSPACE_ALLOWED_IMAGES='["node@sha256:APPROVED_DIGEST"]'
node scripts/factory-workspace.cjs /path/to/repository HEAD /private/new-run-directory
```

For the browser, additionally set `DRAKEN_WORKSPACE_REPO` on the server. Factory's **Repository checks** section accepts a commit or branch. **Run** starts the job; **Cancel run** stops it. Refresh and reopening the page only read saved state. Request IDs prevent accidental duplicate starts; uncertain interrupted jobs are not automatically replayed.

Results persist under the private data directory's `factory-workspaces/`. The run retains the resolved commit, source-pack hash, environment definition, built image ID, actual container configuration, command logs, patch and outcome. Generated build artifacts and dependency directories ignored by Git are not delivery patches.

## Observed validation

- A real Draken checkout at `7320eeb4fe99fe8d3acd0a1b86090337341b1962` contained all **376 committed files**. Dependency setup, native SQLite compilation, type/unused-code checks, application build and **805 automated tests** passed inside Docker. No tests were weakened or skipped. The patch was empty and there were no model calls because the environment was declared.
- The browser-started run at `2a4d7057212285b76d3fdb49cdc24e235967805c` checked out **382 committed files** and passed all seven stages, including **806 automated tests**. It used zero model calls and produced an empty patch. The fresh collector mounted the workspace read-only; no run containers, volumes or networks remained afterward. Reopening Factory showed the saved result and test log without starting another run. Desktop and 390px mobile checks reported no page errors or horizontal overflow.
- Before automatic proposals were removed, a separate small repository received a real Luna-generated environment and passed its tests (one call, 506 input tokens, 92 output tokens, $0.0000966). Those historical receipts remain retained; this is no longer an available execution path.
- Host validation also passed 806 automated tests, 73 browser tests, type checking and unused-code checking.
- `tests/factory-workspace-live.cjs` checked real edits across stages, an unchanged host checkout, excluded host credentials/Git remotes, read-only patch collection and preservation of edits on cancellation.
- Development failures were retained: generated image scripts initially lacked read permission for the non-root worker; the first full test run exposed non-executable temporary files. Both environment problems were corrected rather than changing test assertions.

The separate live proofs do not imply that ordinary CI provisions rootless Docker or calls a paid model.
