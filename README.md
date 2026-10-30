<p align="center"><img src="site/img/logo.png" width="100" alt="Draken"></p>

# Draken — session sync

A local-first engineering sync across your **pi coding sessions**.

> This branch is a prototype of a new direction. It replaces the old Docker/Claude task dashboard; it does not launch coding workers, schedule tasks, or support voice yet.
>
> **Next priority:** cheap-model, cached incremental summaries so a large day's history fits into one sync. The current raw-evidence batches are temporary. See [ROADMAP.md](ROADMAP.md) for the queued approach and community-research questions.

**Scan sessions → review a briefing → talk it through → save decisions → finish the sync.**

Draken remembers which evidence a finished sync covered, what you decided, and what remains open. Reading logs or generating a response does **not** advance that checkpoint.

## Run locally

Requires Node.js **22.19+**. Indexing and evidence review do not require a model or pi executable. Generated briefings and discussion require **pi 1.4+**, already configured with your preferred model and credentials.

```bash
npm ci
npm --prefix client ci
npm run build
DRAKEN_NO_AUTH=true npm start
```

Open **http://127.0.0.1:40333**. No Docker or Claude installation is needed.

1. **Scan local sessions.** This only reads files and updates Draken's local SQLite index.
2. Select the sessions to include. Sources are grouped by their recorded working directory, which is not necessarily a repository boundary.
3. Choose the first-sync history window (**last 24 hours**, **last 7 days**, or **all indexed history**) and **Start sync**. This sets a fixed baseline, not a rolling time filter. Draken rescans and freezes a snapshot. An existing open sync is resumed instead of creating a duplicate.
4. Inspect the evidence. Optionally authorize sending that snapshot to your configured pi model, then **Generate briefing** or ask a question.
5. Edit **Decisions** and **Carry into the next sync**. Save notes whenever you want.
6. Confirm you reviewed the snapshot and **Finish sync**. Only its evidence is marked covered. New activity remains for the next sync.

Closing the browser or restarting the server preserves the open sync. Discarding a sync leaves its evidence uncovered and retains the discarded conversation in history. Failed model calls leave the sync open and do not save a partial exchange.

### Model integration

Draken invokes `pi --print` with all tools, extensions, MCP, skills, templates, context-file discovery, and session persistence disabled. It runs outside project checkouts, supplies only the frozen evidence and discussion, and never resumes or writes to your coding sessions. You can set `DRAKEN_PI_MODEL` to a pi model selector; otherwise pi uses its configured default.

The manager is a **read-only conversation**, not a worker. Its responses distinguish intent, attempts, agent-reported implementation, and observed validation, with clickable evidence references. Model-generated claims still need human review. Draken does not independently run tests or verify Git/CI/deployment state.

## What “since last sync” means

- **Indexed** means a complete JSONL entry has been read locally.
- **Covered** means that entry was in a snapshot you explicitly finished reviewing.
- Indexing, model calls, saving notes, and cancelled/failed calls never mark evidence covered.
- A sync is immutable with respect to source activity: later arrivals cannot slip behind its checkpoint.
- You explicitly choose a first-use history baseline. Entries older than that baseline are excluded from new activity, not falsely marked reviewed; they may still provide background context. The baseline does not move on subsequent syncs. There is no baseline-reset UI yet.
- A snapshot includes at most **100 new evidence entries / roughly 80,000 serialized characters**, interleaved across sessions. Additional entries are explicitly reported and remain eligible for subsequent syncs. This is intentionally not advertised as a complete all-history briefing when there is a backlog.
- Earlier branch context is included separately (up to roughly 24,000 characters) and never counted as new progress.
- The manager receives decisions from the last **10 completed syncs**. The latest carry-forward list persists until you edit it; older carry-forward lists are historical. Full conversations remain in SQLite; each model request includes only the latest 12 discussion messages, with bounded excerpts.

### Session handling

Default source: `~/.pi/agent/sessions/**/*.jsonl` (pi session format v3).

The collector:

- Advances byte offsets only over complete LF-terminated records, including safe handling of split UTF-8 characters.
- Reports malformed records and unsupported versions rather than inventing activity.
- Follows the persisted active branch using entry IDs/parents. Abandoned branch messages are not treated as current progress; in-memory branch navigation is not visible until pi persists another entry.
- Keeps compaction and branch summaries as background, not new accomplishments.
- Applies active-branch context edits when preparing new evidence. Already-created sync snapshots remain historical records.
- Deduplicates inherited entries across forks and repeated scans.
- Detects file replacement/truncation and reconciles the local index without rewriting source files.
- Excludes missing/disabled sources and Draken's own data directory. It does not follow source symlinks.

Current limits: discovery is eight directories deep; each scan reads up to 32 MiB per source and a record must fit within the 8 MiB safety limit. Warnings explain when a file needs attention or another scan. Source excerpts are capped at 6,000 characters; truncation is visible. Unknown entry types retain tree linkage but are not automatically considered activity.

## Privacy and deployment

Session logs can contain private source code, prompts, command output, and credentials.

- **No automatic model calls.** You explicitly authorize briefing/discussion. Scanning and reading evidence stay local.
- Thinking blocks, system prompts, images, and opaque signatures are not indexed. Tool-call arguments are minimized; common secret patterns are redacted. **This is best-effort, not a guarantee that the remaining text is safe to share.** Inspect evidence and exclude sensitive sessions before calling a provider.
- SQLite contains excerpts, decisions, and conversations. It lives outside the checkout in `~/.draken/draken.db` by default. Protect/back up the directory as private data. Deleting original pi files does not erase historical Draken snapshots. There is no in-app retention/purge UI yet.
- The server binds to loopback by default. No-auth mode refuses non-loopback bindings. API requests are authenticated when enabled and reject cross-origin requests.
- For remote use, configure authentication, set `DRAKEN_HOST`, and use an HTTPS reverse proxy preserving the request's Host/Origin. Do not expose no-auth development mode.
- No telemetry, update checks, remote fonts, or third-party browser scripts.

### Configuration

Environment variables are read from the process environment; `.env` is **not** automatically loaded. See `.env.example`.

| Variable | Default / purpose |
|---|---|
| `DRAKEN_NO_AUTH` | `true` disables login for loopback-only use |
| `DRAKEN_USERNAME` | Dashboard username when auth is enabled |
| `DRAKEN_PASSWORD` | Dashboard password when auth is enabled |
| `DRAKEN_JWT_SECRET` | Signing secret when auth is enabled; use a strong random value |
| `DRAKEN_HOST` | `127.0.0.1` |
| `DRAKEN_PORT` | `40333` |
| `DRAKEN_DATA_DIR` | `~/.draken` |
| `DRAKEN_PI_SESSIONS_DIR` | `~/.pi/agent/sessions`; override for custom pi storage |
| `DRAKEN_PI_BIN` | `pi`; executable name/path, not a shell command |
| `DRAKEN_PI_MODEL` | Optional pi model selector |
| `DRAKEN_PI_TIMEOUT_MS` | `180000`, bounded to 1–600 seconds |

## Development and verification

```bash
npm test                         # Backend/indexer/API tests, temporary synthetic sessions, fake pi
npm run build                    # Typecheck and build both applications
npx playwright install chromium --only-shell  # One-time browser setup
npm run test:ui                  # Browser workflow test, desktop + mobile
```

For frontend development, run the backend above and `npm run dev:client` in another terminal. Vite proxies `/api` to port 40333.

Tests never read your real session store or call a model provider. Test sessions are constructed in temporary directories, not copied from private transcripts.

### Code map

```text
src/sync/collector.ts    incremental read-only pi indexer
src/sync/normalize.ts    minimal, bounded, best-effort-redacted evidence
src/sync/store.ts        immutable snapshots, coverage, decisions, history
src/sync/manager.ts      isolated tool-free pi invocation and conversation
src/routes/sync.ts      authenticated sync API
src/db/schema.ts        additive SQLite schema
client/src/pages/Sync.tsx
                        sources, briefing, discussion, notes, evidence
```

Legacy `projects`/`tasks` tables are left intact in existing databases; there is no automatic import of old Claude conversations. Docker, task execution, terminal streaming, mount management, and Git mutation endpoints have been removed. The published marketing site under `site/` is intentionally unchanged in this prototype branch.

## License

MIT
