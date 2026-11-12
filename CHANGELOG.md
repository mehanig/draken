# Changelog

## 0.6.0

### User-triggered syncs, automatic local indexing

- Automatic indexing accumulates searchable history without creating syncs, summaries, recaps or briefings and without provider model calls. Only an explicit user action creates a sync and prepares its briefing from all eligible accumulated entries.
- Rename the setting to **Automatically index history**. Preserve saved indexing choices, migrate legacy combined-only preferences, and retire automatic-briefing job controls. Existing automatic snapshots, conversations, notes, cached work and cost history remain intact; new requests do not silently claim or resume them.
- Keep local batching, durable checkpoints, foreground priority and bounded retries. See [MEMORY.md](MEMORY.md#optional-background-indexing) for the policy.

### Ownership and reliability

- Separate shared retrieval, configuration, embedding assets and inference ownership. Live evidence requires verified original-backed pointers; migration-only historical compatibility and reusable vectors remain supported.
- Hold exclusive data-directory ownership until listeners and owned jobs/processes have drained. Suspended servers cannot be displaced by an expired heartbeat; unconfirmed cleanup retains ownership rather than allowing a second server to start.
- Confirm native helper/group exit for calls, metadata checks and terminal commands. Cancel stale browser source reads when switching sources, navigating or closing a call.
- Strengthen historical compatibility, process-lifetime, package and optional qualification regressions. Documentation retains current contracts rather than implementation/review transcripts.

### Upgrading

Back up original agent logs and Draken state, finish active work, stop the server, install the new version and restart. The retired automatic-briefing settings are removed, but existing sync data is not deleted or rewritten. Local indexing can remain enabled without spending summary-provider quota. Node.js 22.19+ is still required; there are no dependency-version changes in this release. Synthetic qualification does not establish real-provider audio or physical-device acceptance.

## 0.5.1

- Reflow overlong recap prose at existing spaces rather than rejecting it solely for line width. No words, qualifications or original point boundaries are dropped; the same five-line, 160-character-per-line and 600-character-total limits still apply. Other invalid output still gets at most one correction.
- Save content-free recap validation outcomes, reasons and line lengths in existing preparation metrics. Final failures include a specific safe reason. Rejected model text is not retained, and older failures cannot be retroactively diagnosed from missing outputs.
- Distinguish entries not yet assigned to a sync from entries held in unfinished preparation. Home and Settings show unfinished batch size and stopped stage; zero unassigned entries no longer implies preparation succeeded.
- Preserve existing recap caches, histories, notes, review coverage, automatic-preparation choices, model budgets and explicit failure-retry rules. No new schema or dependencies. Short chat replies and new-install automatic preparation from 0.5.0 are unchanged.

## 0.5.0

This minor release combines automatic preparation for new installations with shorter conversational replies. The planned 0.4.2 changes are included here; 0.4.2 was not published.

- Give text chat its own short-answer instructions instead of opening-briefing headings: one paragraph or up to three bullets, usually 60–100 words excluding citations. Simple questions can be shorter; explicit requests for detail or another format still win.
- Keep the same concise style during the existing single citation/reconciliation correction. Evidence selection, later-report checking, model choice and invocation limits are unchanged. No hard word truncation or additional shortening-model pass; actual model adherence to the target is not guaranteed.

- New installations enable automatic preparation by default: scan enabled histories, update local search, summarize new work and prepare a briefing while the server runs. This includes configured model quota or API billing, not only local indexing; turn it off in Settings → Automatically prepare conversations.
- Preserve existing installations' behavior, including explicit off, no saved preference and older local-index-only permission. The default is stored only when initializing an empty database; restarts and settings reads do not reset choices or authorize wider work on upgrade.
- Keep the existing once-minute idle checks, 64-record batch threshold, saved invocation limits, explicit retry after provider failures and independent source/session permissions. No automatic microphone, call, decision or review.
- Explain the default and preparation costs in setup, Home, Settings and public documentation. Preparation usage remains a preparation-only estimate, not a provider invoice or total-spending tracker.
- No new tables, columns or dependencies. Existing original logs, conversations, notes, coverage, summaries and compatible vectors remain unchanged.

## 0.4.1

This release improves audio recall, makes preparation charts easier to read, and explains automatic compaction and cost tracking on Home and the public website.

### Audio evidence and continuity

- Native voice now uses the same bounded archive selection and later-report checking as chat: up to sixteen sources in a 32,000-byte historical packet. Original source permissions, captured cutoffs and qualifications are retained.
- New calls inherit project focus from actual saved user turns, not generated replies. Explicit switches still win. Questions about old historical or frozen checkpoints check later reports instead of merely repeating the old state.
- Larger evidence travels losslessly through bounded native context messages; the small handoff returns a completion receipt. Partial transfers are never marked ready, repeated lookups reuse delivery, and Stop/new turns prevent old transfers from continuing.
- Spoken answers keep the existing concise target. No extra pi generation or replacement voice engine is introduced. More input context is not a guarantee of unchanged native quota use.
- Native speech is not post-validated or retractable like text's citation-repair pass. Protocol tests and matching evidence packets do not establish physical-audio acceptance or exhaustive answer accuracy.

### Readable preparation costs and clearer guidance

- Add labelled USD/whole-batch Y-axes and gridlines, with matching rounded bar scales and readable mobile labels. Handle zero, tiny, large and unavailable costs without inventing prices.
- Explain automatic preparation/compaction and preparation spending estimates on the app Home page, README and public homepage. Compaction produces cached summaries; it does not modify or delete original logs.
- Keep cost boundaries explicit: recorded preparation estimates include retries and failures, but exclude chat, native voice, standalone post-conversation recaps and local machine/network costs. They are not invoices, total spending or quota balances.
- Opening the explanatory panel or dashboard does not enable automatic mode, start inference, capture audio or mark work reviewed.

### Upgrading from 0.4.0

- No schema migrations or dependency changes. Existing histories, notes, conversations, coverage, cached summaries and compatible vectors remain intact.
- Node.js 22.19+ and npm remain required. Back up original logs and Draken data, wait for active work to finish, stop the server, upgrade and restart. Existing automatic-preparation consent remains unchanged.

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
