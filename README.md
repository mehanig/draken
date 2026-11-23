<p align="center"><img src="site/img/logo.png" width="100" alt="Draken"></p>

# Draken — engineering sync

A local-first engineering sync across your **pi, Codex CLI and Claude Code sessions**. Session readers are agent-neutral; summarization still runs through pi.

> Draken is a read-only companion, not a task runner. It replaces the old Docker/Claude dashboard and does not launch coding workers or schedule tasks. Voice calls use only **ChatGPT live voice**, through a separate native sign-in to the same paid account. The previous local speech engine has been removed; historical call records are preserved. Voice sends audio to OpenAI; generated transcripts are not verified claims or exact playback records; see [VOICE.md](VOICE.md). Calls include a local animated **3D dragon persona**, with a standalone `/persona.html` preview; see [PERSONA.md](PERSONA.md).
>
> **Large histories now use a cached summary tree:** cheaper-model parsing and reconciliation, followed by a stronger-model verdict. The old raw-evidence snapshot cutoff is removed. This is still lossy model compression, not independent verification. See [ROADMAP.md](ROADMAP.md) for remaining quality evaluation and community research.

**Sync with Draken → call or chat → keep a short recap.**

**Draken 0.15.0** makes **Factory** read saved workflows directly from the database, without reopening historical sources on page load. Task reconstruction distinguishes continuations from separate work; explicitly prepared consolidations preserve old links and execution history. Existing lists are not automatically merged on upgrade. See [the release notes](CHANGELOG.md#0150).

**Automatic preparation:** **Settings → Automatically prepare history** controls one pipeline: scan, index locally, then cache reusable summaries through your configured provider and quota/API billing. Both stages default on; saved opt-outs remain unchanged until you explicitly enable the combined control. Idle minute checks include small tails. Disabling stops both stages and retains completed embeddings and summaries. Paid failures appear in the shared Home/Settings status and require **Retry automatic preparation**; local failures back off five minutes.

Only **Sync with Draken** or **Chat instead** creates a snapshot and opening briefing. Background work never reviews entries, starts audio, changes notes or rewrites originals. Unchanged prepared input makes no further provider calls. Completed leaves survive appends, cancellation and restart. Changed inputs, aggregate reconciliation, prior recaps and the final briefing may still need foreground work: background preparation is not an instant-chat guarantee.

**Track preparation spending estimates:** **Settings → Preparation usage** shows estimated USD cost, completed batches and model requests over time, with labelled cost/batch axes and exact bucket details. It retains preparation history, including background summary spend/requests/failures, past automatic work and retries. Completed batches still count only explicit snapshots' first successful briefings—not warm cache. Missing prices stay unavailable or partial. This is **not total spending, a provider invoice or account quota**: chat, voice, standalone post-conversation recaps and local machine/network costs are excluded. Opening the dashboard only reads metadata.

The home page is compact history cards. Each sync has its own `/syncs/:id` URL, with the full briefing, conversations, notes and evidence behind it. **Search history** (`/history`) adds local semantic + keyword retrieval across retained older records, with dated source links. It prepares itself automatically—no enable/update buttons or search-mode choices. Progress counts only new or changed passages, with cached history shown separately and a measured time estimate. Local indexing reuses existing vectors and uses up to two embedding lanes/six CPU threads on sufficiently capable machines; smaller machines stay single-lane. Text questions and calls use it by default. See [MEMORY.md](MEMORY.md) for source scope, first-use download and limitations.

For a plain-English guide to the code, with diagrams and reasons for the main design choices, see [ARCHITECTURE.md](ARCHITECTURE.md). The [standalone visual guide](docs/architecture.html) opens in a browser without connecting to Draken; it contains no live data or app controls. The [Factory execution guide](docs/factory-enrichment.md) covers saved enrichment, one-session execution and required Docker/SDK/credential configuration. Execution scripts are included starting with 0.12.0.

Draken remembers which evidence a finished sync covered, what you decided, and what remains open. Reading logs or generating a response does **not** advance that checkpoint.

## Install and start

Requires Node.js **22.19+** and npm. Session-log indexing and evidence review do not require a model or pi executable. Generated briefings and discussion use **pi 1.4+**. Existing configured pi works unchanged; otherwise **`draken setup`** installs a pinned private runtime and **`draken login`** opens pi’s own authentication interface. See [SETUP.md](SETUP.md) for the full first-run flow, private directories and recovery.

> **Upgrading?** Back up your original agent logs and Draken data first. Versions **0.1.6 and earlier** are the old task dashboard, not this application. See [what changed in 0.15.0](CHANGELOG.md#0150) and [upgrade instructions](SETUP.md#upgrade-to-0150), including idle ending of older inactive sessions.

```sh
npm install -g draken
draken
```

Open **http://127.0.0.1:40333**. Every launch prints the URL and setup instructions. Keep the terminal open; Ctrl+C stops the server, while closing the browser does not. A normal loopback launch needs **no dashboard login or auth setup**. No Docker or Claude installation is needed.

In another terminal, configure your summary runtime and, optionally, voice:

```sh
draken setup             # Confirm private pi installation; --yes for explicit unattended consent
draken login             # Inside pi: /login, follow prompts, then /quit
draken doctor            # Local version/model-credential checks, not a provider request
draken voice setup       # Optional voice: install the pinned native helper
draken voice login       # Separate official ChatGPT sign-in
draken voice status      # Local prerequisites, not an audio test
draken status            # Find the saved server address and verify its live instance
draken tray              # Optional macOS/Windows desktop companion (preview)
```

To choose the activity window at startup, run `draken --history-days 30` or `draken --history-days all`. Widening asks for confirmation because automatic preparation may use provider quota or API billing; scripts can explicitly accept with `--yes`. The choice is saved and shared with Settings. Without the flag, Draken uses the saved choice or 7 days. Stop the server before changing this through the CLI: a second launch fails without changing the setting. While running, use `/settings` instead.

On macOS/Windows desktops, `draken tray` adds a background menu-bar/notification-area icon with status, Open, and owned-server Start/Stop controls. After it reports readiness, the terminal can close. Existing servers are monitored, never taken over. This first version does not register startup at login or replace the pi/voice login flows. Linux/headless use remains the foreground server plus `draken status`. See [TRAY.md](TRAY.md) for lifecycle rules and target-platform qualification still required.

Run setup/login as the server’s user with the same environment. `draken status` remembers the server’s LAN address/port automatically; only a custom `DRAKEN_DATA_DIR` needs to be repeated. Home shows first-run or missing-prerequisite instructions; **Settings → Runtime & sign-in** always exposes them. Click **Check setup again** after login. Setup uses a shipped dependency lockfile and never silently installs at startup, copies existing credentials, changes global pi or authenticates through another coding agent. Model/voice access is not proved by credential presence.

1. Set up [ChatGPT voice](VOICE.md) once. Use localhost or trusted HTTPS.
2. Click **Sync with Draken**. Draken scans, freezes all available entries, summarizes earlier conversations, prepares the briefing, then starts the call on the same visible page. Browser microphone permission may still be required. This is one explicit action, not an automatic call on page load.
3. Talk. Explicitly ending the call requests a short, cached recap; it never saves decisions or marks evidence reviewed.
4. Return home for compact cards, or open any `/syncs/:id` independently. Reopening/reloading a URL never starts capture. **Call Draken** continues an active conversation with the same frozen snapshot; newly prepared history can supplement later turns without changing that snapshot.
5. Use **Chat instead** for a separate text conversation, or expand the detail sections to inspect the briefing/evidence and explicitly save **Decisions** and **Carry into the next sync**. **Mark reviewed** is separate and optional before starting another sync; only that explicit action advances coverage.

**Settings → Automatically prepare history** enables or disables indexing and paid summaries together. Existing saved flags and failure pauses survive upgrades; merely opening Settings does not change consent. An old indexing-only choice remains local-only until you enable the combined control. Old automatically created snapshots remain readable and are never silently resumed. See [background indexing](MEMORY.md#optional-background-indexing) and [paid preparation](MEMORY.md#optional-paid-summary-preparation) for batching, cancellation, saved preferences and upgrade behavior.

**Settings** has its own page at `/settings`, with direct links, reload and browser Back. Opening it does not start a scan or preparation.

**Settings → Agents & sessions** shows each supported agent’s configured directories, recorded sessions, workspace/file paths, first/last message dates, a short last-message preview, ignored-session status, unreviewed counts, inclusion choices and missing-source status. **Scan enabled agents** explicitly refreshes this inventory; opening Settings only reads recorded metadata and directory presence. Readers support **pi v3 JSONL, self-contained Codex CLI rollouts and Claude Code transcripts**. Codex and Claude history require explicit per-agent opt-in; existing pi choices are preserved. The panel shows directory presence separately from recorded sessions, not an installation claim. Summaries still use pi. See [SOURCES.md](SOURCES.md) for paths, supported layouts, migration and limitations. Source selection/scanning lives in this settings panel. The default activity window includes sessions with a message in the last **7 days**, including their older messages. Choose another period or **All history** in this panel. Widening requires confirmation before applying or preparing additional sessions; narrowing takes effect immediately when no foreground work/call is active. Existing fixed baselines and manual exclusions remain in effect. Cached work and saved citations are retained. There are no ordinary model/budget controls. Explicit sync/chat actions authorize their own preparation; background summaries follow the saved preparation consent, on by default. Failed preparation keeps its snapshot and cached work; retry explicitly. Opening a link after preparation requires an explicit call click.

Closing the browser preserves the running job; reloading reconnects to progress. Restarting the server preserves the snapshot and completed summary nodes, but interrupts an active model call; retry to resume from cache. Discarding a sync leaves its evidence uncovered and retains the conversation in history. Expired or discarded snapshots do not make their valid completed processing new work: unreviewed entries carry forward while their summaries and existing embedding vectors remain reusable. The snapshot's newly included/carried-forward counts describe membership, not provider requests or successful preparation. Chat retains the sent question even if its reply fails or is stopped; it never fabricates a completed assistant answer or marks anything reviewed. The older discussion API still saves only completed exchanges. Records from the retired local engine retain their original playback qualifications. Live calls retain ordered generated/interrupted transcripts and supplied context sources, without claiming exact playback or agreement. Reload ends the call and never resumes microphone capture automatically.

An old capped snapshot must be explicitly **expanded to full history** before generating another briefing. Expansion rescans, preserves decisions/discussion and existing citation IDs, archives the obsolete briefing, and establishes a new snapshot time. It does not invoke models or advance coverage.

### Text chat

**Chat instead** is available on Home and beside **Call Draken** on a sync. Home prepares a new snapshot; opening chat on an existing sync reuses its briefing. `/syncs/:id/chat` restores the saved conversation and any running reply. Chat needs configured pi, not voice setup, ChatGPT native sign-in, microphone permission, WebRTC or a secure-context audio API. Dashboard authentication and normal transport-security requirements still apply.

A square Draken portrait accompanies replies. **Searching your prepared history**, **Draken is thinking** and **Checking later updates** follow actual server job stages; they are status cues, not private model reasoning or streamed draft answers. Enter sends; Shift+Enter inserts a newline. **Stop reply** cancels owned work; retry is explicit. A retried delivery with the same request ID does not repeat generation. A new explicit retry after failure uses a new ID and may consume model quota.

Chat replies default to one short paragraph or at most three short bullets, usually 60–100 words plus citations; simple questions can be shorter. Ask for a detailed breakdown when you want one. The model still reads the same evidence and checks later reports: brevity does not mean weaker retrieval or dropped qualifications. This is a response-style instruction, not a hard word limit or an extra shortening-model pass. Opening briefings keep their separate format.

Chat, voice, briefings and recaps are instructed to use simple, direct English without corporate filler or buzzwords. This is a shared model instruction, not a guarantee of every response's wording.

Replies use the sync's configured final text model through pi, with the briefing, recent conversation and project-aware original-history retrieval. Initial briefing and history preparation are required once. Each answer pins one prepared history cutoff; newer prepared originals become dated H evidence between user turns, never changes to the initial E/C references, briefing, saved transcript or notes. Ordinary appends and background scans do not invalidate already captured context or disable prepared chat. True damage, exclusion or loss of captured originals still fails closed. If extra archive lookup is temporarily unavailable during an update, the answer must say so rather than guess or silently fall back. **Refresh history** remains an explicit local update. Chat never opens a native call, implicitly regenerates a ready briefing, saves decisions or marks evidence reviewed. Chat quota/cost is separate from the preparation-only **Est. cost**.

Live status is **Up to date**, **Preparing new info…** or **New info ready**; off/unavailable states are labelled when applicable. Updates do not interrupt an ongoing reply. With automatic indexing enabled, local updates run once a minute for any positive source changes during an active conversation—no 64-record wait and no per-minute paid calls. Voice permits this work while connected and idle between turns, never during a pending reply or context delivery; a user turn preempts and drains owned indexing.

After **30 minutes without a real user chat message or voice turn**, the conversation shows **Session ended**. Creation counts as initial intent; polling, background work, assistant responses and connection heartbeats do not extend it. An ongoing reply finishes first. The ended marker survives restart; reopening or replaying a request cannot revive it. Read the transcript or explicitly edit notes/review the old snapshot, or return home and **Start new sync** to chat again. Idle ending releases unreviewed reservations without deleting history, changing notes, making a recap or marking anything reviewed. Only explicit review covers the initial snapshot, never later H context. See [the lifecycle policy](MEMORY.md#live-conversations-and-idle-ending).

Text and native voice use the same internal evidence-preparation module. The configured summary model first interprets the question and plans retrieval, then selects original evidence from the search results. Project scope, follow-ups, recall and recency are not decided by regexes. Normal project chat uses three model calls (planning, selection, answer); scope refusals use one. Project-specific advice and opinions are welcome; their factual premises need citations, not every recommendation. Clearly unrelated requests receive a short scope message rather than a general-purpose answer. No matches do not mean a request is unrelated. New calls give the shared planner actual prior user turns for continuity. Voice delivers selected originals and nearby messages in acknowledged context parts, then its existing native model answers. Text answers use short reference labels that Draken maps back to original links; quoted citations do not authorize new labels. Missing or invalid labels permit one correction with the same final model. A second citation failure stops the reply without saving the draft. Voice shares selection but not this answer-repair pass: streamed speech is not post-validated. Selection and citation checks do not prove that every claim is true or that every useful source was found. See [MEMORY.md](MEMORY.md#separate-text-chat).

### Model integration

For briefings, conversation recaps and text discussion, Draken invokes `pi --print` with all tools, extensions, MCP, skills, templates, context-file discovery, and session persistence disabled. It runs outside project checkouts and never resumes or writes to your coding sessions. Credentials stay with the selected pi profile—your existing installation or Draken’s private `pi/agent` directory. Pi owns authentication and refresh; Draken does not copy auth files or implement provider login flows.

- **Summary model:** defaults to `openai/gpt-6-luna`. Override with `DRAKEN_PI_SUMMARY_MODEL`; there is no automatic fallback to the stronger model.
- **Final model:** defaults to `openai/gpt-6-astra`. Override with `DRAKEN_PI_FINAL_MODEL` or the legacy `DRAKEN_PI_MODEL`.
- Model and budget controls are intentionally absent from the UI for now. Existing syncs retain their saved settings; the advanced `/api/syncs/:id/models` PATCH endpoint remains available for changing an open sync.
- Selectors use pi's `provider/model` syntax. Catalog presence does not guarantee your subscription/API credential can access that model. Both models must support ordinary text generation; the summary model must reliably emit JSON.
- **Invocation ceiling:** `DRAKEN_PI_MAX_INVOCATIONS` defaults to 120 per briefing/question, including prior-conversation recaps, schema-repair attempts and the final verdict. Paid background preparation uses the same configured `max_invocations` allowance for summary-model work, retaining spent invocations when resuming the same interrupted input. This limits model-generating pi subprocess invocations, not local setup/status checks, provider-internal retries, tokens, or dollars. Exhaustion stops the run without losing cached work. Neither path falls back to another provider/model.

### Summary tree

```text
all eligible entries in a frozen snapshot
  → larger chronological batches within sessions   Luna
  → reuse completed roots alongside new batches
      reconcile only when they exceed the final budget   Luna
  → compact summaries + original evidence excerpts
  → one current-status briefing                    Astra
```

The default Luna path targets **96,000 locally estimated tokens per batch**, instead of 100 entries / 48,000 characters. A 2,000-entry/1 MB planning ceiling bounds allocation, not snapshot coverage. The complete request—including system instructions, short reference labels, metadata and background—is checked before inference, and oversized planned leaves are split without omitting entries. A compact forest goes directly to the final step: no mandatory global, session or topic merge. When reconciliation is needed, the last merge produces the compact current-state input directly. Processing remains serial for predictable cancellation and quotas.

Token planning uses pinned local `gpt-tokenizer@4.1.0` / `o200k_base`, **an estimate rather than a verified GPT-6 server tokenizer or billed usage**. Full input estimates add 20% plus 8,192 tokens of headroom. Planned leaves stay within 160,000 padded tokens; the hard request envelope is 192,000 / 1.5 MB, with 64 KB of output. These limits stay conservatively below pi's currently advertised 272,000 context, despite OpenAI's larger published 1,050,000-token capacity. The pi catalog is not modified; million-token requests are not assumed qualified. Unknown/operator-selected summary models keep their existing conservative tree and limits.

Larger Luna summaries allow up to 96 observations / 24 limitations / 96,000 canonical JSON characters, still at most 16 references per observation. The model is instructed to stay below 60 KB of UTF-8 output (the transport stops at 64 KB); canonical storage has extra room because short citation labels expand to longer source IDs. They aim for much shorter output without dropping distinct work or qualifications. Before Astra, roots must fit 12,000 estimated tokens with provenance and 96 distinct sources. One additional compacting node is allowed, with the usual bounded repair; failure stops visibly rather than looping, dropping entries or silently enlarging the final request. The complete final input is capped at 64,000 padded estimated tokens, preserving original-evidence checks without transferring the raw transcript to the expensive model.

Summaries carry structured states, source IDs, and limitations. Models receive short request-local labels (`S1`, `S2`, etc.; `O1`, `O2` for grouping), which are strictly mapped back to canonical source IDs before caching. Reference fields are translated, not source text; unknown IDs are never guessed or silently dropped. Prompts reconcile earlier plans against later results and preserve contradictions. Validation rejects invented source IDs, invalid schemas, and topic groupings that omit or duplicate observations. Every pending entry must pass through a successful leaf before a final verdict is attempted. That is an **input-processing guarantee, not proof that every fact survived compression**.

A schema failure gets one repair attempt containing a bounded prefix of the rejected response, the specific validation error, and the allowed labels. Empty evidence, unknown IDs, and excess distinct citations are separate errors. When citation count is the only problem, the retry selects references only for the overfull observations instead of rewriting the whole summary. Claims, states, limitations and already-valid citation lists remain unchanged. Selections must come from each observation's original candidates and still pass the 16-reference limit; nothing is blindly truncated, guessed or silently accepted. Citation-only repair preserves those fields and the two-invocation ceiling. Large-batch citation repair supplies complete candidate observations rather than duplicating the rejected response. If repair still fails, generation **stops**—it is not an ongoing job. The UI offers **Resume generation**, which directly continues using valid cached work. The short-label upgrade can reuse previously validated v1 leaf summaries.

Nodes are cached by content fingerprints, model selector, prompt text/version, and node type. Source IDs are independent of sync-local E/C citations, so identical inputs can reuse cache across retries and discarded snapshots. The new planner reuses validated v1/v2 leaf-cache islands and only repacks contiguous uncached ranges; existing cache rows are not wiped. Session records are treated as append-only. Completed receipts and compact roots survive appended entries; only uncovered inputs need new leaf summaries. A small tail can sit alongside the saved current-state root without regenerating it. The broader historical caches remain available rather than being replaced by that selective root. Source opt-outs are checked at preparation boundaries; original bytes are checked when first read and when selected for citation/retrieval, not repeatedly at every cached node. Optional paid background preparation reads eligible accumulated entries without reserving them, and warms these same validated cache keys, reconciliation and compact final input. It owns no sync, snapshot, coverage, message or tree rows. Foreground work cancels and awaits its owned provider work before proceeding; valid cache survives cancellation and restart.

Each run also retains metadata-only request timings, model/task/stage and repair status, input/output sizes, local token estimates, and completion/failure/cancellation state. No prompts or source excerpts go into this telemetry. **Model request timing** in the tree expands these details. Elapsed time includes pi startup, provider waiting and generation; these are not separately measured, and a completed subprocess result can still fail validation. Planning token estimates are not billed usage; timings do not establish model quality. See the [append-only preparation measurements](docs/refactor-reviews/append-only-preparation.md) for the measured startup path and its limits. Existing runs acquire an empty metrics array through an additive migration; no histories, notes, coverage or embeddings are reset.

Each sync card and detail page shows **Est. cost** for its preparation: chunk summaries, consolidation, preparation-time prior recaps, final briefing, and retries/rebuilds for that sync. Later questions, voice calls, standalone conversation recaps and local embeddings are excluded. Preparation consumes pi's bounded JSON event stream and saves only numeric usage, returned model names and the catalog-based USD estimate alongside existing metrics—not raw events, prompts, thinking or signatures. Reasoning is a subset of output, not an extra charge; provider cache reads/writes are distinct from Draken cache hits (which make no new request). The total uses prices reported at call time, never today's prices applied to old calls. **This is an API-equivalent estimate, not a subscription charge, quota measurement or provider invoice.** Missing/zero-filled usage or unavailable catalog pricing stays unavailable; mixed or interrupted records show a partial subtotal. Older syncs cannot be honestly backfilled from the padded planning estimates.

Settings includes a **Preparation usage** dashboard with 6-hour, 1-day, 7-day and 14-day lookbacks, and 1-hour, 6-hour or 24-hour UTC buckets. It shows completed briefing batches, model requests and their recorded API-price estimate, across preparation history, including paid background summaries, past automatic work, retries, failed work and discarded snapshots. Metadata-only `background_runs` retains input hashes, counters and metrics, with no source text. `preparationUsage` includes its spend, requests and failures; `completed_batches` does not count cache preparation. A batch is an explicit snapshot's first successful briefing preparation; rebuilds add cost without counting it again. It is not proof of review or current call readiness. Request costs are placed at their start time, and completed batches at their completion time. New requests have durable timestamps, including pending/interrupted requests; older metrics use the run start and are explicitly approximate. Missing usage/pricing is unavailable or a partial subtotal, never a fabricated zero or a backfill from today's prices. These are estimates, not invoices or subscription/quota balances. Chat, native voice, post-conversation recaps and local machine/network costs are excluded. Opening Settings and changing the time range only read accounting metadata; polling stops when it closes.

The opening briefing uses summaries and verification excerpts, not the entire transcript. Prepared chat reuses that briefing without rebuilding the tree. Questions receive model-selected historical originals with H citations; up to three explicitly requested E/C references can also load frozen excerpts. Each answer pins its prepared-history cutoff. Retrieved history does not change snapshot membership or review coverage. Citation validation checks supplied labels, not whether every claim is true. See [text and voice evidence selection](MEMORY.md#work-questions-and-follow-ups).

The manager is a **read-only conversation**, not a worker. Its responses distinguish intent, attempts, agent-reported implementation, and observed validation, with clickable evidence references. Model-generated claims still need human review. Draken does not independently run tests or verify Git/CI/deployment state.

### Conversation memory and cards

The new workflow freezes the three most recent non-discarded syncs' briefing, discussion and explicit notes at snapshot creation. Their full supplied text passes through cached bounded map/reduce recap jobs; it does not silently select only the final messages. This remains **lossy summarization**, not exhaustive recall or independent verification. Recaps are 1–5 short lines (at most 600 characters), labelled historical summaries rather than agreement. Overlong prose lines can be reflowed at existing spaces without dropping words or qualifications, provided the same five-line/600-character limits still hold. Other invalid responses get one correction, not an unlimited retry. Preparation metrics record content-free validation reasons and line lengths, never rejected recap text. Old source IDs are not treated as this snapshot's citations. Original histories remain available at their own URLs.

The card shows a short recap, or an explicitly labelled briefing preview until one exists, with its body clamped to three visual lines. A changed conversation marks an older recap as stale. Explicitly closing the call UI requests an asynchronous recap using the cheap model (maximum 32 invocations, also bounded by the sync's saved ceiling); interrupted browser exits cannot guarantee that request. **Make recap / Refresh recap** retries explicitly, and the next sync recomputes changed prior inputs from cache. Recaps never change notes, source snapshots or coverage. Neither automatic local indexing nor paid background summary preparation runs these recap or briefing model calls; merely browsing does not start them either. Native recall can reuse these prior-sync recaps, but cannot quote original words from them; historical lookup automatically retrieves retained original excerpts across sessions and syncs through the local hybrid index, separately from frozen discussion and recaps; see [MEMORY.md](MEMORY.md).

The migration adds presentation/recap-cache tables and removes the single-open-sync index without rewriting original rows. Once multiple open snapshots exist, do not blindly downgrade to the old one-open-sync schema. ChatGPT is the only voice engine. Removing the old engine does not remove its historical records, and updating the app does not require restoring an old database.

## What “since last sync” means

- **Indexed** means a complete JSONL entry has been read locally.
- **Included** means that entry belongs to the initial snapshot. An open snapshot reserves its unreviewed entries while its conversation has not ended; a new sync skips those reservations. Multiple independently open syncs are allowed. Discarding or idle-ending one releases its unreviewed reservations, not its saved history.
- **Covered** means that entry was in a snapshot you explicitly finished reviewing.
- Indexing, model calls, saving notes, and cancelled/failed calls never mark evidence covered.
- The initial snapshot is immutable with respect to source activity: later arrivals cannot slip behind its review checkpoint. Newly prepared H history can inform later turns but never expands that coverage.
- A fresh one-click workflow leaves the fixed baseline unset; the separate rolling session-activity window defaults to seven days. Existing fixed baselines are preserved. Entries older than that baseline are excluded from new activity, not falsely marked reviewed; they may still provide background context. The baseline does not move on subsequent syncs. There is no baseline-reset UI yet.
- A new snapshot includes **all eligible, unreviewed indexed entries not reserved by another open, non-ended sync** from the selected sources/history baseline, with no count or character cutoff. The UI paginates evidence without omitting it from processing. Scanner safety limits and excerpt truncation still apply.
- If tree generation was started, finishing is blocked until compression and a valid final reply succeed. Failed/unprocessed evidence remains pending; you do not finish a partial tree as though it represented the whole snapshot.
- Earlier branch context is included separately (up to roughly 24,000 characters) and never counted as new progress.
- New one-click snapshots receive the **three most recent non-discarded syncs** as frozen recaps and saved notes, including unfinished conversations labelled unreviewed. The legacy API retains its last-10-completed-sync decision memory. The latest carry-forward list persists until edited; older lists are historical. Full conversations remain in SQLite; ordinary text questions include the latest 12 current-sync messages, with bounded excerpts.

### Session handling

Default pi source: `~/.pi/agent/sessions/**/*.jsonl` (v3). Opt-in Codex roots are `~/.codex/sessions` and `~/.codex/archived_sessions`; opt-in Claude Code root is `~/.claude/projects`. Enable sources in **Settings → Agents & sessions**, then **Scan enabled agents**. [SOURCES.md](SOURCES.md) describes the adapters and source-only, agent-neutral schema.

The collector:

- Advances byte offsets only over complete LF-terminated records, including safe handling of split UTF-8 characters.
- Reports malformed records and unsupported versions rather than inventing activity.
- Follows persisted parent links for pi and Claude Code, and append chronology for supported Codex rollouts. Unsupported rollback/external-prefix layouts fail visibly rather than guessing the active history.
- Keeps compaction and branch summaries as background, not new accomplishments.
- Applies pi active-branch context edits when preparing new evidence. Already-created sync snapshots remain historical records.
- Deduplicates inherited entries across forks and repeated scans.
- Detects file replacement/truncation and reconciles the local index without rewriting source files.
- Excludes missing/disabled sources and Draken's own data directory. It does not follow source symlinks.

Current limits: discovery is eight directories deep; each scan reads up to 32 MiB per source and a record must fit within the 8 MiB safety limit. Warnings explain when a file needs attention or another scan. Source excerpts are capped at 6,000 characters; truncation is visible. Unknown entry types retain tree linkage but are not automatically considered activity.

## Privacy and deployment

Session logs can contain private source code, prompts, command output, and credentials.

- **Background summarization is on by default and uses your configured provider's quota/API billing; local embedding work itself stays local.** The Sync action prepares previous recaps and a new briefing before calling; explicitly closing the call UI requests a derived recap (idle expiry does not). Voice history lookups invoke the configured pi summary model for evidence selection; the existing native voice model still produces the answer. Calls open a persistent OpenAI audio session at call start; idle/quota accounting is not established. Those explicit actions need no additional checkbox; unattended work follows **Automatically prepare history**, on by default unless explicitly disabled. Scanning and reading evidence stay local. History lookup automatically prepares/updates a local embedding index when needed; first use downloads pinned public weights. Text questions send up to 64 candidate excerpts to the configured summary model for evidence selection, then checked originals to the final model for the answer. Project questions use both calls within the existing invocation allowance; a citation correction can add one more. Unrelated or unclear requests use only the relevance/selection call in text chat. That call also occurs when local search finds no candidates. Voice uses the same evidence selector, then its existing native voice model answers. Duplicate voice lookups reuse their result; up to three distinct lookups share the turn's invocation allowance. Stop, a new question and ending the call cancel unfinished selection. Merely opening a page performs no embedding inference; the saved automatic-indexing schedule runs independently of browsing but never uses provider summary/final models by itself. Background summaries use the configured summary model. In the Factory execution prototype, preparing newly discovered workflows also uses the configured final model within the same preparation allowance; this does not create a briefing or start execution.
- Thinking blocks, system prompts, images, and opaque signatures are not indexed. Tool-call arguments are minimized; common secret patterns are redacted. **This is best-effort, not a guarantee that the remaining text is safe to share.** Inspect evidence and exclude sensitive sessions before calling a provider.
- SQLite contains verified live-session and frozen-snapshot pointers, cached summaries, run metadata, decisions and conversations—not copies of original agent entry bodies. It lives outside the checkout in `~/.draken/draken.db` by default. **Original agent JSONL files are the authoritative archive, including for old snapshots.** Back up both those files and Draken's private state. Missing/changed originals are labelled unavailable; discussion and notes remain accessible, but generating replies, calling or reviewing that snapshot requires restoring its evidence. Search stores passage hashes, unique vectors, source links and contentless keyword postings, not passage bodies. See [MEMORY.md](MEMORY.md) for migration and storage details. There is no in-app retention/purge UI yet.
- The server defaults to loopback with **no dashboard login**. Explicitly configured credentials (or `DRAKEN_NO_AUTH=false`) retain authentication even on loopback. Local API access still rejects cross-origin requests and unexpected Host headers.
- A LAN bind is different from loopback: other devices can reach the server, read session history, and trigger model usage. Non-loopback bindings require authentication. Configure credentials, set `DRAKEN_HOST`, and use an HTTPS reverse proxy preserving Host/Origin or the optional built-in TLS listener. [VOICE.md](VOICE.md) covers trusted LAN microphone access. No-auth mode remains loopback-only.
- No telemetry, update checks, remote fonts, or third-party browser scripts.

### Configuration

Environment variables are read from the process environment; `.env` is **not** automatically loaded. See `.env.example`.

| Variable | Default / purpose |
|---|---|
| `DRAKEN_NO_AUTH` | Unset: no login on loopback unless credentials are configured. `false` forces login; `true` explicitly disables it on loopback only |
| `DRAKEN_USERNAME` | Dashboard username when auth is enabled |
| `DRAKEN_PASSWORD` | Dashboard password when auth is enabled |
| `DRAKEN_JWT_SECRET` | Signing secret when auth is enabled; use a strong random value |
| `DRAKEN_HOST` | `127.0.0.1` |
| `DRAKEN_PORT` | `40333` |
| `DRAKEN_DATA_DIR` | `~/.draken` |
| `DRAKEN_PI_SESSIONS_DIR` | `~/.pi/agent/sessions`; override for custom pi storage |
| `DRAKEN_CODEX_SESSIONS_DIR` | Override Codex transcript root; otherwise uses `CODEX_HOME` (default `~/.codex`) sessions and archived_sessions |
| `DRAKEN_CLAUDE_SESSIONS_DIR` | Override Claude transcript root; otherwise uses `CLAUDE_CONFIG_DIR` (default `~/.claude`)/projects |
| `DRAKEN_PI_BIN` | Explicit summarization executable override, not a shell command; otherwise use the selected private runtime or `pi` on PATH |
| `DRAKEN_PI_SUMMARY_MODEL` | `openai/gpt-6-luna`; summary-model override |
| `DRAKEN_PI_FINAL_MODEL` | `openai/gpt-6-astra`; final-model override |
| `DRAKEN_PI_MODEL` | Legacy final-model override, used when `DRAKEN_PI_FINAL_MODEL` is unset |
| `DRAKEN_PI_MAX_INVOCATIONS` | `120`, bounded to 1–500; server-side default |
| `DRAKEN_PI_TIMEOUT_MS` | `180000` per invocation, bounded to 1–600 seconds |

Native voice setup and TLS environment settings are documented in [VOICE.md](VOICE.md). No new paid voice service is required.

## Visual identity

Draken shares GifGun's blocky Bauhaus style: concrete-gray surfaces, square black borders, hard purple shadows, bold headings, and restrained primary-color accents. The dragon logo stays Draken's own. See [DESIGN.md](DESIGN.md) for the shared palette and rules.

## Compatibility

This is not a drop-in replacement for the old Docker/Claude task dashboard or its APIs. Legacy `projects`/`tasks` tables and historical call records are retained where applicable; old task conversations are not automatically imported. Back up original agent logs and private Draken state before upgrading. Do not use an old binary as a migration rollback.

## Contributing and qualification

Source builds, development commands, test/probe instructions and the code map live in [CONTRIBUTING.md](CONTRIBUTING.md). They are not needed for normal npm installation.

See [ACCEPTANCE.md](ACCEPTANCE.md) for automated gates, a short human product checklist and focused high-risk review areas. The public landing page lives in `site/`; changes there on `master`/`main` trigger the existing website deployment workflow. Its `scripts/site-release.cjs` gate validates the version copy and withholds deployment until npm `latest` matches the root package version. Release copy describes 0.15.0 after release, not evidence of a live deployment. Qualify and publish npm separately before allowing the gated website deployment; this documentation change does not merge, publish or deploy anything. Focused lifecycle/readiness regressions are `tests/conversation.test.cjs`, `tests/live-history-readiness.test.cjs` and `tests/voice-live-updates.test.cjs`; browser coverage is `tests/ui/live-conversation.spec.ts`. Existing cache/consent regressions remain required.

## License

MIT
