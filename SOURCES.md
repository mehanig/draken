# Agent history sources

Draken reads **pi, Codex CLI and Claude Code** JSONL histories. These are source adapters, not coding-agent execution engines. It does not run Codex/Claude to import their logs, copy their credentials, execute recorded tools, or change the source files. **Summaries, recaps and text replies still use the existing isolated, tool-free pi runner and its configured models.** ChatGPT native voice remains separate.

## Settings and discovery

Open **Settings → Agents & sessions**. Each adapter shows its configured directories, directory-presence status, recorded sessions, native IDs, workspace/file paths, inclusion choices and missing-source status. A directory being present does not establish that an executable is installed, logged in, or that every file has been parsed.

- Existing pi sessions and exclusions survive the migration. Pi history is enabled by default.
- **Codex and Claude history are off until explicitly enabled.** An existing background-indexing preference does not silently gain access to new transcripts.
- Enabling an agent persists its permission; it does not itself scan, download a model, summarize, create a sync or acquire a microphone. The next explicit scan/sync, or an already opted-in background schedule, may read its logs.
- **Scan enabled agents** discovers and parses enabled roots only. New sessions from enabled agents are selected by default. Each session can be excluded independently.
- Disabled agents are excluded from new snapshots and historical retrieval. Disabling does not rewrite existing frozen snapshots or erase discussions, notes or derived files.
- Merely opening/polling Settings reads database metadata and directory existence, not transcript bodies.

