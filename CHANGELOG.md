# Changelog

## 0.4.0

This release prepares conversations in the background, makes preparation usage visible, and improves text-answer reference handling.

### One automatic preparation mode

- **Automatically prepare conversations** combines source discovery, local search indexing, summary batches and the next briefing. Home shows the actual stage, entry progress, model invocations, errors and last completion.
- Start a batch at 64 source changes or waiting entries, resume interrupted owned work from cache, and reuse an untouched ready briefing when you join. Small new tails wait for foreground preparation or a full batch; there is no timed flush.
- Foreground work takes priority. Provider failures require an explicit retry rather than an endless paid loop. Existing conversations, notes and frozen snapshots are not rewritten.
- This mode uses the configured pi summary/final models and their quota or API billing within the saved invocation limit. Existing local-index-only permission does **not** authorize it: enable the replacement switch explicitly. Agent/session exclusions remain independent. No automatic microphone, call, user question, note saving or review.

### Preparation usage in Settings

- A wider, responsive Settings dialog shows completed batches, entries, model requests, active preparation and estimated cost, with charts and bucket details.
- Look back 6 hours, 1 day, 7 days or 14 days, grouped into 1-hour, 6-hour or 24-hour UTC buckets. The dashboard refreshes every 15 seconds only while Settings is open.
- Include automatic and manual preparation, retries, failed work and discarded snapshots. Count a snapshot's first successful briefing preparation once; rebuilding it adds cost without another completed batch.
- New requests receive durable timestamps and a pending accounting record. Older timing is labelled approximate; missing pricing remains unavailable or a partial subtotal, never a guessed zero.
- Costs are recorded API-price estimates, not invoices, subscription charges or quota balances. Chat, native voice, post-conversation recaps and local machine/network costs are excluded. Opening the dashboard reads metadata only; it does not start preparation.

### More reliable text-answer references

- Give the final model short, stable per-answer labels and map them back to admitted original-source references before saving an answer. Historical citations inside quoted text do not authorize new references.
- Handle bad/missing citations and ignored later reports in one bounded correction through the same final model and invocation/cancellation budget. Unknown references are not guessed or silently removed; rejected drafts are not saved.
- Show the actual source-reference correction stage. Error wording describes validation failure rather than asserting that a reference was invented. Citation checks still do not independently verify every claim, and native voice retains its separate lookup path.

### Upgrading from 0.3.0

- **No new database tables, columns or schema migration.** Existing SQLite run records, JSON metrics and settings storage are reused. No dependency changes.
- Existing histories, conversations, notes, review state, cached summaries and compatible search vectors are retained. Older usage records are not rewritten or backfilled from current prices.
- Node.js 22.19+ and npm remain required. Back up original logs and Draken data, wait for active work to finish, stop the server, upgrade and restart. No automatic boot startup or hot reload is added.
- Automated qualification does not establish exhaustive real-model answer quality, future account quota or physical-device voice acceptance.

## 0.3.0

This release adds a separate text-chat experience and improves how Draken prepares history and checks later updates.

### Chat without a call

- Choose **Chat instead** on Home or an existing sync. Chat uses configured pi, without native voice setup, microphone permission or WebRTC.
- Keep saved messages, original-source links, a square Draken portrait and real searching/thinking status across reloads.
- Stop a reply or explicitly retry a failed one. Accepted questions remain saved even if generation fails; repeated delivery of the same request does not generate another answer.
- Sending a message never implicitly saves edited notes, marks work reviewed or starts a voice call. The model/quota notice was removed from the chat view.

### More reliable history preparation and retrieval

- Finish bounded import passes to the captured end of each log before freezing a snapshot. An indexed but incompletely imported prefix no longer qualifies as ready.
- Prepare history before enabling a call, with explicit progress, cancellation and server-side readiness checks. Live retrieval does not silently download the local model or rebuild corpus embeddings.
- Keep project scope across follow-up questions using actual user turns and admitted metadata. Prefer original project records over stale Draken replies, with better deduplication and explanatory excerpts.
- Show the prepared-history cutoff and make refreshing history explicit. New chat messages do not force a corpus rebuild after every turn; changed or missing captured originals still invalidate readiness.

### Reconcile later evidence in text status answers

- Check later related reports within the same original session, including follow-ups that themselves became stale. Keep client implementation, backend foundations, delivery enablement and device/provider acceptance distinct.
- Supply a larger bounded text-history packet and retain closing qualifications when excerpts are shortened.
- If a draft cites a linked old checkpoint while ignoring its supplied follow-ups, permit one correction through the same final model and invocation budget. A second failure is visible; rejected drafts are not saved.
- The correction can consume one additional final-model request. These checks improve retrieval and citation consistency; they do not independently verify every claim or exhaustively reconcile all sessions. Native voice retains its separate smaller lookup path.

### Upgrading from 0.2.0

- Node.js 22.19+ and npm remain required. Back up original agent logs and Draken data first; wait for active calls and preparation/indexing jobs to finish, then stop the server before upgrading and restart it afterward.
- This release adds import-completeness metadata and nullable chat request IDs with a uniqueness constraint. Existing conversations, notes, review state and compatible embedding vectors are retained. Do not restore an older backup over newer user activity or use an older binary to undo migrations.
- No provider/account replacement, automatic paid summarization or new background-indexing policy is introduced. Chat and its correction attempts remain outside the preparation-only cost estimate.
- Automated tests use synthetic provider replies. Real local-embedding checks do not establish real-account quota, model-answer correctness, physical-device audio or end-to-end notification delivery in your projects.

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
