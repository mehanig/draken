# Desktop tray companion (macOS / Windows)

The current source build adds an optional `draken tray` command. **It is not in the older public npm 0.1.6.** Node.js 22.19+ and npm are still prerequisites; this is not a standalone desktop installer.

```sh
draken tray
# From a built checkout instead:
node dist/cli.js tray
```

Run it in the **local desktop session**, as the server's user, with the intended `DRAKEN_DATA_DIR` and server environment. Once the command reports that the tray is ready, you can close the terminal. The normal `draken` command remains a foreground server.

## What it does

- macOS: a dragon in the menu bar, using the system AppKit frameworks through JavaScript for Automation.
- Windows: a dragon in the notification area, using the system Windows PowerShell/.NET Forms components. Windows may put it in the overflow area; pin it using the Windows notification-area settings if desired.
- Green/gray/amber/red badge plus textual **running / stopped / starting / stopping / error** status. These mean server connectivity, **not pi credentials, model access, native voice readiness, or an active call**.
- **Open Draken** opens the verified server's browser URL, preferring its saved HTTPS URL. It never places credentials in the URL, logs in automatically, or opens a browser without a menu action.
- **Start Draken (current settings)** and **Stop Draken (ends active calls)** control only a child server started by this tray.
- Quit explicitly says whether it stops the owned server or leaves an existing external server running.

The tray starts a server automatically only for a fresh address with no recorded prior instance. A saved but stopped server needs an explicit Start click. Different saved LAN/TLS settings are not silently replaced with localhost defaults. Starting uses the environment supplied when launching the tray; saved address metadata does not contain credentials or a complete launch profile.

An already-running server is observed, not adopted. Stop is disabled for it, and quitting the tray leaves it running. If that server disappears, use its original launcher/configuration to restart it. A saved PID never authorizes a kill. Failed startup or unconfirmed shutdown never creates a replacement loop.

## Boundaries

- No Electron/browser bundle, downloaded native tray binary, development compiler, global PATH change, administrator access, or paid code-signing certificate is required by this tray implementation.
- The packaged native scripts use OS frameworks. Draken does **not** change PowerShell execution policy, application-control policy, Gatekeeper, the firewall, or certificate trust. Managed/restricted desktops may refuse the helper; failure is reported rather than bypassed. Signing a future standalone installer is a separate concern.
- No Linux tray, SSH/headless tray, Windows service integration, start-at-login registration, background updater, daemon supervisor, embedded terminal, or new login implementation is included in this first version.
- Setup/login remain the existing explicit pi and native voice commands and browser guidance. The tray never installs pi, copies credentials, downloads a model, scans history, creates a sync, or captures audio itself. A server it starts retains the user's existing automatic-indexing preference and normal server behavior.
- Stop/Quit can interrupt generation and active calls. Existing server shutdown preserves completed work and retains its normal recovery behavior; unfinished generation must be retried explicitly. No review coverage is advanced.

## How it works

`draken tray` starts a detached Node companion and waits for native UI readiness before reporting success. One heartbeat lock per data directory prevents duplicate companions. After an unclean exit, stale-lock recovery takes approximately 30 seconds; there is no unconditional lock deletion or PID-based kill.

The companion polls only the bounded `/api/auth/status` identity endpoint. The native UI receives a bounded private presentation file and heartbeat, not server credentials, provider environment variables, source text, or tokens. Menu clicks return only fixed action identifiers. If the companion stops updating, the helper closes itself after 15 seconds.

An owned server reports its actual bound addresses and instance over a private parent/child IPC channel. Stop requests and parent disconnect use that channel, including on Windows, where `kill(SIGTERM)` would be an abrupt termination. There is no new HTTP shutdown endpoint. Lost helpers cause shutdown of the tray's owned server only; existing external servers are unaffected.

Private state is under `<DRAKEN_DATA_DIR>/tray/` (default `~/.draken/tray/`):

- temporary per-run presentation files; removed on orderly exit;
- a bounded `server.log` tail (64 KiB) and `error.log` (2,000 characters);
- the adjacent `tray.lock/` directory used by pinned `proper-lockfile@4.1.2`.

These are private diagnostics, not publishable reports. Files use restrictive modes where supported and rely on the user's private data-directory permissions on Windows. No logs or private runtime files belong in git or the npm package.

## Qualification

Platform-independent tests exercise ownership, startup/stop/quit races, stale responses, private IPC, duplicate companions, terminal disconnection, and real isolated backend processes. They make no provider requests and do not use production data.

**Native macOS/Windows rendering and menu interaction cannot be qualified on the Linux development host.** This implementation remains a desktop preview until the target-platform checks pass. `.github/workflows/tray-check.yml` runs the controller/IPC suite and `npm run test:tray:native` on macOS and Windows. The native smoke check opens a temporary icon, changes status, and checks graceful exit without starting a server, opening a browser, reading history, or accessing a provider. A workflow file is not evidence that the job has run.

Before a public release, manually verify on each supported OS/architecture: visible icon and dark/light appearance, accessible status text, Open/Start/Stop/Quit, terminal closure, duplicate launches, spaces/Unicode in install paths, existing-server non-interference, logout, and application-control restrictions. No claim of physical menu usability or all-platform compatibility follows from the synthetic tests alone.
