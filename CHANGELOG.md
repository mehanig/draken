# Changelog

## 0.14.0

### Compact Factory workflow list

- Show saved workflows as numbered rows, collapsed by default, with their purpose and preparation status. Expand a row to inspect steps, guidance, evidence and execution controls.
- Keep expanded rows open across refresh, preparation and pagination. Direct workflow links load and expand their target. Preserve keyboard interaction and mobile layouts without horizontal overflow.
- Keep all saved proposals and source checks. This release does not merge similar workflows or fix duplicate workflow discovery: background learning can still create separate proposals from matching pairs of task fragments.
- Remove redundant implementation comments while preserving API contracts, compiler directives and external platform/protocol explanations. Executable output, model prompts, fixture data and application behavior remain unchanged by that cleanup.
- Preserve existing history, caches, workflows, failed attempts and execution settings. Upgrading does not start workflow execution or retry failed preparation.

## 0.13.0

### Create workflows from chat and voice

- Ask in the existing sync text chat or native voice call to create and enrich a workflow from historical work, including one task. Reuse evidence planning, verified originals, workflow matching and saved enrichment under the current turn's allowance and cancellation. Ordinary chat gains no separate classifier call.
- Distinguish single-task workflows from recurring discoveries, and historical facts from requested scope and model guidance. Return the actual saved result, clarification or failure and a Factory link. Creating a workflow does not execute it.
- Keep native history lookup read-only. Deliver creation results separately, prevent duplicate requests and cancel owned work on Stop, a new turn or call end. Recheck source permissions and original bytes, including uncited context.
- Add workflow discovery/request records and sync-owned enrichment without replacing old discoveries, histories, caches or failed attempts. Upgrading does not retry failed preparation or execute workflows.

### Background preparation reliability

- Give invalid workflow-comparison output one correction attempt within the existing invocation allowance. Retain rejected responses and exact validation errors. Provider failures, cancellation and changed sources do not trigger correction calls; a second invalid response stops visibly. Summarization, workflow learning and enrichment remain one pipeline.
- The deployed fix completed a real combined preparation pass covering 14,371 entries with 59 of 120 allowed calls. The original failed comparison discarded its response/error; an exact-input replay succeeded, so its original exception cannot be established retrospectively.
- Qualification includes 831 automated tests, 76 browser tests, standalone module checks and production package smoke. A real four-call Luna/Astra test created and enriched a workflow from explicitly synthetic task history. Native voice transport is covered by protocol tests; microphone-to-provider workflow creation has not been demonstrated.

## 0.12.0

### Factory: execute approved workflows through ordinary tools

- Remove blanket publication/push/PR prohibitions from execution plans and prompts, and remove patch rejection based on tests, scripts, dependency manifests or CI filenames. The selected, user-approved workflow owns its checks, self-review, repair and delivery steps in one Pi session.
- Remove the forced baseline/fresh-verification sequence and separate checks-only runner. Environment checks are suggestions for the workflow, not an additional host acceptance gate. Preserve patch collection as a receipt, not proof of task completion.
- Preserve reachable Git history, allow committed filenames/submodule/LFS declarations, and support an explicitly configured remote and Docker environment file for workflow credentials. Ordinary tools use normal Docker networking; host Git configuration, ambient secrets and provider credentials are not automatically copied.
- Include the Factory execution scripts and operating guide in the npm package. Running workflows still requires configured rootless Docker, an approved image, a qualified Pi SDK and a committed `.draken/environment.json` in the target repository. Missing tools or credentials are specific prerequisites, not unsupported action types.
- Preserve blocked outcomes in run/stage displays. Keep source permissions, durable accounting, cancellation, resource limits and uncertain-cleanup ownership checks.
- Host policy v4 requires existing workflows to be explicitly enriched again before execution. Old enrichment attempts, failed-run receipts and unrelated background-learning errors are retained; upgrading does not rerun workflows.
- Validation includes 803 automated tests, 75 browser tests, Docker/SDK/package checks and a real nine-call Astra session that edited tests, checked them, committed, pushed and created PR #55 through ordinary Git and GitHub REST calls. That is proof of the tested edit-to-PR path, not every possible workflow or release publication.

## 0.11.0

### Factory: prepared workflows and checkout execution

