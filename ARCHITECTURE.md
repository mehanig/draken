# How Draken is built

This guide describes Draken 0.8.1, not the older Docker/task dashboard or a claim of live deployment. The diagrams are plain text so they also work in a terminal. For a browser-friendly version, open the self-contained [visual architecture guide](docs/architecture.html). It needs no app login and contains no live data or executable controls.

## 1. What Draken does

Draken helps you understand work spread across pi coding sessions. You collect new activity into a **sync**: a conversation attached to a fixed selection of pointer-backed evidence. Draken prepares a briefing, lets you discuss it, and keeps the conversation for later.

It can read coding history, summarize it, and save its own records. It cannot use a model to run commands, edit your projects, deploy work, or decide that you have reviewed something.

**“Read-only” describes its access to your coding work.** Draken still writes its own database when you start a sync, talk, save notes, or mark a snapshot reviewed.

## 2. The main pieces

```text
Browser: home, sync detail, call controls, animated dragon
    |
    | Requests and replies over HTTP, or HTTPS on the LAN
    v
One Node.js server (Express)
    |
    +-- reads ------> enabled pi / Codex / Claude session files
    |                 Original files are never rewritten by Draken
    |
    +-- reads/writes -> SQLite database
    |                  Snapshots, conversations, notes, progress, saved summaries
    |
    +-- starts ------> isolated pi process ------> text model provider
    |                  Briefings, recaps and text questions (not voice turns)
    |
    +-- manages -----> native ChatGPT voice helper
                       The only voice engine; see section 7
```

The browser shows information and owns microphone/playback controls. The server owns records, checks requests, and starts model work. Each data directory has **one server owner**; active jobs and call ownership use process-local leases. `src/server-ownership.ts` enforces exclusion with a kernel-backed SQLite exclusive transaction on the private `.server-owner.sqlite` file, separate from application data. A suspended process keeps ownership; process death releases the kernel lock. No heartbeat expiry or recorded PID authorizes takeover or termination.

**Why:** this is a personal tool. One server and one database are easier to run and back up than several services. The tradeoff is that this is not a multi-user service that can be spread across several servers unchanged.

### Languages and build output

| Part | Language / tool | Why it is here |
|---|---|---|
| Server, indexing, summaries, storage | TypeScript on Node.js | Check data shapes and keep the main application in one language |
| Browser application | TypeScript, React, Vite | Build the pages and call controls; reuse server data types without importing server code |
| Native voice helper code, setup scripts | JavaScript modules | Run directly in Node; some modules also run directly in the browser |
| Tests | JavaScript and TypeScript | Exercise the server, browser and separate helper processes |

`src/` compiles into `dist/`. Vite builds `client/` into `public/`. Express serves `public/` and the `/api` routes. These build folders are not where application source should be edited. The `draken` command starts through `src/cli.ts`; it starts the same server as `npm start`. It prints first-run instructions on every launch. Listeners bind first, then the server acquires directory ownership, then initializes and recovers the application database. An occupied-port launch cannot initialize a database, and a different-port launch cannot recover another owner's runs. Shutdown blocks new work, cancels jobs, drains both listeners and awaits history/model/native resource exit before releasing ownership. If cleanup cannot be confirmed, the server remains in a visibly failed stopping state holding the lock; forcing termination bypasses that protection and requires operator inspection of owned resources. After successful binding/recovery the server atomically writes a private, credential-free `server-state.json` containing its actual bound addresses and a fresh instance ID. `draken status` discovers that address and requires a matching live instance from `/api/auth/status`; the file alone is never a liveness claim. Explicit address overrides remain available. The identifier grants no authorization; authenticated APIs and TLS rules are unchanged.

The optional macOS/Windows `draken tray` companion reuses that bounded identity check and the existing browser interface. A detached Node controller owns a separate companion heartbeat lock and optional child server; native AppKit/JXA or PowerShell/Forms helpers receive only private presentation state and emit fixed menu actions. The controller never adopts a saved PID or an existing external server. Owned-server shutdown uses private IPC/parent-disconnect rather than Windows forced termination or a new HTTP control route. Helpers receive no provider credentials; startup/login, source permissions and review semantics remain unchanged. This first desktop preview has no Linux tray or login-item registration; target-platform checks and limitations are documented in [TRAY.md](TRAY.md).

`src/pi/runtime.ts` selects an explicit external pi, an explicitly selected private runtime, or PATH pi. `src/pi/setup.ts` supplies terminal-only setup/login/doctor commands. Private setup installs pi 1.5.0 and its shipped locked dependencies into `<data>/pi/runtime/`, without lifecycle scripts or global configuration changes. Pi owns login, credential storage under `<data>/pi/agent`, and refresh. Managed child environment/profile separation does not constitute an OS sandbox. There is no HTTP installer or credential-submission route. Authenticated `GET /api/setup` exposes bounded, coalesced, read-only version/model-credential metadata; it never requests credential output or refresh. Home and Settings show instructions, with known-missing summary prerequisites rejected before a combined sync scans or freezes evidence. See [SETUP.md](SETUP.md).

### The public website is separate

```text
site/   -- website deployment workflow --> draken.mehanig.com
            Static public landing page

client/ -- Vite build --> public/ -- Express --> local or LAN Draken app
```

