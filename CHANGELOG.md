# Changelog

## 0.2.0

Draken now helps you catch up on what your coding agents did. It reads saved sessions, prepares summaries with links to the original messages, and lets you ask questions and save decisions. It does not run project commands or change your code.

### What changed

- Read pi sessions, with separate opt-in imports for supported Codex CLI and Claude Code logs.
- Prepare summaries of the selected history, including large histories, and reuse completed work when possible.
- Search older sessions locally, ask questions in text, and keep notes about what to do next.
- Follow source links back to the original logs. Only explicitly marking a sync reviewed updates review progress.
- Use optional ChatGPT live voice with its own sign-in and an animated dragon. The microphone stays off until preparation is done and you choose to call.
- Install a private pi runtime with `draken setup`; pi handles provider sign-in and refresh.
- Find a running server with `draken status`. Try the optional macOS/Windows tray icon with `draken tray`.

### Before upgrading from 0.1.6 or earlier

This replaces the Docker/Claude task dashboard. The old task execution, terminal, scheduling and Git-control features and APIs are removed. This is not a compatible upgrade for tools built around those APIs.

- **Node.js 22.19+ and npm are required.** Docker is not needed.
- Back up your original agent logs and private Draken data before upgrading. Original logs are needed to read source links, including those in older summaries.
- Applicable legacy tables and historical call records are retained, but old task conversations are not automatically imported.
- Do not use an old Draken binary to undo database changes.
- An update does not replace an already selected pi runtime. Run `draken setup` explicitly for the shipped private runtime, or manage your external pi installation yourself.

### Limits to know

Summaries can miss details, and search can miss relevant messages. Source links are not independent proof that a claim is correct. Reading or listening does not mark work reviewed.

Reading and search run locally. Summaries and text questions send content to your selected model provider through pi. Voice sends audio and context to OpenAI, using a separate ChatGPT sign-in.

The desktop tray is a preview. Hosted tests check startup and shutdown, not physical menu usability. Automated tests also do not establish real-account access, quota, billing, microphone quality or speaker playback. See [ACCEPTANCE.md](ACCEPTANCE.md) for those checks, and [SETUP.md](SETUP.md) to get started.