- Enrich discovered workflows during preparation and save reusable steps, review checks, completion criteria, risks and concrete input definitions. Factory displays the saved guidance; running a task does not regenerate it, and refreshing the page starts no work.
- Use the configured final model and existing preparation accounting. Retain failed attempts and validate source permissions before preparation, display and execution. Existing workflows without current enrichment offer an explicit preparation action.
- Add workflow-defined input forms, a repository ref, run history/logs/cancellation and one shared execution-call setting. There is no generic task prompt box.
- Add a checkout-only execution prototype: one host Pi session operates through container-backed tools in a persistent Docker workspace, with ordinary Docker networking, retained patches and fresh repository checks. It requires explicit Docker/SDK/repository configuration and a committed `.draken/environment.json`. Execution scripts are not included in the npm package, so this release does not enable Run in a normal npm installation.
- Preserve existing histories, caches, review state and failed-run receipts. Add workflow-enrichment storage without deleting previous records.
- Record the authoritative workflow-driven design and remaining implementation gaps. The current prototype still prohibits publication and restricts edits to several file categories; complete agent-driven PR/release delivery has not been demonstrated. These are implementation limitations, not the intended limits of Factory.
- Validation before release: 800 automated tests and the existing browser qualification, plus real Docker networking/lifecycle and Pi SDK protocol checks. These checks do not establish end-to-end model-driven delivery.

## 0.10.0

### Factory: workflows from your own work

- Learn workflow proposals during normal background summarization. New summaries retain process records; matching uses the existing preparation consent, activity window and invocation allowance. Opening Factory or refreshing it starts no model calls.
- Group proposals by the session’s Git repository or non-Git folder. Subfolders and linked worktrees share a repository; separate repositories, clones and non-Git folders are not matched together.
- Show applicability, steps, limitations and expandable source evidence in Factory. Recheck source access, original bytes and repository identity before displaying saved proposals. Proposals are not approval to execute, and Factory does not run workflows.
- Add Factory to the top bar and use a hamburger menu for navigation and account controls on mobile. Remove generic explanatory copy and repeated info icons from Factory.
- Preserve ordinary summaries when process extraction fails, retain failed attempts for diagnosis, and allow a limited format correction within existing invocation limits. Existing cached history is not automatically reprocessed; explicit preparation can select up to six saved summary leaves.
- Add process-record storage without deleting histories, notes, caches, vectors or review state. Workflow discovery still depends on available fragments and model decisions; it is not exhaustive reconstruction or proof of success.
- Qualification includes 771 automated tests and 70 browser tests, including repository separation, source revocation, cancellation, accounting and responsive navigation.

## 0.9.3

- Let session lists in Settings flow with the page instead of using an inner scrollbar, on desktop and mobile.
- Hide ignored sessions by default. Each agent list shows an ignored count and a keyboard-accessible **Show ignored sessions** / **Hide ignored sessions** button below the list. Visibility choices survive inventory polling and do not change source permissions or preparation settings.
- Keep the existing ignored states: disabled agents, manual exclusions, unavailable logs and sessions outside the activity window. Showing a session does not enable it or prepare its history.
- No backend, schema, dependency or model-call changes. Existing histories, notes, review state, caches and vectors are unchanged.
- All 61 UI tests passed, including page scrolling at desktop and mobile widths, keyboard controls, polling, source selection and activity-window consent.

## 0.9.2