The existing deployment gate (`scripts/site-release.cjs`) checks that website copy matches the root package version and withholds deployment until npm `latest` matches it. Copy describes the version after release; editing it does not merge, publish or deploy anything. npm publication is a separate authorized step.

The landing page uses images in `site/img/`, including `scene1-web.jpg` and `logo.png`. The animated call dragon is built separately in `client/src/persona/`. Editing its 3D materials does not edit the website artwork.

## 3. What happens when you click “Sync with Draken”

```text
Your click
   |
   v
Scan local session files
   |
   v
Freeze available membership and verified source pointers
   |
   v
Prepare short memory from recent syncs, then the new briefing
   |                                          |
   |                                 failed or cancelled
   |                                          |
   |                                  keep snapshot and
   |                                  valid saved summaries;
   |                                  wait for explicit retry
   v
Briefing ready
   |
   v
The initiating browser may start the call
   Only if the original click intent is still present
   and the page is visible and suitable for microphone use
```

The main request is `POST /api/syncs/start-call`. The browser sends a unique request ID. Repeating that same request returns the same sync rather than creating another one.

The server returns **HTTP 202** once preparation has started. That means “work accepted,” not “briefing finished.” The browser asks for progress while the server works. The final call setup is a separate browser action; the start-call request itself does not open a microphone.

The intent to start that call lives only in browser memory, not in the URL. Opening or reloading `/syncs/123` therefore cannot turn the microphone on. A failed preparation, hidden page or denied permission requires explicit recovery.

**Why:** preparation may take minutes, but an HTTP request should not need to stay open for that long. Repeated requests should not create duplicate snapshots, and an old link should never act as microphone permission.

## 4. Evidence and review are separate

The collector reads complete records from enabled pi, Codex and Claude JSONL sources. It remembers how far it has read, applies each format's branch/edit rules, and avoids counting inherited entries twice. Normalization removes unsupported content such as thinking blocks and applies best-effort secret removal. Evidence views reconstruct bounded, normalized excerpts from verified originals; snapshots do not store those excerpts or archive every original log field.

The live index stores verified file pointers and branch/edit metadata instead of copied entry text. Reads check the source root, file/session identity and raw-record hash, then apply the same normalization. The local index can change on a later scan. A snapshot pins its own record pointers, source details, normalization recipe and selected context-edit pointer. It does not follow the live entry's later edit/branch projection or retain a text copy. Normal pi appends leave those selections intact; missing or altered originals make the excerpt explicitly unavailable. New source activity belongs to a later explicit snapshot for review, but newly prepared originals can inform the active conversation as H evidence between user turns. Older capped snapshots have a separate, explicit expansion operation that preserves earlier notes and citations.

These words mean different things:

| Word | Meaning |
|---|---|
| Indexed | Draken has read an entry into its local index |
| Available | Eligible for a new sync, not reviewed, and not reserved by another open, non-ended sync |
| Included | A particular initial snapshot contains that entry; reservation can end without deleting membership |
| Processed | It passed through a successful first-level summary |
| Reviewed / covered | You explicitly marked its snapshot reviewed |

```text
AVAILABLE -- create snapshot --> INCLUDED IN AN OPEN SYNC
    ^                                     |
    |                                     +-- summarize, talk, save notes
    |                                     |   Still unreviewed
    |                                     |
    +--------- discard / idle end --------+
    |                                     |
    |                              explicit “Mark reviewed”
    |                                     |
    |                                     v
    |                              COVERED / SYNC COMPLETED
    |
    Discarded / idle-ended entries become available if still eligible.
    History is retained. Idle ending is not review completion.
```

Several snapshots may remain open. A new sync skips unreviewed entries reserved by another open, non-ended conversation. Idle ending releases the reservation, not the original snapshot membership. Source selection and the installation's saved history-start date also affect eligibility.

**Why:** you should be able to start a new conversation without being forced to approve the previous one. Reading, summarizing or hearing something is not the same as reviewing it.

Only the explicit review operation writes `sync_coverage`, for the initial snapshot only—not later H context. Model replies, conversation recaps and idle ending cannot do it. If summary generation was started but did not finish successfully, review is blocked rather than treating a partial result as complete.

## 5. How a large history becomes a briefing

Sending a whole history in one request is unreliable and can be expensive. Draken splits the model work, not the user's snapshot.

```text
All eligible entries in the fixed snapshot
    |
    v
Larger token-budgeted chronological batches within each session
    |  Luna; every admitted entry, with bounded background
    v
Global reconciliation: compare plans, corrections and outcomes
    |  Luna; extra levels only when combined inputs do not fit
    v
Bounded summaries + selected original excerpts + saved notes
    |  stronger text model
    v
Opening briefing, or an answer to a text question
```

`src/sync/tree.ts` handles batching, reconciliation and saved results; `src/sync/summary-budget.ts` supplies the default Luna planning estimates and safety budgets. The planner targets 96,000 estimated tokens per batch, checks the complete framed request, and keeps a compact root plus raw verification excerpts for Astra. It uses a pinned local text tokenizer—not the embedding model—and does not modify pi's catalog or assume its million-token path works. Operator-selected unknown summary models retain the conservative older tree. See [README.md](README.md#summary-tree) for exact bounds and estimate qualifications. `src/sync/manager.ts` chooses the final input, runs the final model, and saves the validated reply. Text questions can also find original excerpts by matching words or explicit source references.

