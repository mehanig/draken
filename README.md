<p align="center"><img src="site/img/logo.png" width="100" alt="Draken"></p>

# Draken — engineering sync

A local-first engineering sync across your **pi, Codex CLI and Claude Code sessions**. Session readers are agent-neutral; summarization still runs through pi.

> Draken is a read-only companion, not a task runner. It replaces the old Docker/Claude dashboard and does not launch coding workers or schedule tasks. Voice calls use only **ChatGPT live voice**, through a separate native sign-in to the same paid account. The previous local speech engine has been removed; historical call records are preserved. Voice sends audio to OpenAI; generated transcripts are not verified claims or exact playback records; see [VOICE.md](VOICE.md). Calls include a local animated **3D dragon persona**, with a standalone `/persona.html` preview; see [PERSONA.md](PERSONA.md).
>
> **Large histories now use a cached summary tree:** cheaper-model parsing and reconciliation, followed by a stronger-model verdict. The old raw-evidence snapshot cutoff is removed. This is still lossy model compression, not independent verification. See [ROADMAP.md](ROADMAP.md) for remaining quality evaluation and community research.

**Sync with Draken → call or chat → keep a short recap.**

**Draken 0.5.0** enables automatic preparation by default for new installations and keeps chat replies short unless you ask for detail. Existing preparation choices are preserved. See [the release notes](CHANGELOG.md#050).

**Automatic preparation and compaction:** new installations index history, summarize new work and prepare a briefing automatically while the server runs. Turn this off in **Settings → Automatically prepare conversations** if you prefer manual preparation. Existing installations keep their previous behavior, including off and older local-index-only permission. Compaction means cached, derived summaries—not editing or deleting your original agent logs. Matching summaries and ready briefings are reused. This mode uses your configured models and their quota or API billing within the saved invocation limit; it never starts a call or marks work reviewed.

**Track preparation spending estimates:** **Settings → Preparation usage** shows estimated USD cost, completed batches and model requests over time, with labelled cost/batch axes and exact bucket details. It includes manual/automatic preparation, retries and failed work. Missing prices stay unavailable or partial. This is **not total spending, a provider invoice or account quota**: chat, voice, standalone post-conversation recaps and local machine/network costs are excluded. Opening the dashboard only reads metadata.

The home page is compact history cards. Each sync has its own `/syncs/:id` URL, with the full briefing, conversations, notes and evidence behind it. **Search history** (`/history`) adds local semantic + keyword retrieval across retained older records, with dated source links. It prepares itself automatically—no enable/update buttons or search-mode choices. Progress counts only new or changed passages, with cached history shown separately and a measured time estimate. Local indexing reuses existing vectors and uses up to two embedding lanes/six CPU threads on sufficiently capable machines; smaller machines stay single-lane. Text questions and calls use it by default. See [MEMORY.md](MEMORY.md) for source scope, first-use download and limitations.

For a plain-English guide to the code, with diagrams and reasons for the main design choices, see [ARCHITECTURE.md](ARCHITECTURE.md). The [standalone visual guide](docs/architecture.html) opens in a browser without connecting to Draken; it contains no live data or app controls.

Draken remembers which evidence a finished sync covered, what you decided, and what remains open. Reading logs or generating a response does **not** advance that checkpoint.

## Install and start

Requires Node.js **22.19+** and npm. Session-log indexing and evidence review do not require a model or pi executable. Generated briefings and discussion use **pi 1.4+**. Existing configured pi works unchanged; otherwise **`draken setup`** installs a pinned private runtime and **`draken login`** opens pi’s own authentication interface. See [SETUP.md](SETUP.md) for the full first-run flow, private directories and recovery.

> **Upgrading?** Back up your original agent logs and Draken data first. Versions **0.1.6 and earlier** are the old task dashboard, not this application. See [what changed in 0.5.0](CHANGELOG.md#050).

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

On macOS/Windows desktops, `draken tray` adds a background menu-bar/notification-area icon with status, Open, and owned-server Start/Stop controls. After it reports readiness, the terminal can close. Existing servers are monitored, never taken over. This first version does not register startup at login or replace the pi/voice login flows. Linux/headless use remains the foreground server plus `draken status`. See [TRAY.md](TRAY.md) for lifecycle rules and target-platform qualification still required.

Run setup/login as the server’s user with the same environment. `draken status` remembers the server’s LAN address/port automatically; only a custom `DRAKEN_DATA_DIR` needs to be repeated. Home shows first-run or missing-prerequisite instructions; **Settings → Runtime & sign-in** always exposes them. Click **Check setup again** after login. Setup uses a shipped dependency lockfile and never silently installs at startup, copies existing credentials, changes global pi or authenticates through another coding agent. Model/voice access is not proved by credential presence.

1. Set up [ChatGPT voice](VOICE.md) once. Use localhost or trusted HTTPS.
2. Click **Sync with Draken**. Draken scans, freezes all available entries, summarizes earlier conversations, prepares the briefing, then starts the call on the same visible page. Browser microphone permission may still be required. This is one explicit action, not an automatic call on page load.
3. Talk. Ending the call requests a short, cached recap; it never saves decisions or marks evidence reviewed.
4. Return home for compact cards, or open any `/syncs/:id` independently. Reopening/reloading a URL never starts capture. **Call Draken** resumes discussion of that frozen snapshot without collecting later activity.
5. Use **Chat instead** for a separate text conversation, or expand the detail sections to inspect the briefing/evidence and explicitly save **Decisions** and **Carry into the next sync**. **Mark reviewed** is separate and optional before starting another sync; only that explicit action advances coverage.

**Settings → Automatically prepare conversations** is one mode for the whole preparation pipeline: scan history, update local search, summarize new entries and prepare the opening briefing before you arrive. It is on by default only for new installations and persists across restarts. Existing installations retain their previous choice; an absent preference on upgrade remains off. Checks run once a minute while idle; 64 changed source records or waiting entries trigger a batch, and interrupted batches resume from cache. Smaller new tails wait for foreground preparation, with no timed flush. Home and Settings show the current stage, summary progress and last completed batch. Joining an unchanged prepared batch reuses its snapshot and briefing; later entries get a new snapshot with the earlier preparation as historical context. Existing conversations, notes and frozen evidence are never rewritten or marked reviewed. Calls and foreground work take priority.

When enabled (including the new-install default), this single mode uses **configured pi summary/final models**, including account quota or API billing, bounded by each snapshot's saved invocation limit (120 by default). Provider failures pause automatic retries until an explicit retry; completed work is retained. There is no microphone capture or automatic call. An older local-index-only opt-in does not silently authorize this wider scope: enable the replacement switch once after upgrading. First use may download the pinned local search model. Agent/session exclusions remain respected; enabling other agents still requires their own source consent.

**Settings → Agents & sessions** shows each supported agent’s configured directories, recorded sessions, workspace/file paths, last recorded changes, unreviewed counts, inclusion choices and missing-source status. **Scan enabled agents** explicitly refreshes this inventory; opening Settings only reads recorded metadata and directory presence. Readers support **pi v3 JSONL, self-contained Codex CLI rollouts and Claude Code transcripts**. Codex and Claude history require explicit per-agent opt-in; existing pi choices are preserved. The panel shows directory presence separately from recorded sessions, not an installation claim. Summaries still use pi. See [SOURCES.md](SOURCES.md) for paths, supported layouts, migration and limitations. Source selection/scanning lives in this settings panel. A fresh installation includes all indexed history; an existing fixed baseline is preserved. There are no ordinary model/budget controls or extra inference permission checkboxes. Failed preparation keeps its snapshot and cached work; retry explicitly. Opening a link after preparation requires an explicit call click.

Closing the browser preserves the running job; reloading reconnects to progress. Restarting the server preserves the snapshot and completed summary nodes, but interrupts an active model call; retry to resume from cache. Discarding a sync leaves its evidence uncovered and retains the conversation in history. Chat retains the sent question even if its reply fails or is stopped; it never fabricates a completed assistant answer or marks anything reviewed. The older discussion API still saves only completed exchanges. Records from the retired local engine retain their original playback qualifications. Live calls retain ordered generated/interrupted transcripts and supplied context sources, without claiming exact playback or agreement. Reload ends the call and never resumes microphone capture automatically.

An old capped snapshot must be explicitly **expanded to full history** before generating another briefing. Expansion rescans, preserves decisions/discussion and existing citation IDs, archives the obsolete briefing, and establishes a new snapshot time. It does not invoke models or advance coverage.

### Text chat

**Chat instead** is available on Home and beside **Call Draken** on a sync. Home prepares a new snapshot; opening chat on an existing sync reuses its briefing. `/syncs/:id/chat` restores the saved conversation and any running reply. Chat needs configured pi, not voice setup, ChatGPT native sign-in, microphone permission, WebRTC or a secure-context audio API. Dashboard authentication and normal transport-security requirements still apply.

A square Draken portrait accompanies replies. **Searching your prepared history**, **Draken is thinking** and **Checking later updates** follow actual server job stages; they are status cues, not private model reasoning or streamed draft answers. Enter sends; Shift+Enter inserts a newline. **Stop reply** cancels owned work; retry is explicit. A retried delivery with the same request ID does not repeat generation. A new explicit retry after failure uses a new ID and may consume model quota.

Chat replies default to one short paragraph or at most three short bullets, usually 60–100 words plus citations; simple questions can be shorter. Ask for a detailed breakdown when you want one. The model still reads the same evidence and checks later reports: brevity does not mean weaker retrieval or dropped qualifications. This is a response-style instruction, not a hard word limit or an extra shortening-model pass. Opening briefings keep their separate format.

Replies use the sync's configured final text model through pi, with the briefing, recent conversation and project-aware original-history retrieval. The prepared archive has a displayed cutoff; new chat messages are supplied directly without rebuilding corpus embeddings after every turn. **Refresh history** admits later work. Changed, excluded or unavailable original sources still block readiness. Chat never opens a native call, implicitly regenerates a ready briefing, saves decisions or marks evidence reviewed. Chat quota/cost is separate from the preparation-only **Est. cost**.

For status questions, chat and native voice use the same bounded original-evidence selection and check later related reports before repeating old blockers, including follow-ups to a report that was itself superseded. New calls inherit project focus from actual saved user turns. Voice delivers the larger evidence packet through bounded native context parts while keeping spoken answers concise; it does not add a pi generation step. The following answer-repair check remains text-only; streamed speech is not post-validated. Client implementation, backend foundations, delivery enablement and device acceptance are kept distinct. The final model uses short per-answer reference labels, which Draken maps back to admitted original links; quoted historical citations never authorize new references. Bad/missing citations and ignored later follow-ups share one bounded same-model correction, with the same label catalog in both calls. A second validation failure remains visible without saving an unsupported draft. Retrieval and citation consistency do not independently verify the agent's claims; see [MEMORY.md](MEMORY.md#separate-text-chat) for bounds and voice differences.

### Model integration

For briefings, conversation recaps and text discussion, Draken invokes `pi --print` with all tools, extensions, MCP, skills, templates, context-file discovery, and session persistence disabled. It runs outside project checkouts and never resumes or writes to your coding sessions. Credentials stay with the selected pi profile—your existing installation or Draken’s private `pi/agent` directory. Pi owns authentication and refresh; Draken does not copy auth files or implement provider login flows.

- **Summary model:** defaults to `openai/gpt-6-luna`. Override with `DRAKEN_PI_SUMMARY_MODEL`; there is no automatic fallback to the stronger model.
- **Final model:** defaults to `openai/gpt-6-astra`. Override with `DRAKEN_PI_FINAL_MODEL` or the legacy `DRAKEN_PI_MODEL`.
- Model and budget controls are intentionally absent from the UI for now. Existing syncs retain their saved settings; the advanced `/api/syncs/:id/models` PATCH endpoint remains available for changing an open sync.
- Selectors use pi's `provider/model` syntax. Catalog presence does not guarantee your subscription/API credential can access that model. Both models must support ordinary text generation; the summary model must reliably emit JSON.
- **Invocation ceiling:** `DRAKEN_PI_MAX_INVOCATIONS` defaults to 120 per briefing/question, including prior-conversation recaps, schema-repair attempts and the final verdict. This limits model-generating pi subprocess invocations, not local setup/status checks, provider-internal retries, tokens, or dollars. Exhaustion stops the run without losing cached work.

### Summary tree

```text
all eligible entries in a frozen snapshot
  → larger chronological batches within sessions   Luna
  → global reconciliation across batches           Luna
      extra levels only when combined input is too large
  → compact summaries + original evidence excerpts
  → one current-status briefing                    Astra
```

The default Luna path targets **96,000 locally estimated tokens per batch**, instead of 100 entries / 48,000 characters. A 2,000-entry/1 MB planning ceiling bounds allocation, not snapshot coverage. The complete request—including system instructions, short reference labels, metadata and background—is checked before inference, and oversized planned leaves are split without omitting entries. Multiple leaves normally need one global reconciliation: no mandatory session-merge, topic-routing or topic-merge passes. A single compact leaf goes directly to the final step. Processing remains serial for predictable cancellation and quotas.

Token planning uses pinned local `gpt-tokenizer@4.1.0` / `o200k_base`, **an estimate rather than a verified GPT-6 server tokenizer or billed usage**. Full input estimates add 20% plus 8,192 tokens of headroom. Planned leaves stay within 160,000 padded tokens; the hard request envelope is 192,000 / 1.5 MB, with 64 KB of output. These limits stay conservatively below pi's currently advertised 272,000 context, despite OpenAI's larger published 1,050,000-token capacity. The pi catalog is not modified; million-token requests are not assumed qualified. Unknown/operator-selected summary models keep their existing conservative tree and limits.

Larger Luna summaries allow up to 96 observations / 24 limitations / 96,000 canonical JSON characters, still at most 16 references per observation. The model is instructed to stay below 60 KB of UTF-8 output (the transport stops at 64 KB); canonical storage has extra room because short citation labels expand to longer source IDs. They aim for much shorter output without dropping distinct work or qualifications. Before Astra, roots must fit 12,000 estimated tokens with provenance and 96 distinct sources. One additional compacting node is allowed, with the usual bounded repair; failure stops visibly rather than looping, dropping entries or silently enlarging the final request. The complete final input is capped at 64,000 padded estimated tokens, preserving original-evidence checks without transferring the raw transcript to the expensive model.

Summaries carry structured states, source IDs, and limitations. Models receive short request-local labels (`S1`, `S2`, etc.; `O1`, `O2` for grouping), which are strictly mapped back to canonical source IDs before caching. Reference fields are translated, not source text; unknown IDs are never guessed or silently dropped. Prompts reconcile earlier plans against later results and preserve contradictions. Validation rejects invented source IDs, invalid schemas, and topic groupings that omit or duplicate observations. Every pending entry must pass through a successful leaf before a final verdict is attempted. That is an **input-processing guarantee, not proof that every fact survived compression**.

A schema failure gets one repair attempt containing a bounded prefix of the rejected response, the specific validation error, and the allowed labels. Empty evidence, unknown IDs, and excess distinct citations are separate errors. When citation count is the only problem, the retry selects references only for the overfull observations instead of rewriting the whole summary. Claims, states, limitations and already-valid citation lists remain unchanged. Selections must come from each observation's original candidates and still pass the 16-reference limit; nothing is blindly truncated, guessed or silently accepted. Citation-only repair preserves those fields and the two-invocation ceiling. Large-batch citation repair supplies complete candidate observations rather than duplicating the rejected response. If repair still fails, generation **stops**—it is not an ongoing job. The UI offers **Resume generation**, which directly continues using valid cached work. The short-label upgrade can reuse previously validated v1 leaf summaries.

Nodes are cached by content fingerprints, model selector, prompt text/version, and node type. Source IDs are independent of sync-local E/C citations, so identical inputs can reuse cache across retries and discarded snapshots. The new planner reuses validated v1/v2 leaf-cache islands and only repacks contiguous uncached ranges; existing cache rows are not wiped. Unchanged closed batches reuse their keys when history is appended; an unfinished tail and affected reconciliation are recomputed. Changed selection/background can still move boundaries. There is no endlessly rewritten project-memory summary.

Each run also retains metadata-only request timings, model/task/stage and repair status, input/output sizes, local token estimates, and completion/failure/cancellation state. No prompts or source excerpts go into this telemetry. **Model request timing** in the tree expands these details. Elapsed time includes pi startup, provider waiting and generation; these are not separately measured, and a completed subprocess result can still fail validation. Planning token estimates are not billed usage; real-history speed/quality comparisons remain unqualified. Existing runs acquire an empty metrics array through an additive migration; no histories, notes, coverage or embeddings are reset.

Each sync card and detail page shows **Est. cost** for its preparation: chunk summaries, consolidation, preparation-time prior recaps, final briefing, and retries/rebuilds for that sync. Later questions, voice calls, standalone conversation recaps and local embeddings are excluded. Preparation consumes pi's bounded JSON event stream and saves only numeric usage, returned model names and the catalog-based USD estimate alongside existing metrics—not raw events, prompts, thinking or signatures. Reasoning is a subset of output, not an extra charge; provider cache reads/writes are distinct from Draken cache hits (which make no new request). The total uses prices reported at call time, never today's prices applied to old calls. **This is an API-equivalent estimate, not a subscription charge, quota measurement or provider invoice.** Missing/zero-filled usage or unavailable catalog pricing stays unavailable; mixed or interrupted records show a partial subtotal. Older syncs cannot be honestly backfilled from the padded planning estimates.

Settings includes a **Preparation usage** dashboard with 6-hour, 1-day, 7-day and 14-day lookbacks, and 1-hour, 6-hour or 24-hour UTC buckets. It shows completed briefing batches, model requests and their recorded API-price estimate, across automatic and manual preparation—including retries, failed work and discarded snapshots. A batch is a snapshot's first successful briefing preparation; rebuilds add cost without counting it again. It is not proof of review or current call readiness. Request costs are placed at their start time, and completed batches at their completion time. New requests have durable timestamps, including pending/interrupted requests; older metrics use the run start and are explicitly approximate. Missing usage/pricing is unavailable or a partial subtotal, never a fabricated zero or a backfill from today's prices. These are estimates, not invoices or subscription/quota balances. Chat, native voice, post-conversation recaps and local machine/network costs are excluded. Opening Settings and changing the time range only read accounting metadata; polling stops when it closes.

The final model receives bounded summaries, raw verification excerpts, saved decisions, and recent conversation—not the entire transcript. Questions additionally retrieve up to 16 raw snapshot entries and automatically receive a bounded hybrid-search packet from retained earlier history, with separate global H citations. The separate chat surface requires prepared history and uses its captured cutoff; ordinary standalone search and the older discussion API can prepare the local index as needed. Wider history is not added to the frozen snapshot. Final citation validation checks reference existence and, for text status replies, whether cited checkpoints address their supplied follow-ups. Neither check proves that every claim is actually supported.

The manager is a **read-only conversation**, not a worker. Its responses distinguish intent, attempts, agent-reported implementation, and observed validation, with clickable evidence references. Model-generated claims still need human review. Draken does not independently run tests or verify Git/CI/deployment state.

### Conversation memory and cards

The new workflow freezes the three most recent non-discarded syncs' briefing, discussion and explicit notes at snapshot creation. Their full supplied text passes through cached bounded map/reduce recap jobs; it does not silently select only the final messages. This remains **lossy summarization**, not exhaustive recall or independent verification. Recaps are 1–5 short lines (at most 600 characters), labelled historical summaries rather than agreement. Overlong prose lines can be reflowed at existing spaces without dropping words or qualifications, provided the same five-line/600-character limits still hold. Other invalid responses get one correction, not an unlimited retry. Preparation metrics record content-free validation reasons and line lengths, never rejected recap text. Old source IDs are not treated as this snapshot's citations. Original histories remain available at their own URLs.

The card shows a short recap, or an explicitly labelled briefing preview until one exists, with its body clamped to three visual lines. A changed conversation marks an older recap as stale. Closing the call UI requests an asynchronous recap using the cheap model (maximum 32 invocations, also bounded by the sync's saved ceiling); interrupted browser exits cannot guarantee that request. **Make recap / Refresh recap** retries explicitly, and the next sync recomputes changed prior inputs from cache. Recaps never change notes, source snapshots or coverage. Enabled automatic preparation also permits these preparation recaps and briefing model calls in the background; merely browsing does not. Native recall can reuse these prior-sync recaps, but cannot quote original words from them; historical lookup automatically retrieves retained original excerpts across sessions and syncs through the local hybrid index, separately from frozen discussion and recaps; see [MEMORY.md](MEMORY.md).

The migration adds presentation/recap-cache tables and removes the single-open-sync index without rewriting original rows. Once multiple open snapshots exist, do not blindly downgrade to the old one-open-sync schema. ChatGPT is the only voice engine. Removing the old engine does not remove its historical records, and updating the app does not require restoring an old database.

## What “since last sync” means

- **Indexed** means a complete JSONL entry has been read locally.
- **Included** means that entry is already held by an open snapshot. A new sync skips it, even though it is not reviewed. Multiple independently open syncs are allowed; discarding one releases its unreviewed entries.
- **Covered** means that entry was in a snapshot you explicitly finished reviewing.
- Indexing, model calls, saving notes, and cancelled/failed calls never mark evidence covered.
- A sync is immutable with respect to source activity: later arrivals cannot slip behind its checkpoint.
- A fresh one-click workflow initializes the baseline to all history; existing baselines are preserved. Entries older than that baseline are excluded from new activity, not falsely marked reviewed; they may still provide background context. The baseline does not move on subsequent syncs. There is no baseline-reset UI yet.
- A new snapshot includes **all eligible, unreviewed indexed entries not held by another open sync** from the selected sources/history baseline, with no count or character cutoff. The UI paginates evidence without omitting it from processing. Scanner safety limits and excerpt truncation still apply.
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

- **Provider-model use starts through conversation/preparation actions or the explicitly enabled combined automatic-preparation mode.** The combined action prepares previous recaps and a new briefing before calling; closing the call UI requests a derived recap. Voice turns do not invoke pi. Calls open a persistent OpenAI audio session at call start; idle/quota accounting is not established. There is no separate permission checkbox. Scanning and reading evidence stay local. History lookup automatically prepares/updates a local embedding index when needed; first use downloads pinned public weights. Text questions and calls receive relevant historical excerpts by default through their existing model. Merely opening a page performs no embedding inference; the explicitly enabled automatic-preparation schedule runs independently of browsing and can also use the configured summary/final models.
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

See [ACCEPTANCE.md](ACCEPTANCE.md) for automated gates, a short human product checklist and focused high-risk review areas. The public landing page lives in `site/`; merging changes there to `master` triggers the existing website deployment workflow. npm publication and application deployment are separate steps.

## License

MIT