- Move question interpretation into the existing isolated evidence module. The configured summary model plans the query, project scope, conversation recall and recency before search, then selects original evidence. Remove the caller-side intent regexes and voice-only quote-ranking fallback. Text and native voice share this flow; the module still has no external imports.
- A normal project text reply uses three model calls: planning, selection and answer. Citation correction can add a fourth. Early scope refusals stop after planning. Native voice uses two summary-model calls per project lookup and keeps its native answering model. Existing invocation limits, cancellation and accounting still apply; invalid planning or selection fails without automatic retries.
- Default preparation to sessions with a message in the last seven days. Settings offers other periods and All history, with confirmation before widening. Eligible sessions retain their older messages; inactive cached work, notes, history and citations are not deleted. Existing source exclusions and installation baselines still apply.
- Read and cache first/last-message metadata before importing transcripts. Show activity dates, a short preview and inclusion status for discovered sessions, including ignored sessions. Unchanged ignored files do not need transcript reads.
- Add startup-only `draken --history-days N|all`, using the same saved setting as Settings. Widening asks for confirmation (`--yes` for scripts). Existing port and directory-ownership checks succeed before any setting changes; a second instance cannot reconfigure the running server.
- Give Settings its own `/settings` page with direct loading, reload and browser Back. Simplify repeated UI copy and keep optional help in accessible disclosures without hiding errors, progress, setup commands or cost consent.
- Apply shared plain-English instructions to summaries, briefings, recaps, chat and native voice without rebuilding cached work merely to restyle it.
- Preserve histories, notes, review state, original-byte checks, source permissions, caches and vectors. Session activity metadata is an additive schema change; no dependency or provider changes are required.
- Qualification includes 672 unit tests, 60 UI tests, browser/runtime/package checks and limited real-provider replays. The original current-status failure now retrieves deployment evidence. Model interpretation, candidate coverage and JSON compliance remain fallible; invalid responses stop visibly. These checks do not establish exhaustive retrieval or physical native-audio quality.

## 0.9.1

- Give text and native voice one internal evidence-preparation module for prepared candidate search, project relevance, source selection and verified-original packets. The module owns its contracts and has no imports from other application code; search, verified reads, text cleaning and model calls are injected. CI checks imports and compiles/runs the folder in isolation. Conversation state, answering models, accounting and review remain outside it.
- Support project-specific advice and architecture opinions by distinguishing recorded facts, which need citations, from recommendations, which are not agreed decisions. Clearly unrelated requests receive a short scope message; unclear requests receive a clarification. No matches do not make an engineering question unrelated.
- Reuse the existing summary-model call for relevance and source selection. Empty candidate sets now also need this call. Text scope messages skip the answer-model call; voice delivers the decision through its existing native model, without a pi answer call.
- Preserve source permissions, pinned cutoffs, original-byte verification, invocation limits and cancellation. Explicit frozen references are checked before and after selection. Prepared-search failures stop text replies visibly; invalid selector output is not silently repaired or automatically retried.
- Retain histories, notes, embeddings, summary caches and explicit review. No new dependencies or database migration. Candidate coverage and model relevance decisions can still be wrong; this release does not add recent-matching retrieval or establish real native-audio quality.

## 0.9.0

### Let the summarization model select text and voice evidence

- Text chat and voice gather up to 64 original-source candidates using the existing keyword and local embedding indexes. The configured summarization model selects up to eight source IDs; the final model answers from reread originals and nearby request/result context. There is no generated intermediate answer.
- Remove weighted role, age and keyword bonuses and the hand-written later-report graph. Candidate collection alternates search lists and skips duplicate originals before taking another list's turn. Standalone local search keeps its direct lookup. Voice uses the same selector as text, then its existing native voice model answers—no extra text-answer call.
- A normal text turn now uses two model calls. The existing citation correction can add one more. All calls count toward the existing invocation allowance; selection leaves room for the answer. Invalid selections fail without calling the answer model or automatically retrying.
- Voice refinements share the turn's invocation allowance and reuse duplicate lookups. Stop, a new question or ending the call cancels selection and prevents delivery of old evidence. Selection calls use the existing durable run/usage records, without becoming text-chat retry jobs.
- Preserve source permissions, original-byte checks, the conversation's history cutoff, cancellation, citations, embeddings, summary caches, histories, notes and explicit review. No archive rebuild or database migration is required.
- Tests cover source selection, neighboring results, conflicting evidence, empty results, malformed IDs, changed/excluded originals, cancellation, call accounting and keeping closing qualifications when excerpts are shortened. Model selection can still miss relevant evidence, especially if local search does not find it.

## 0.8.9

- Treat session records as append-only during summary preparation. Reuse completed receipts and compact roots across appends instead of repeatedly reconstructing prompts and verifying all original bytes. Preserve source opt-outs, cancellation, invocation accounting and selected-original citation/retrieval checks.
- Summarize only uncovered inputs. Pass a fitting forest directly to the final briefing; when reconciliation is needed, produce the current-state input directly. Retain historical caches and explicit review controls.
- Hand captured evidence directly to preparation and adopt an existing completed background history index without a mandatory foreground refresh. Explicit **Refresh history** still refreshes; new entries join archive retrieval after the next completed index pass.
- Real-model qualification on an isolated data copy reached chat readiness in **54.3 seconds**, with **11.1 seconds** of local tree work, covering 28,065 entries and summarizing a 44-entry tail. These measurements are not a universal latency guarantee or a model-quality claim.

