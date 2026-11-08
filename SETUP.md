# First run and private pi setup

Draken uses **pi for summaries, preparation recaps and text discussion**, regardless of which coding agent produced the imported history. It does not implement provider OAuth, translate another agent's credentials, or run Claude/Codex to summarize.

> This guide is for **Draken 0.3.0**. Versions **0.1.6 and earlier** are the old task dashboard. Before upgrading, back up your original agent logs and Draken data; see [what changed](CHANGELOG.md#030).

## Install and start

Install Node.js **22.19+** with npm, then run:

```sh
npm install -g draken
draken
```

Installation does not launch a server or register a background service. `draken` runs in the foreground, prints its address and next steps on **every launch**, and serves the browser UI. Keep that terminal open; **Ctrl+C stops Draken**, while closing the browser does not. Run commands below in another terminal, or stop the server and restart afterward.

- `draken tray`: optional macOS/Windows desktop preview. Starts a detached tray companion with Open and owned-server Start/Stop controls, so the terminal can close after readiness. An existing server stays with its original launcher. There is no automatic login registration, setup/login, or Linux tray. See [TRAY.md](TRAY.md) for lifecycle and qualification details.
- `draken status`: finds this data directory’s last successfully started server automatically—including LAN binds and custom ports—and checks its live instance identity. It also prints the HTTPS browser URL when available. You do not need to repeat `DRAKEN_HOST`/`DRAKEN_PORT`; explicit overrides still work. For a nondefault data directory, use the same `DRAKEN_DATA_DIR`. This is connectivity, not model/voice readiness or a process-management command.
- The server atomically saves a private, credential-free `server-state.json` after binding successfully. The record stays after shutdown so status checks the last address, but a saved PID/address alone never counts as running. Stale records and mismatched live instances fail visibly.
- `draken doctor`: checks the selected pi executable, version and configured model credentials. It does not create the application database, generate text or verify provider access/billing. A non-ready result exits nonzero.
- A duplicate launch on an occupied HTTP/HTTPS port exits **before opening the database or recovering interrupted runs**.

Loopback (`http://127.0.0.1:40333`) needs no dashboard login by default. LAN exposure still requires configured dashboard authentication and trusted HTTPS for microphone access. There is no automatic firewall change or certificate trust installation.

## When pi is not installed

Run these **on the server, as its operating-system user, with the same environment**—especially `DRAKEN_DATA_DIR`, `DRAKEN_PI_BIN` and model settings:

```sh
draken setup
draken login
```

`draken setup` explains the destination and asks for confirmation. In an unattended terminal, `draken setup --yes` is explicit installation consent; npm package installation, server startup and browser requests never run it automatically.

The installer uses the shipped `runtime/pi/package.json` and **package-lock.json**, with pi **1.5.0**, resolved npm dependency versions and integrity hashes. It runs `npm ci --ignore-scripts --omit=dev`, without audit/funding requests or user npm configuration. No global packages or PATH entries are changed. Dependencies come from the npm registry; this is an explicit network download, not a model request.

The 1.5.0 lock replaces the previously shipped 1.4.0 lock with affected `undici`/`minimatch` dependencies. Updating Draken does **not** silently replace an already selected runtime: run `draken setup` explicitly to select the new private runtime while retaining the same private credential directory. External pi installations remain operator-managed. A clean audit of the shipped lock does not certify an older selected or external installation.

Default layout (under `DRAKEN_DATA_DIR` when overridden):

```text
~/.draken/pi/
  runtime/1.5.0-<lock-hash>/   immutable selected runtime directory
  selected.json              small, atomically replaced runtime selection
  agent/                     pi's private configuration and auth.json
  home/                      private child HOME and npm cache
  workspace/                 empty, non-project login working directory
```

Installation is staged and exclusively locked. Selection changes only after successful installation and executable checks. Re-running setup reuses the qualified runtime. Existing credentials and previous runtime directories are retained; a failed install never substitutes an unrelated runtime. Unexpected symlinked private directories/configuration are refused. This is configuration separation, **not an operating-system sandbox**.

## Let pi own login

`draken login` opens pi's existing terminal interface, using the selected runtime/profile. It requires a real interactive terminal. Inside pi:

```text
/login
```

Choose the provider/method offered by pi and follow its prompts. For Draken's default OpenAI models, `/login openai` selects that provider's flow. On a headless server, follow pi's printed URL and paste the redirect/code when pi asks. Finish with:

```text
/quit
```

Draken does **not** pass `/login` as a model prompt, capture the login transcript in its database, or provide its own credential form. Pi handles the provider's OAuth/API-key flow, persistence and subsequent refresh. Managed processes use `PI_CODING_AGENT_DIR=<data>/pi/agent` and a private HOME; unrelated provider keys, pi session ownership, custom environment overrides and preload hooks are not inherited. Managed login and generation disable tools, MCP, extensions, skills, project instructions and session persistence. These login sessions are not imported as engineering evidence.

Afterward, run `draken doctor`, or click **Check setup again** on Home or in Settings. Checks use pi's bounded `auth check --model … --json --no-refresh` protocol, never its credential-printing options. **Credentials configured is not proof that the provider will accept them, that a particular model is available to the account, or that usage is free.** The actual request can still fail normally.

Draken's summary/final model configuration remains unchanged. Signing in to an unrelated provider does not automatically replace the selected models. Use the existing advanced `DRAKEN_PI_SUMMARY_MODEL` and `DRAKEN_PI_FINAL_MODEL` settings if required; restart with the same environment for diagnostics and generation.

## Existing pi users

Starting Draken does not switch an existing installation or copy its credentials:

1. An explicit `DRAKEN_PI_BIN` always wins, including its existing `PI_CODING_AGENT_DIR` configuration. Private setup refuses to replace this override; fix/unset it first if you want managed pi.
2. Without that override, an explicitly selected private runtime is used.
3. Otherwise Draken uses `pi` on PATH, retaining its normal configuration.

`draken setup` explicitly selects managed pi; it does not import the existing profile. `draken login` identifies the selected profile before opening it. A broken private selection fails visibly instead of silently falling back to global pi or another provider. The server reads the selection for subsequent requests; changing runtime does not rewrite in-flight requests or frozen snapshots.

## Native voice is separate

For the main sync-and-call action:

```sh
draken voice setup
draken voice login
draken voice status
```

These commands install the pinned native helper, open its official ChatGPT device login, and check local prerequisites. No development tools are needed. Voice keeps its existing dedicated account under `~/.draken/realtime`; **pi tokens are not copied or converted**. Status is structural helper/sign-in metadata, not a real audio/provider qualification. Optional developer audio probes are documented in [CONTRIBUTING.md](CONTRIBUTING.md) and require explicit provider consent.

## Browser instructions and history

Home shows first-run guidance when no syncs exist, and a setup notice whenever summary/voice prerequisites cannot be confirmed. Settings always exposes **Runtime & sign-in**. The main Sync action waits for configuration and rejects known-missing summary prerequisites before scanning/freezing a new snapshot. Existing evidence, source scanning, notes and history remain accessible.

Choose **Settings → Agents & sessions**. Enable the history sources you want and use **Scan enabled agents**, or let the next explicit sync scan them. Source roots and permissions are independent of the private summarization runtime: installing pi does not enable Codex/Claude histories or change the original pi archive. See [SOURCES.md](SOURCES.md).

Opening these instructions checks local metadata only. It does not install packages, refresh OAuth tokens, download embeddings, generate a summary, create a snapshot, acquire a microphone, or mark work reviewed. An independently opted-in background indexing schedule keeps its existing behavior.

## Recovery and maintenance

- Incomplete setup: retry the explicit command. If a `setup.lock` remains after a crash, inspect its PID and confirm no setup process is running before removing **that lock only**. Remove abandoned `.install-*` staging directories only after the installer has stopped.
- An incomplete versioned runtime is never overwritten under a running process. Move the indicated runtime directory aside, then retry setup. **Do not delete `agent/` to repair runtime code.**
- Private dependency upgrades belong to a qualified Draken update and a new shipped lockfile—not an automatic `pi update`. Old runtime directories are retained until explicitly cleaned up.
- Back up private credentials securely along with Draken state and the original source archives. Do not commit them, include them in npm packages, or paste them into diagnostics.

For source builds and automated qualification, see [CONTRIBUTING.md](CONTRIBUTING.md). Normal installation does not require cloning the repository or building the application.