Within a tree, model requests run one after another. Each run limits how many times Draken can start pi, including repairs and the final answer; this is not an exact spending limit. A summary gets at most one repair attempt using the same model. There is no automatic switch to a more expensive model.

Successful summary results are cached: saved under a key made from the input, model, prompt and kind of summary. A retry can reuse them. The planner preserves validated completed leaf boundaries across snapshot rollover and appends, including completed partial tails and successful work from cancelled runs, and packs only uncovered or changed ranges. The leaf-input receipts in `src/sync/reusable-leaves.ts` bind full primary and background inputs to the model, recipe and validated output. They contain verified-original pointers, not transcript copies. Deployed output-only caches need exact historical input/key reconstruction; cited subsets and source counts do not prove complete coverage. Unprovable known completed work must not silently become paid replacement work. Model-facing input or prompt changes produce different keys. Selected-pointer changes can preserve the same model-facing key, so known physical-input receipts must also match and must not be silently rebound through direct-cache or legacy-alias paths. It does not replace the canonical history with a rolling summary. Combining snapshots may interleave a completed leaf's inputs; contiguity in the new snapshot is not a cache-validity requirement. Cached and new leaves must cover the current primary set by distinct identity, without dropping entries or counting overlap twice. Global cache growth alone must not replace a valid completed parent/root plan and create another paid request.

Cache planning and node boundaries yield to queued cancellation and source-setting changes. Immediately before accepting cache or starting inference, and after asynchronous inference before saving completed work, recheck current admission and verified originals for the full dependency set—including uncited background carried through parents. Cached admission decisions are not authorization after a yield. These gates also surround final/repair requests and final-result persistence. Actual foreground E/C keeps its captured projection: later context edits or mutable branch/workspace catalog changes do not redirect or invalidate still-verified frozen originals. Current source consent still applies. Text and live conversations share this scope-aware boundary. Live background inputs and adopted dependencies outside the initial frozen scope require current projection/admission checks, including after retries or process restarts; keeping a dependency citation-resolvable never promotes it into initial C. Already-invalid persisted dependencies stop preparation before any replacement leaf, parent, or recap request. Distinct admitted representations are retained for every leaf path—primary and background inputs, cached work, fresh work and restored pending plans—even when their canonical text keys coincide. Canonical references prefer initial E, then first-known C; additional representations never overwrite those references and remain independently verified. `src/sync/evidence-scope.ts` shares the admission policy across preparation and live dispatch. Neither migration nor metadata/status GETs start this reconstruction or inference.

### Optional paid cache preparation, not an automatic sync

**Settings → Prepare summaries ahead** stores the NEW `auto_summary` paid opt-in. It defaults **off** on fresh installs and upgrades, including `auto_index=true` and retired 0.5 paid consent. It requires local indexing enabled, but does not change `auto_index` defaults/preferences or authorize provider work from local indexing alone.

```text
Enabled local indexing → accumulated eligible entries (no reservation)
                                   |
                    NEW paid opt-in + idle + >=64 changes
                                   |
                                   v
             shared validated summary_cache leaves
                   → reconciliation / compact final input
                                   |
                         explicit Sync / Start chat
                                   |
                                   v
                   frozen snapshot + final briefing
```

Paid background preparation reads the same eligible accumulated evidence (selected sources, baseline, active branches, verified originals, not covered or reserved by another open, non-ended sync). It **owns no sync, snapshot, coverage, message or tree rows**: no `syncs`, `sync_items`, `sync_runs`, `sync_messages`, `sync_tree_nodes` or `sync_coverage` writes. It warms the same validated leaf/reconciliation/compact-input cache used by the explicit tree, not a second summary format. It never runs the final model, briefing or recap, saves decisions, captures audio or reviews work.

Once-minute idle checks require **at least 64 new/changed eligible records**, independently of the local embedding checkpoint; there is no small-tail timer. An unchanged prepared input makes no further provider calls. Completed batches survive appends, including previously completed partial tails. Uncovered or changed inputs and aggregate reconciliation for a different combined input may need on-demand work at **Start chat**. The final briefing is always explicit, so warm cache is not a promise of instant chat or a completed batch.

Only the configured summary model is allowed, using the same configured `max_invocations` allowance including repairs, with no provider/model fallback. Foreground work cancels **and awaits** owned background provider work; shutdown retains ownership until cleanup. Valid cache survives cancellation/restarts, and the same interrupted input retains spent invocations when resumed. **Paid failures pause until explicit retry**, unlike local indexing's five-minute retry delay. Disabling either switch stops paid work and preserves cache.

The additive `background_runs` table stores durable input hashes, counters, state and metadata-only metrics, not source text or prompts. `preparationUsage` includes background spend, requests and failures. `completed_batches` remains explicit snapshots' first successful briefing count; warm cache is not a sync or review. Settings/progress GETs, including `/api/settings/auto-summary`, only read metadata and cannot authorize work. See [MEMORY.md](MEMORY.md#optional-paid-summary-preparation) for the durable scheduling and accounting contract.