## 0.8.8

- One automatic-preparation control runs local indexing followed by paid summary caching, with a shared failure status and explicit retry. Preserve existing opt-outs and old open tabs' local-only consent; never retry failed paid work merely because time passes.
- Remove the separate summary settings component, duplicate status polling and unused background source-checkpoint calculation. Background completion verifies captured originals and permissions rather than rebuilding the live snapshot; later arrivals belong to the next batch.
- Remove repeated frozen-snapshot reads during initial briefing preparation. Keep fresh provenance checks before final/repair inference and inside the save transaction, along with cancellation, source exclusions and invocation accounting. No instant-start guarantee.

## 0.8.7

### Small sync responses and scoped prepared chat

- Opening a sync, starting chat and mutation/retry responses never transfer the frozen evidence archive. Briefings, conversations, notes, counts and progress remain available without loading original source bodies.
- Remove bulk evidence browsing; citation clicks read only the selected frozen original in 4,000-character pages, with current source permissions and original-byte verification. Missing originals remain visible as unavailable; no cached text substitution.
- Prior recaps, note updates and discard checks use metadata rather than repeatedly hydrating whole snapshots. Initial briefing preparation still needs work; this is not an instant-start guarantee.

- Prepared text chat uses the saved briefing, conversation and prepared search; it no longer rebuilds the summary tree or repeatedly reads/verifies the full snapshot and archive receipt.
- Rank prepared search candidates before resolving selected originals. Preserve source permissions, original-byte checks for supplied evidence, explicit frozen-reference reads and invocation/cancellation accounting.
- Remove the checkpoint-citation veto and its model retry. Invalid citation labels still receive at most one correction; heuristic citation combinations no longer discard an answer.
- Keep evidence inspection separate from sync polling and chat updates. Remove obsolete chat-wide verification and prompt-wording tests; retain preparation-cache tests at preparation boundaries.
- Preserve histories, frozen evidence, embeddings, summary caches, notes, cancellation, idempotency and explicit review. Background indexing and summarization settings/failure pauses are unchanged in this release; unifying that pipeline is separate work.

## 0.8.6

### Brief current project state, not exhaustive history

- Opening briefings prioritize the latest meaningful state per project/workstream: recent outcomes, current blockers, unresolved decisions and next actions. Prefer one recent supporting citation per project/session, adding a few only when distinct claims or contradictions require them. Citation limits are safety ceilings, not targets.
- Oversized roots use the existing final-summary step to select current-state content instead of preserving every historical observation. Superseded plans, resolved issues and repetition can be omitted; older unresolved constraints, contradictions and uncertainty must remain qualified. Already-small roots go directly to the final model with the same current-state instruction, without an extra call.
- Preserve historical leaves and broad reconciliation caches for follow-up. A selective briefing is reusable only for its complete input, never as historical coverage when new activity arrives. No history, snapshot membership or review coverage is removed or changed.
- Retain evidence verification, cancellation, bounded repairs and existing token/reference/invocation limits. No new worker, endpoint, schema or preparation system.

## 0.8.5

### Repair aggregate citation overflow within the existing final budget

- Distinguish excess distinct citations from excess estimated tokens during final-input compaction, reporting the actual count and limit.
- Route aggregate citation overflow through the existing bounded citation-only repair. Preserve every candidate observation's prose, topic, state and limitations; accept only nonempty supporting subsets of that observation's original references.
- Keep the existing 16-reference-per-observation, 96-distinct-reference, 12,000-root-token and 64,000-final-token limits and two-attempt allowance. Unsupported or still-over-budget results stop visibly, without local truncation or an expensive-model fallback.
- Preserve cache identities, evidence validation and cancellation. A successfully repaired compact parent remains reusable after a later final-provider interruption. This does not guarantee every provider result can be safely compressed.

## 0.8.4

### Keep UI status polling from blocking preparation

