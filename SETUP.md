# First run and private pi setup

Draken uses **pi for summaries, preparation recaps and text discussion**, regardless of which coding agent produced the imported history. It does not implement provider OAuth, translate another agent's credentials, or run Claude/Codex to summarize.

> This guide is for **Draken 0.8.4**. Versions **0.1.6 and earlier** are the old task dashboard. Before upgrading, back up your original agent logs and Draken data; see [what changed](CHANGELOG.md#084).

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

**Automatic local indexing is on by default for new installations.** While the server runs, it checks enabled sources once a minute. Idle checks index any new or changed activity, including small tails, without requiring an active conversation. It accumulates searchable history without creating syncs, summaries or briefings and makes no provider model calls. Local embeddings use CPU, memory and disk; first use may download about 136 MB of pinned search model files. Change this in **Settings → Automatically index history**. Existing installations keep their saved indexing choice, including off. User turns and foreground work take priority and drain owned indexing; connected idle voice permits local work between turns, never during a pending response or context delivery. Disabling cancels automatic indexing and retains completed embeddings. Local failures back off for at least five minutes, with **Retry automatic indexing** available in Settings. Source/session exclusions still apply, and Codex and Claude remain separately opt-in. Only your explicit **Sync with Draken** or **Chat instead** action starts a new snapshot and briefing using configured models and their quota or API billing. Existing snapshots and notes remain untouched; no call, microphone or review starts automatically. **Settings → Preparation usage** retains preparation-only cost estimates, including paid background summaries and past automatic work, not total spending or quota. Completed batches count explicit snapshots' first successful briefings, not cached preparation.

**Background summaries are on by default.** **Settings → Prepare summaries ahead** requires **Automatically index history**; explicit saved opt-outs are preserved. This sends eligible accumulated entries to the configured summary model within the same `max_invocations` allowance, with no provider/model fallback. Once-minute idle checks prepare new or changed eligible activity, including small tails, independently of the embedding checkpoint. It warms validated summary leaves, reconciliation and compact final input, not a snapshot, final briefing, recap or review. Unchanged prepared input makes no further calls. Completed batches, including completed partial tails, remain reusable across appends and combined snapshots. Uncovered or changed inputs and aggregate reconciliation for a different combined input may still need work at **Start chat**, and the final briefing is always explicit—not a zero-wait promise.

Foreground work cancels and awaits owned background provider work. Valid cache survives cancellation/restarts, with invocation spending retained for the same interrupted input. Paid failures pause until explicit retry, unlike local indexing's five-minute retry delay. Disabling either switch stops paid background work without deleting cache. See [the durable preparation policy](MEMORY.md#optional-paid-summary-preparation).

Loopback (`http://127.0.0.1:40333`) needs no dashboard login by default. LAN exposure still requires configured dashboard authentication and trusted HTTPS for microphone access. There is no automatic firewall change or certificate trust installation.

## Upgrade to 0.8.4

<a id="upgrade-to-081"></a>
<a id="upgrade-to-070"></a><!-- Preserve links from historical release notes. -->

1. Back up original agent logs and the private Draken data directory. Preserve existing histories, conversations, notes, review coverage and frozen snapshots; do not replace them with an old database.
2. Finish active calls/preparation, stop the server, and quit any tray that owns it. Install the released version with `npm install -g draken@0.8.4`, then restart using the same user, environment and `DRAKEN_DATA_DIR`.
3. Check **Settings → Runtime & sign-in**. Existing pi/voice accounts and selected runtimes are unchanged; upgrading does not silently install or sign into a replacement runtime.
4. Keep or change **Automatically index history** as desired. Its existing preference is preserved. **Prepare summaries ahead** defaults on when no preference is saved; an explicit saved off remains off. Enabled background summaries consume configured provider quota/API billing. Live history updates need only local indexing, not paid summaries.
5. Start a sync/chat explicitly for the initial briefing and history preparation. Active conversations then adopt newly prepared H history between turns. Their initial snapshot, E/C references, briefing, existing transcript and notes are not rewritten. Updates neither interrupt replies nor disable already-prepared chat; damaged captured originals still fail closed, and unavailable extra archive context must be disclosed.
6. Expect **Session ended** after 30 minutes without a real user chat message or voice turn (creation is initial intent; an ongoing reply finishes first). Polling, background updates, assistant responses and connection heartbeats do not extend it. The transcript remains readable; notes/review remain explicit. Return home and **Start new sync** to chat again. Idle ending is not review and creates no recap.

The additive conversation lifecycle migration persists last user activity and the ended marker separately from open/completed/discarded review status. Existing activity is derived from stored real user turns; inactive older sessions may end and release unreviewed reservations for the next explicit sync. No histories, notes, snapshots or review records are deleted. No dependencies change in this release. Do not run an older binary to undo schema changes.

### Release qualification and website ordering

For a source release, build and test sequentially once the backend/client changes are ready. Run conversation lifecycle and append-safe readiness tests (`tests/conversation.test.cjs`, `tests/live-history-readiness.test.cjs`), voice live-update/activity coverage (`tests/voice-live-updates.test.cjs` and existing activity tests), and the existing local-indexing/paid-cache suites against the new server build. Run `tests/ui/live-conversation.spec.ts` after the complete build, then `node --test tests/site-browser.cjs` and `node tests/package-smoke.cjs` with the complete package build. The site check serves static files and needs Playwright/Chromium, not an application build or provider. The package smoke requires built `dist/` and `public/` and installs an isolated production-only tarball; it must observe `auto_summary=false`, a metadata-only disabled auto-summary GET, and no background runs/provider activity by default. Synthetic tests do not establish provider latency, quality or account billing.

Publish npm only through the separately authorized release process. The existing website workflow checks `scripts/site-release.cjs`: copy must match the package version and npm `latest` must be 0.8.4 before the site is deployed. Do not bypass this gate to publish release copy early. Updating docs/version/site files is not a merge, npm publication or live deployment.

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

Opening these instructions checks local metadata only. It does not install packages, refresh OAuth tokens, download embeddings, generate a summary, create a snapshot, acquire a microphone, or mark work reviewed. Enabled automatic local indexing runs independently of these instructions; it is on by default for new installations and can be turned off in Settings. Local indexing alone never creates snapshots or runs summary/briefing models. If separately enabled, paid summary preparation also runs independently of browsing, but never creates snapshots or final briefings. Opening these instructions or settings GETs cannot grant that consent.

## Recovery and maintenance

- Incomplete setup: retry the explicit command. If a `setup.lock` remains after a crash, inspect its PID and confirm no setup process is running before removing **that lock only**. Remove abandoned `.install-*` staging directories only after the installer has stopped.
- An incomplete versioned runtime is never overwritten under a running process. Move the indicated runtime directory aside, then retry setup. **Do not delete `agent/` to repair runtime code.**
- Private dependency upgrades belong to a qualified Draken update and a new shipped lockfile—not an automatic `pi update`. Old runtime directories are retained until explicitly cleaned up.
- Back up private credentials securely along with Draken state and the original source archives. Do not commit them, include them in npm packages, or paste them into diagnostics.

For source builds and automated qualification, see [CONTRIBUTING.md](CONTRIBUTING.md). Normal installation does not require cloning the repository or building the application.