`sync_runs.metrics_json` stores metadata-only call durations, sizes, locally estimated token counts and request status. Timings include process startup and provider work; they do not separate those stages or report billed usage. Preparation requests also capture pi's reported usage and catalog-calculated USD cost through a bounded LF-only JSON parser (`src/sync/pi-output.ts`); repeated terminal events are not counted twice. Only numeric accounting and returned model names are saved, not event streams, prompts, thinking or signatures. `src/sync/cost.ts` sums preparation runs (including retries/rebuilds) into the sync's **Est. cost**; later questions, calls and standalone recaps do not change it. Cached summaries add no new charge. Missing/legacy usage remains unavailable or partial, never zero or a retroactive guess. Prices are retained at call time. This is API-equivalent pricing, not subscription charges, quota usage or an invoice. Existing metrics remain readable. The 0.7.0 background path adds `background_runs` for separate durable accounting; it does not rewrite old metrics, indexes or model selections.

### Source references

The model sees short labels such as `S1` within one request. The server maps them back to the actual internal source IDs. The reader sees snapshot-local references such as `[E3]` for evidence or `[C2]` for background context. A label from one snapshot is not a universal source ID.

The server checks the shape of a summary and whether its references exist. If the only error is too many references, the repair selects from that observation's original references; it does not rewrite the claim or silently cut off the list. If validation still fails, the run stops.

**Why:** saved partial work makes large histories practical to retry. Explicit limits prevent an error from causing unlimited requests. Source links let you inspect the evidence rather than trust a summary alone.

**The cost of this design:** summaries lose information. Processing every eligible entry does not prove that every fact survived. A real source ID does not prove that the source supports the claim. Draken does not independently rerun tests or check deployments.

## 6. Memory is not the same as a decision

There are now two distinct paths: short recaps for continuity, and automatic hybrid retrieval for finding retained original records across older sessions and syncs. Text questions and calls use this by default; **Search history** also exposes the original records directly. The latter combines SQLite FTS5 with `sqlite-vec` and a pinned local multilingual embedding model. It runs in one bounded history child process, using up to two isolated embedding lanes and six CPU threads for larger deltas on sufficiently capable machines (one lane on smaller machines), using a separate private, rebuildable index; the child opens the app database read-only and resolves only admitted, verified session-file pointers beneath the configured root. Unique passage hashes/vectors are stored once, with separate scoped occurrence links and bounded write batches; passage text is reconstructed from verified sources. Only missing vectors are computed, and unchanged refreshes do not rewrite the index. The dashboard reads delta-only phase/count/download progress from the parent process without queuing behind inference or exposing source text.

```text
Retained evidence / discussion / saved notes
  → keyword index + local embeddings
  → combine matches → read source/context
  → dated H references, separate from the frozen snapshot
```