- Conversation and chat-readiness status reads report the recorded preparation checkpoint and scheduler progress instead of recomputing full-history readiness fingerprints. Full verification remains at actual preparation, history adoption and use boundaries.
- During initial foreground preparation, show preparing rather than advertising new information before the conversation has its prepared cutoff.
- No new worker, database copy, schema, endpoint or timer cache. Preserve source validation, existing histories, cached summaries, embedding bytes and explicit review behavior.
- This release does **not** fix the separate `Compact final input` / compact-final-budget failure. Recorded progress is not a guarantee of successful briefing preparation or current evidence validity.

## 0.8.3

### Prepare summaries and embeddings ahead by default

- Background summary preparation defaults on when no preference is saved, using the configured summary provider and quota/API billing. Explicit saved opt-outs remain off.
- Remove the 64-entry gates and active-conversation scheduling split. Idle minute checks index and summarize new or changed activity, including single-entry tails, without creating a sync, briefing or review.
- Reuse the existing scheduler, shared summary cache, durable receipts and embedding checkpoints. Unchanged prepared inputs cause no new model calls. Explicit syncs reuse completed work and generate their briefing; unfinished or changed inputs may still require preparation.
- Retain foreground priority, cancellation ownership, invocation limits and pause-until-retry handling for provider failures. No schema, endpoint, worker or preview system added.

## 0.8.2

### Show new activity instead of the unreviewed backlog

- Home now headlines **new entries to prepare**: eligible indexed entries never included in an earlier sync. Previously included unreviewed entries, reservations and review totals remain under collapsed Details.
- Calculate the count from existing entry IDs and snapshot membership in the ordinary Home metadata query. No planner check, original-log reads, database copies, workers, new endpoints or background jobs are added.
- Keep the meaning explicit: this is new activity, not an exact inference or billing count. Cached work is reused; unfinished work and the final briefing may still need processing. Existing Mark reviewed behavior and all sync membership/preparation rules are unchanged.

## 0.8.1

### Carry unreviewed entries forward without repeating completed work

- Preserve validated completed summary batches across snapshot rollover, append-only tails, cancellation and restart instead of rebuilding their input boundaries. Legacy output-only caches require exact reconstruction from verified originals; citations alone are never evidence of complete batch coverage.
- Keep unreviewed entries in subsequent snapshots. Neither conversation expiry nor cached preparation marks them reviewed. Show newly included versus previously included entries separately from preparation status.
- Add lifecycle regressions proving unchanged corpus embeddings and existing history references survive combined snapshots and restart. Original verification and new alias metadata remain required; they do not recompute existing vectors.
- A new combined reconciliation or final briefing can still require explicit provider work. This does not resume cancelled runs or enable paid background preparation.

## 0.8.0

### Live history without rewriting the sync

- Active text and voice conversations adopt newly **prepared original history** between user turns as dated H evidence. Each answer pins one history cutoff; updates do not interrupt an ongoing reply or disable already-prepared chat. The initial snapshot, E/C references, briefing, saved transcript and notes are not rewritten by updates. Initial briefing and history preparation are still required once.
- Fix readiness invalidation from ordinary source appends and background scan cursor changes. Damaged, missing or excluded captured originals still fail closed. If additional archive lookup is unavailable during an update, replies must qualify that limitation rather than guess or silently substitute old context.
- With **Automatically index history** enabled, active conversations check once a minute for any positive source changes, without waiting for 64. Connected, idle voice can allow local background work between turns, never during a pending response or context delivery; a user turn preempts and drains owned indexing. With no active conversation, the 64-record threshold and no timed small-tail flush remain.
- Live H updates are local-only, not per-minute provider calls. **Prepare summaries ahead** remains a separate default-off paid permission with its independent 64-record threshold. Neither background path creates syncs, final briefings, recaps, saved decisions or review. Settings/status GETs remain metadata-only.

### Sessions end without marking work reviewed

