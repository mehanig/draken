# Remaining work

Current behavior and shipped changes are documented in [README.md](README.md), [MEMORY.md](MEMORY.md) and [CHANGELOG.md](CHANGELOG.md). This roadmap lists unfinished work rather than repeating past implementation plans.

## Retrieval and answer quality

- Evaluate text and voice on status, decisions, technical facts, failures/corrections, similar projects and questions whose answers are absent. Keep some questions separate from tuning.
- Measure candidate coverage separately from model selection and answer quality. A fluent answer and valid citations do not prove completeness or factual support.
- Evaluate recent **matching** entries alongside keyword/vector results, while preserving older decisions and historical time ranges. This is deferred follow-up work, not part of the 0.9.0 tests/docs cleanup.
- Measure selection latency and cost on broader histories. The 0.9.0 replay results and known omissions are recorded in [its review](docs/refactor-reviews/090-evidence-selection.md).

## Briefing quality and cache reuse

- Compare full-history summaries with original-source baselines on synthetic and explicitly approved local samples.
- Measure missed decisions/blockers, stale next steps, false completion claims, cost and latency. Include reversals, multiple workstreams in one workspace and tasks split across batches.
- Qualify append-only cache reuse on more histories without replacing historical originals or broad caches with an endless chain of lossy summaries.
- Improve ways to challenge inaccurate summaries without discarding conversations or notes.

## Native voice and desktop qualification

- Test physical microphones, speakers, Bluetooth, browser differences and long sessions with explicit account/device consent.
- Measure native-provider answer quality, quota/idle usage and compatibility with future helper versions. Synthetic transport tests do not establish these.
- Test tray menus and ownership behavior on actual macOS and Windows desktops, separately from hosted helper smoke tests.

## Later evaluation

- Compare community session-memory and retrieval approaches before adopting another implementation. Evaluate incremental work, original-source attribution, corrections, secrets, costs and recovery.
- Consider model/budget settings, retention controls and optional read-only Git/CI evidence.
- Keep task execution outside the read-only product unless separately designed and explicitly approved.