Browsing does not start downloads or embedding. Standalone search and legacy discussion can prepare the model and index automatically; the separate chat surface uses prepared history. Sync preparation also prepares searchable history, before **Call Draken** can become enabled. Existing syncs can explicitly prepare history outside a call. Foreground call preparation first completes captured source imports in cancellable 32 MiB passes, without chasing later appends; the 8 MiB record limit remains. `agent_sessions.scanned_bytes` distinguishes a completed capture from a partial cursor. Snapshot routes block scan warnings. A read-only readiness check validates the saved preparation record against completed capture markers, source metadata, file identity and the pinned model; it never scans transcript bodies, downloads a model or starts inference. Call creation rechecks readiness and returns 409 rather than indexing during setup. Chat and voice retrieval verify prepared passages at a per-turn pinned cutoff without building new corpus embeddings inside a reply. New successfully prepared original history may be adopted between turns; appends or scan cursor changes alone do not revoke an already-valid captured prefix. The scheduler (`src/sync/background.ts`) separates local indexing from the new explicit paid cache-preparation opt-in. Local indexing alone only scans/indexes and never invokes providers. Neither background path reserves entries or creates syncs; only paid opt-in permits summary-cache work under the boundaries above. An explicit user request owns snapshot creation and briefing generation; old automatic snapshots remain ordinary retained history. See [MEMORY.md](MEMORY.md#optional-background-indexing) for both schedules, consent, cancellation and regression coverage. Settings/progress GETs start no work. There are no manual model-setup, search-mode or scope switches. Voice project questions use original-source scopes, a conversation-local project/topic context, chronology-aware ranking and a separate agent-explanation candidate set. Shared passages are deduplicated before top-k truncation. Safe native refinements are honored within a three-lookup-per-turn limit. Text and voice share a historical evidence selection budget of 32,000 UTF-8 bytes; native voice transports larger packets losslessly through acknowledged context parts of at most 8,192 bytes. Explicit frozen-source lookups can accompany the history packet. Retrieval intent—not the transport byte budget—controls reconciliation. Source lists represent context supplied for the current turn, not verified claim support. Retrieved history is never new snapshot coverage or an automatic decision. See [MEMORY.md](MEMORY.md) for package/runtime costs, exclusions, date qualifications and failure behavior.


### Live history and conversation lifetime

`src/sync/conversation.ts` owns conversation activity/ending separately from review status; `src/memory/readiness.ts` owns prepared-history receipts, while activity/background orchestration controls safe update boundaries.

```text
Explicit sync → fixed initial E/C snapshot + briefing + prepared history
                                      |
Source changes → local preparation → next user-turn boundary
                                      |
                        one pinned H cutoff per answer
                                      |
                  30 minutes without a real user turn
                     (ongoing reply finishes first)
                                      |
                             Session ended
               transcript/notes/snapshot remain; no review
               unreviewed reservations released for next explicit sync
```

- **Immutable evidence, additive context:** background history updates never rewrite initial membership, E/C references, briefing, saved transcript or notes. H history is dated additional evidence, not new review coverage. Initial briefing/history preparation is still required once. A new cutoff cannot interrupt a reply or change its lookups, context delivery or correction pass mid-turn.
- **Append-safe, not damage-tolerant:** ordinary source appends and import-cursor bookkeeping must not invalidate captured context (the 0.7 cursor-identity bug). Receipt identity follows captured records, not the mutable file tail. Actual source damage, missing/excluded originals or incompatible captured projections remain fail-closed; actual reads verify bytes. Extra archive lookup unavailable during an update must be qualified, never guessed or silently replaced by old conversation context. Updates alone do not disable prepared chat.
- **Two local scheduling scopes:** with `auto_index` enabled and an active conversation, once-minute checks index **any positive source changes**. With no active conversation, retain **64-record batching and no timed small-tail flush**. Connected idle voice can permit local work between turns; pending response/context delivery cannot. User turns preempt and drain owned indexing. No per-minute paid call follows from live H updates.
- **Paid permission stays separate:** `auto_summary` remains default off and independently requires 64 eligible changes plus its explicit permission. No background path creates syncs, final briefings, recaps, notes or review. Settings/status GETs read metadata, never transcript bodies or inference.
- **User-idle lifecycle:** creation is initial intent; only real user chat messages/voice turns advance last activity. End after 30 minutes without one, after an ongoing reply finishes. Assistant responses, updates, polling and connection heartbeats do not renew the deadline. Show **Session ended**, not completed/reviewed. Reject new turns and do not revive via replay, browsing or restart; return home and **Start new sync**. Explicit notes/review can remain available on the retained old snapshot under existing checks.
- **Durable migration:** persist last activity and ended marker additively, preserving the `open` / `completed` / `discarded` review-status CHECK rather than rewriting it. Derive existing activity from stored real user turns, falling back to creation—not assistant/update timestamps. Older inactive sessions may end and release unreviewed reservations without deleting history or automatically changing notes/coverage.

Simple UI status is **Up to date**, **Preparing new info…**, **New info ready**, optionally **Live updates off** / **Updates unavailable** when true; no extra update control is needed. Native voice's 30-minute connection limit, 60-turn cap and 90-second disconnect lease remain separate resource bounds. See [MEMORY.md](MEMORY.md#live-conversations-and-idle-ending) for the durable contract.

Draken keeps three kinds of text separate:

| Kind | Purpose | Who creates it? |
|---|---|---|
| Conversation history | Retain what was asked and generated, with voice-status qualifications | The app records the exchange |
| Recap | Help you recognize a past sync and bring short context into the next one | A model summarizes the history |
| Decisions and carry-forward notes | Record choices and open work you explicitly want to keep | You save them through the notes controls |

A new one-click sync freezes the inputs from the **three most recent non-discarded syncs**, including open ones. Recap generation processes their supplied briefings, messages and notes in parts, then combines the results. It does not just take the last few messages. The final recap is deliberately small: one to five lines, at most 600 characters.

Changing a conversation marks its old recap as stale. Explicitly closing the call UI requests a new recap; idle expiry does not; a browser exit cannot guarantee that request completes or is sent. You can explicitly refresh it, and a later sync can rebuild changed memory. Recaps have no idle-refresh timer. Automatic local indexing never generates provider model work. Paid background summary preparation also excludes recaps and final briefings.

**Why:** short recaps make history easy to browse without sending every previous conversation into every call. Keeping notes separate prevents a model's suggestion, an interrupted answer or an old user request from becoming a saved decision.

A recap is not an exact quotation or a complete account. Original history remains available on the earlier sync's page. The older sync API also remains supported, with its own completed-sync note history; it is not the main home-page workflow.

## 7. One voice path: ChatGPT

Calls use only subscription-backed ChatGPT live voice. There is no mode to choose and no automatic fallback. The old Whisper → pi → Kokoro engine, Python worker, installer and browser speech detector have been removed.

**Why:** the product uses ChatGPT voice. Keeping a second reachable engine only added code, dependencies, setup instructions and tests for a feature we no longer wanted. An unused-code tool cannot make that product decision: old routes and settings made the old engine look used.

Existing `DRAKEN_VOICE_MODE=native` settings are accepted for older launchers. A `local` or unknown setting stops startup instead of silently sending an old local-audio installation's microphone to OpenAI.

```text
Browser <========== live audio ==========> OpenAI
   |                 WebRTC
   |                 (browser live-audio connection)
   |
   +-- call commands --> Draken server --> official Codex helper --> OpenAI
                              |
                              +-- frozen briefing and bounded source excerpts
                              +-- prepared history lookup; explicit frozen-source reads
                              +-- transcript records in SQLite
```

The pinned official helper uses a separate native ChatGPT sign-in. Draken does not convert pi credentials or give provider credentials to the browser. Voice questions do not start a pi process or any local speech model. It has no Platform API-key fallback.

The helper cannot run coding work. Requests to execute tools or grant approvals are rejected. Its text lookup service returns selected frozen data, or automatically retrieved, bounded historical excerpts. Local embeddings rank text; they do not generate code or execute anything. The lookup service is not another coding agent or a general web search.

**Why this path:** one continuing audio connection supports a direct spoken conversation through the existing ChatGPT account.

**The tradeoff:** audio goes to OpenAI, and the native interface is experimental. Speech may paraphrase and is not held for complete-answer JSON validation before playback. Stored transcripts distinguish generated and interrupted text; they do not claim exact playback. Sources supplied to the model are not proof that each spoken claim is correct. Usage limits and future compatibility are not guaranteed.

### Call rules

- Only one call may be active. Its snapshot is protected from conflicting changes while the call runs.
- The browser controller owns microphone tracks, playback and cleanup. Initial history preparation has progress and cancellation on the sync page; Call stays disabled until both history and the briefing are ready. A final readiness check runs before the call dialog opens, with another check at server reservation. The dragon is mounted only during call connection. Server-identified user completion/pending events own reply waiting, rather than late unkeyed WebRTC user events. Reload does not resume capture.
- Native connections retain a 30-minute maximum, 60-user-turn cap and 90-second disconnect lease. These resource limits are separate from conversation expiry after 30 minutes without a real user turn; heartbeats renew a connection lease, not user activity.
- No raw microphone recording is saved locally. Transcript text is saved.
- Mute, stop reply and end call are different actions. In native mode, muting local playback does not prove remote generation stopped immediately.
- A call cannot save decisions by model instruction or mark a sync reviewed.

Old local-engine call records remain readable. `src/voice/legacy-history.ts` reads those records and closes unfinished historical calls after an upgrade; it cannot start speech, transcribe audio or run a model. Keeping history is not keeping another voice path.

## 8. What is saved, and what survives a restart

By default, private state lives under `~/.draken/`, outside the source checkout. The main database is `~/.draken/draken.db`.

| Tables | What they keep |
|---|---|
| `agent_sources`, `agent_sessions`, `agent_entries`, `sync_settings` | Per-agent permission, native and namespaced identities, verified source pointers, parser versions, branch/edit links, read positions and selection |
| `syncs`, `sync_items` | Sync records and frozen record/edit pointers with attributed E/C membership; notes and briefing live on the sync. Additive conversation activity/ended metadata is separate from review status |
| `sync_messages` | Text discussion and qualified voice-history messages |
| `sync_coverage` | Entries explicitly reviewed |
| `sync_runs`, `sync_tree_nodes` | Briefing/question progress and durable historical links between summary steps; `last_run_id` limits displayed nodes to the current run without deleting retry/recovery provenance |
| `summary_cache` | Valid summary-tree results reused by explicit syncs and opted-in paid preparation |
| `summary_leaf_inputs` | Complete primary/background pointer manifests and model/recipe/output identities proving reusable leaf boundaries; no transcript copies |
| `summary_planning_context` | Durable original planning/frozen-scope references, kept separate from subsequently attached citation dependencies across retries and restarts |
| `summary_leaf_plans`, `summary_pending_plans` | Stable completed selections/root preferences and pending boundaries; a stored plan never proves successful processing without validated outputs |
| `summary_parent_inputs` | Child topology for restoring exact compatible cached subtrees before selecting alternatives |
| `summary_replay_attempts` | Derived memoization of exhausted historical reconstruction attempts, not successful preparation or review |
| `background_runs` | Paid preparation input hashes, durable invocation counters, state and content-free metrics; no source text or snapshot ownership |
| `sync_presentations`, `sync_recap_cache` | Card recaps, frozen earlier-conversation inputs and reusable recap parts |
| `voice_calls`, `voice_turns` | Preserved records from the retired local engine; no new calls are created here |
| `live_calls`, `live_messages` | Native calls and separately recorded user/assistant messages |

SQLite transactions keep related changes together. Creating a snapshot freezes verified pointers and attributed memberships; finishing a review records its coverage. Original agent logs are the authoritative text archive even for older snapshots. If originals disappear or change, Draken keeps the conversation, notes and reference identities visible but labels affected excerpts unavailable; it cannot prepare replies/calls or mark that snapshot reviewed. Back up all enabled agent log directories and Draken's private state. The one-way source-only migration verifies exact reconstruction before removing retained bodies, and rolls back rather than guessing when that cannot be proved.

The derived search database stores attribution metadata, passage hashes, unique vectors, occurrence links and contentless FTS5 postings—not original passage bodies. Its `chunks` and `embedding_cache` names are read views, not second content/vector stores. The one-way source-only migration preserves compatible embeddings without inference and stops if legacy evidence cannot be verified, rather than deleting or guessing it. See [MEMORY.md](MEMORY.md) for the format, failure behavior and separate offline compaction step.

Closing a page does not cancel an ordinary server-side preparation job. Restarting the server interrupts work still in progress, and startup records unfinished runs and calls as stopped or interrupted. Calls and foreground preparation do not automatically restart; a microphone always requires fresh browser intent. Saved snapshot membership, conversations and successful summary parts remain available, while snapshot text still requires the original agent files. Conversation last-user activity and ended state survive restart; restarting cannot revive an ended session. Retry of interrupted preparation remains explicit and does not reset user-idle timing. Enabled automatic indexing continues accumulating local history under the [indexing policy above](#6-memory-is-not-the-same-as-a-decision); it never resumes snapshot or briefing work. Previously automatic snapshots remain accessible as ordinary history. Separately opted-in paid cache preparation can resume interrupted input with its durable spending and valid cache, but a paid failure remains paused until explicit retry. The new opt-in defaults off; neither old local permission nor retired paid consent enables it.

**Why:** the database preserves what happened. Restart recovery must respect each saved permission separately: indexing is not paid consent; paid cache permission is not snapshot, final-briefing, recap or microphone permission.

The `agents-v1` source migration renames legacy `pi_sessions`/`pi_entries` to generic `agent_sessions`/`agent_entries`, retaining IDs, event keys, sequences, frozen references and compatible embeddings. New Codex/Claude readers and their opt-in boundaries are described in [SOURCES.md](SOURCES.md); the tool-free pi summarization runner is unchanged. Schema updates preserve historical evidence, including old project/task tables that the current app no longer uses. Pointer migration changes its physical representation; older binaries cannot read the new schema. Keep a current database backup before deployment. Do not restore an old database to update voice code, or run the old single-open-sync schema against newer multiple-snapshot data.

## 9. Trust and privacy boundaries

- **Source text is data, not a command.** Logs and old conversations may contain instructions. They must not acquire authority just because a model reads them. The pi calls have tools disabled; the native helper also rejects execution and approval requests.
- **Local browsing is not a model request.** Scanning and viewing evidence stay local. Explicit preparation, questions and recap actions, plus separately opted-in paid background summaries, can send selected text to providers. Settings GETs grant no consent. Native calls also send audio.
- **Secret removal is best-effort.** It reduces obvious exposure; it cannot guarantee that a source excerpt is safe to send. Frozen records are not silently rewritten when outbound cleaning rules improve.
- **Dashboard login and provider sign-in are separate.** Normal loopback use needs no dashboard login unless configured. LAN access requires authentication, and microphone use needs localhost or trusted HTTPS. Requests from other origins are rejected.
- **Private files stay outside the repository.** Credentials, certificates, databases, installed helper files and private reports are not application assets or package contents.

**Why:** this app handles private coding history. A convenient local interface should not turn a webpage, a source-log instruction or a model response into permission to access or change more.

## 10. The dragon only draws

`client/src/persona/` contains the Three.js scene, dragon geometry, materials and movement. The call controller gives it read-only playback signals through `client/src/audio/playback.ts`.

Live speech supplies received audio energy, not exact word or mouth timing. The separate preview can animate a stored sample using its audio and approximate text shapes; it is not a speech engine. The dragon does not capture audio, call a model or write records. If drawing fails, the call can continue with a still image.

`/persona.html` is a separate local preview for testing appearance and movement without starting a real call.

**Why:** a drawing problem should not break a conversation. Keeping presentation separate also makes it possible to improve the character without changing microphone permissions or model behavior.

## 11. Where to make a change

| If you want to change… | Start here |
|---|---|
| URLs, navigation and temporary call intent | [`client/src/App.tsx`](client/src/App.tsx), shared anchor handling in [`client/src/navigation.ts`](client/src/navigation.ts) |
| Browser credentials and login state | [`client/src/auth/session.ts`](client/src/auth/session.ts), [`client/src/contexts/AuthContext.tsx`](client/src/contexts/AuthContext.tsx) |
| Home cards and new sync action | [`client/src/pages/Home.tsx`](client/src/pages/Home.tsx) |
| Top-bar settings and pi source/session inventory | [`client/src/components/IndexSettings.tsx`](client/src/components/IndexSettings.tsx), [`client/src/components/AgentSources.tsx`](client/src/components/AgentSources.tsx) |
| A sync's briefing, discussion, notes and evidence controls | [`client/src/pages/Sync.tsx`](client/src/pages/Sync.tsx) |
| Private pi installation, selection and pi-owned login | [`src/pi/`](src/pi/), [`runtime/pi/package-lock.json`](runtime/pi/package-lock.json), [`src/cli.ts`](src/cli.ts) |
| First-run instructions and setup state | [`client/src/components/SetupPanel.tsx`](client/src/components/SetupPanel.tsx) |
| HTTP request checks and route wiring | [`src/server.ts`](src/server.ts), [`src/routes/`](src/routes/); async dispatch and opt-in disconnect cancellation in [`src/routes/http.ts`](src/routes/http.ts), shared errors in [`src/errors.ts`](src/errors.ts) |
| Reading agent histories and cleaning excerpts | [`src/sources/adapters.ts`](src/sources/adapters.ts), [`src/sources/registry.ts`](src/sources/registry.ts), [`src/sync/collector.ts`](src/sync/collector.ts), [`normalize.ts`](src/sync/normalize.ts) |
| Snapshot selection, review and saved notes | [`src/sync/store.ts`](src/sync/store.ts) |
| Summary steps, caching and source-label validation | [`src/sync/tree.ts`](src/sync/tree.ts), [`references.ts`](src/sync/references.ts) |
| Final answers and separate local/paid background orchestration | [`src/sync/manager.ts`](src/sync/manager.ts), [`pi.ts`](src/sync/pi.ts), [`background.ts`](src/sync/background.ts) |
| Conversation idle lifecycle and reservation release | [`src/sync/conversation.ts`](src/sync/conversation.ts), [`src/sync/store.ts`](src/sync/store.ts) |
| Active job/call ownership and shared history preparation | [`src/sync/activity.ts`](src/sync/activity.ts), [`preparation.ts`](src/sync/preparation.ts) |
| Short conversation memory | [`src/sync/recap.ts`](src/sync/recap.ts) |
| Hybrid historical retrieval | [`src/memory/index.ts`](src/memory/index.ts), [`src/memory/service.ts`](src/memory/service.ts), [`MEMORY.md`](MEMORY.md) |
| Shared text/voice project scope and frozen-evidence selection | [`src/memory/focus.ts`](src/memory/focus.ts), [`src/sync/retrieval.ts`](src/sync/retrieval.ts) |
| Historical evidence packing and indexed passage format | [`src/memory/packet.ts`](src/memory/packet.ts), [`passages.ts`](src/memory/passages.ts) |
| Pinned embedding files, inference lanes and vector format | [`src/memory/model-assets.ts`](src/memory/model-assets.ts), [`embedding-pool.ts`](src/memory/embedding-pool.ts), [`model.ts`](src/memory/model.ts), [`embedding-contract.ts`](src/memory/embedding-contract.ts) |
| Data directory and model defaults (no database initialization) | [`src/data-dir.ts`](src/data-dir.ts), [`src/sync/models.ts`](src/sync/models.ts) |
| Reading old call records without keeping the retired engine | [`src/voice/legacy-history.ts`](src/voice/legacy-history.ts) |
| Native voice server / browser / helper | [`src/voice/live.ts`](src/voice/live.ts), [`client/src/voice/live-session.ts`](client/src/voice/live-session.ts), [`voice/realtime/`](voice/realtime/) |
| What evidence native voice receives | [`src/voice/live-context.ts`](src/voice/live-context.ts) |
| Database tables and shared data types | [`src/db/schema.ts`](src/db/schema.ts), [`src/types.ts`](src/types.ts) |
| Call appearance or the public landing page | [`client/src/persona/`](client/src/persona/) or [`site/`](site/), respectively |

Keep checks that control writes on the server, not only in buttons. Keep model prose out of the code that decides whether notes or coverage may change. Keep microphone ownership in the call controller, not the picture component.

### Boundaries to preserve

- Keep configuration/errors independent of database initialization, asset management separate from inference, and shared retrieval/passage policy outside voice or model orchestration.
- Local indexing permission never becomes paid consent. Paid preparation writes shared validated cache and metadata-only `background_runs`, not snapshot/tree/message/review rows. Failures pause paid retries; the same interrupted input retains invocation spending.
- Cancellation requests are not completion. Resource owners retain their leases until confirmed cleanup; HTTP disconnect cancellation is opt-in, not a blanket rule for durable preparation.
- Live evidence requires verified originals. Append/scan cursor movement is not captured-source damage; validate the pinned prefix, and adopt newer prepared H context only between turns. Historical normalization/cache recipes belong to migrations and independent frozen fixtures, not aliases of the current recipe.
- Conversation expiry is based only on real user activity and persists across restart; it never rewrites review status, notes, transcript or initial evidence. Ended reservations can be reused only by an explicit new sync.
- Browser credentials can be shared without sharing failure policy: dashboard authentication failures and call cleanup have different owners. Source viewers own their abortable requests and pagination identity.

## 12. Checking changes

```sh
npm run check    # TypeScript checks and unused-code analysis
npm test         # Server and unit tests with temporary data and fake model replies
npm run test:ui  # Build, then browser workflow tests
```

Focused 0.8.0 coverage: `tests/conversation.test.cjs` for idle lifecycle, persistence/migration and reservation release; `tests/live-history-readiness.test.cjs` for append-safe receipts and damage rejection; `tests/voice-live-updates.test.cjs` and existing activity tests for per-turn cutoff and idle ownership. Browser workflow coverage is in `tests/ui/live-conversation.spec.ts`. Retain `tests/background-tree.test.cjs`, `tests/background-preparation.test.cjs` and `tests/automatic-index.test.cjs` for separate paid consent/thresholds and local-only scheduling. `tests/package-smoke.cjs` asserts fresh paid opt-out and metadata-only settings GET defaults without activity GETs or provider calls; `tests/site-browser.cjs` checks release/lifecycle copy without running the app.

The [0.8.1 reuse qualification record](docs/refactor-reviews/081-reuse.md) covers full-input cache provenance, rollover/retry and embedding reuse, shared text/live admission, independent review, and explicit qualification limits.

There are separate tests for browser audio, native-helper behavior and real-provider calls. Real-provider checks require an explicit opt-in; ordinary tests must not read your real session store or use it as scratch data. A synthetic audio test is not proof that a physical microphone, Bluetooth headset or different browser behaves correctly.

Run builds and UI tests in sequence: the server build replaces `dist/`, so building it while a test server starts can break the test.

Unused-code checks need to know about scripts started as processes, modules served directly to a browser and test entry points. That is what [`knip.jsonc`](knip.jsonc) records. Do not confuse old-data readers and error handling with unwanted features. The explicit product tests in `tests/voice-boundary.test.cjs` check that retired voice routes and dependencies stay removed while old records remain readable.

## Further reading

- [README.md](README.md): installation, settings and detailed sync behavior.
- [VOICE.md](VOICE.md): speech setup, privacy and call behavior.
- [Native voice notes](voice/realtime/README.md): helper restrictions and verification.
- [PERSONA.md](PERSONA.md): drawing, motion and preview controls.
- [DESIGN.md](DESIGN.md): colors, typography and layout rules.
- [ROADMAP.md](ROADMAP.md): remaining work, not a description of features already built.