- End a conversation after 30 minutes without a real user chat message or voice turn; initial creation counts as initial intent. Polling, background updates, assistant responses and connection heartbeats do not extend it. An ongoing reply finishes before idle expiry.
- Show **Session ended**, not reviewed or completed. Keep the transcript readable and explicit notes/review available for the old snapshot. Return home and **Start new sync** to chat again; replay, polling and reopening cannot revive an ended session.
- Persist last user activity and the ended marker across restarts, separately from existing open/completed/discarded review status. Idle ending releases unreviewed reservations for the next explicit sync, without deleting history, changing notes or generating an automatic recap/review. Migration derives activity from stored real user turns; inactive older sessions may end and their unreviewed entries become available again.
- Simple live status is **Up to date**, **Preparing new info…** or **New info ready**, with honest off/unavailable states where applicable. Voice's separate 30-minute connection limit, 60-turn cap and 90-second disconnect lease remain resource bounds, not unlimited calling or spending guarantees.

### Upgrading and qualification

Back up original agent logs and Draken state, finish active work, stop the server (including any tray-owned server), install 0.8.0 and restart with the same data directory and environment. Node.js 22.19+ remains required. The conversation lifecycle migration is additive; existing review statuses and historical data remain intact. No dependency changes. See [SETUP.md](SETUP.md#upgrade-to-080) and [MEMORY.md](MEMORY.md#live-conversations-and-idle-ending).

Focused coverage includes conversation lifecycle, append-safe readiness and between-turn voice updates, alongside existing activity/indexing regressions. Package and static-site checks protect release copy and fresh paid opt-out. Synthetic checks do not establish real-provider answer quality, latency, quota or physical-device audio acceptance.

## 0.7.0

### Optional paid summary preparation, without automatic syncs

- Add **Settings → Prepare summaries ahead**, a NEW explicit paid opt-in (`auto_summary`), default **off** on fresh installs and upgrades—even when `auto_index=true` or the retired 0.5 paid setting was enabled. It requires **Automatically index history** to be enabled. Local indexing keeps its existing defaults/preferences and makes no provider calls by itself.
- While idle, check once a minute and prepare at least 64 new/changed eligible accumulated records, independently of the local embedding checkpoint. Warm the same validated `summary_cache` leaves, reconciliation and compact final input used by explicit syncs. Background preparation does not own or create syncs, snapshots, coverage, messages or tree rows, and never runs the final model, briefings or recaps.
- Reuse completed closed chunks across appends and make no further calls for unchanged prepared input while its validated cache remains intact. Lost or corrupt cache outputs trigger a bounded rebuild rather than postponing recovery until Start chat. Changed unfinished per-session tails and aggregate reconciliation may still need on-demand work at **Start chat**; the final briefing is always explicit. This reduces repeated preparation, not a promise of instant chat.
- Bound paid work by the configured summary model and the same `max_invocations` allowance, without provider/model fallback. Foreground work cancels and awaits owned background provider work. Valid cache survives cancellation/restarts; spending is retained when resuming the same interrupted input. Paid failures pause retries until an explicit retry; local indexing failures retain their five-minute retry delay. Disabling either setting stops paid background work without deleting cache.

### Durable accounting and preservation

- Add metadata-only `background_runs` for durable input hashes, invocation counters and metrics, not source text. **Preparation usage** includes background spend, requests and failures. `completed_batches` remains the count of explicit snapshots' first successful briefings; a warm cache is neither a sync nor review.
- Settings/progress GETs only read metadata. Existing histories, conversations, notes, coverage, frozen snapshots and compatible caches are preserved. No dependency changes.
- Focused regressions: `tests/background-tree.test.cjs`, `tests/background-preparation.test.cjs` and `tests/automatic-index.test.cjs`; production-package and static-site checks protect default-off consent and release copy. Synthetic checks do not establish real-provider quality, latency, quota or physical-audio acceptance.

### Upgrading

Back up original agent logs and Draken state, finish active work, stop the server (including any tray-owned server), install 0.7.0 and restart with the same data directory and environment. Node.js 22.19+ remains required. To get preparation ahead, keep **Automatically index history** enabled and explicitly enable the NEW **Prepare summaries ahead** switch; upgrading never converts local indexing or retired paid consent into this permission. Leaving it off keeps provider use tied to explicit preparation/conversation actions. Do not use an older binary to undo the additive schema change. See [SETUP.md](SETUP.md#upgrade-to-070) and [MEMORY.md](MEMORY.md#optional-paid-summary-preparation).

Previously oversized summary batches split at a moving midpoint may need one-time recomputation. The new stable-prefix planner preserves completed boundaries on future appends; ordinary batch keys and compatible historical leaf caches are retained.

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