| Agent | Default roots | Explicit override |
|---|---|---|
| pi | `~/.pi/agent/sessions` | `DRAKEN_PI_SESSIONS_DIR` |
| Codex CLI | `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`, with `CODEX_HOME` defaulting to `~/.codex` | `DRAKEN_CODEX_SESSIONS_DIR` selects one root instead |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects`, with the config directory defaulting to `~/.claude` | `DRAKEN_CLAUDE_SESSIONS_DIR` |

The overview API retains its old `session_root` field as a read-only pi compatibility field; new consumers use `agents[].roots` and each session's `agent`/`external_id`.

Root overrides are server environment settings, not arbitrary filesystem paths supplied by browser requests. The worker receives an explicit per-agent root allowlist, not credentials or the server environment. Directory traversal is bounded to eight levels. Source symlinks are not followed during discovery; record reads verify real-path containment, regular-file identity, header/session identity, raw bytes and hashes. Each import pass reads at most 32 MiB per file; a scan repeats those bounded passes until it reaches that file's captured end. It does not chase later appends. Complete LF-terminated records remain bounded to 8 MiB, and an unfinished final record waits for another scan. Committed chunks survive cancellation, but an interrupted or failed import is not a completed capture. Snapshot routes reject scan warnings rather than freezing a partial import. Pre-call preparation scans before indexing, and readiness requires each admitted source's completed capture marker (`agent_sessions.scanned_bytes`), not just its modification time or imported cursor. Older rows default to `-1` (unverified) and are revalidated from the beginning; `0` marks an incomplete import and a positive value its completed captured size. A failed chunk never advances past malformed records. A persisted scan-completion flag also blocks readiness after cancellation or a discovery error, including errors in new files that have no imported row yet. Later appends can wait for the next preparation; original byte/hash verification still applies at retrieval.

## Adapter recipes

All three adapters minimize excerpts and apply the existing versioned redaction/clipping rules. Thinking, opaque signatures, system/developer instructions, images, audio and arbitrary write-file payloads are not source evidence. Tool requests preserve bounded intent/paths rather than file bodies; tool results remain qualified observations, not independent verification of the whole project. Redaction is best-effort, not a guarantee that transcripts are secret-free.

### pi

The existing v3 header, entry IDs/parents, active branch, context edits and background-summary behavior are unchanged. Existing normalization versions remain available to reconstruct older snapshots exactly. Existing IDs, event keys and reference identities are not renamed merely to add an agent label.

### Codex CLI

Supported self-contained rollout logs begin with `session_meta` carrying `payload.id` and `payload.cwd`. The adapter reads `response_item` user/assistant text, bounded function/custom-tool intent, tool output, compaction background and interruption status. Duplicate `event_msg` user/assistant transcript echoes are not imported a second time. Reasoning and request-context records are ignored.

Codex records do not always have message IDs. Physical offsets identify occurrences within a file; event identities are content/agent-domain hashes, and frozen evidence pins exact record bytes. Chronology is append order, not an invented parent tree.

**External `history_base` references, rollback replay and event-only layouts without response-item evidence are not supported by this recipe.** Such files fail visibly rather than guessing an inherited prefix or presenting abandoned turns as current. They require a separately qualified adapter extension. Unknown provider payloads are not automatically promoted to activity.

### Claude Code

Supported transcript records carry `sessionId`, `uuid`, `cwd`, timestamps and message content. UUID/parent links select the persisted conversation branch; linked compact boundaries preserve earlier history, and compact summaries stay background. Progress/request metadata may bridge parent links but cannot select a new conversation branch by itself. A sidechain's recorded agent ID, or first sidechain message UUID, separates subagent files that share their parent's `sessionId`.

The reader does not parse `history.jsonl`, credentials, project memory files or feedback bundles. Superseded/orphaned transcript copies are not treated as new sessions. Mixed session identities, conflicting bodies under one UUID and unlinked compact boundaries fail visibly instead of dropping earlier evidence or guessing attribution. Synthetic fixtures cover the supported layouts; that is not a claim of compatibility with every past/future Claude release or third-party exporter.

## Generic schema and migration

The canonical schema uses:

- `agent_sources`: persistent per-agent enablement, separate from automatic indexing.
- `agent_sessions`: stable Draken ID, agent kind, native `external_id`, source path, workspace, selection, missing status, file identity, offsets and current branch.
- `agent_entries`: stable numeric IDs, session/entry identities, chronological/branch metadata, versioned parser and normalization recipes, verified raw-record pointers and projected lengths. No copied original transcript bodies.

`source_schema=agents-v1` accompanies the existing source-only storage marker. Startup performs the old-table rename and any necessary pointer conversion **inside one SQLite transaction**. `pi_sessions` and `pi_entries` become `agent_sessions` and `agent_entries`; there are no duplicate tables or writable compatibility aliases. Existing pi IDs, numeric sequences, snapshots, discussions, notes, review coverage and summary caches remain intact. A failure rolls back, not partially converts or guesses.

New non-pi session IDs are namespaced (`codex:<id>`, `claude:<id>`, `claude:<id>:<subagent>`). Agent-domain event hashes prevent equal native IDs in different agents from sharing review coverage. Legacy pi IDs remain unchanged for compatibility.

Existing pi frozen pointers retain their v1 recipe. Foreign-source v2 pointers additionally pin agent, native identity and parser version. Reads reconstruct from the authoritative original file, verify its original hash, role, timestamp and projected text, and reject changed/missing originals. Current mutable branch state cannot redirect an older snapshot.

The separate contentless FTS/vector schema and pinned embedding fingerprint are unchanged. Migration does not re-embed existing pi history. Adding genuinely new admitted Codex/Claude text creates normal delta work; unchanged compatible vectors remain reusable. The background threshold remains **64 changed source records, with no timed small-batch flush**.

## Durability and qualification

Back up **all enabled agents' original logs and Draken's private state**. Agent retention/purge commands can remove the originals that frozen evidence still needs; Draken does not override those policies or retain a hidden text copy. Conversations and explicit notes remain available if originals disappear, but affected evidence, generation, calls and review fail visibly.

Tests use synthetic JSONL, synthetic pi responses and isolated databases. Migration qualification compares a private copy of current pi data and its references/vectors; it does not add foreign transcripts to production or make provider calls. No real local Codex/Claude history was available on the qualification host, so unsupported vendor layouts must be surfaced and investigated rather than claimed compatible.

Format references consulted:

- [Codex protocol source](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
- [Codex response-item models](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs)
- [Claude Code session storage](https://code.claude.com/docs/en/how-claude-code-works#work-with-sessions)
- [Claude Code application data and retention](https://code.claude.com/docs/en/claude-directory#application-data)
