## Final test-quality review

**Two worthwhile findings remain.** This was a static, read-only review: no commands, mutations, or test execution. I completed every named test file before following production references. The known terminal-host lifecycle finding is excluded; this report does not claim a separate terminal-change gate.

### 1. Retry coverage depends on internal batching and wall-clock commit timing

**Location:** `tests/memory.test.cjs:286–303`, “delta-only indexing … resumes pending batches”.

The fake embedder fails on its ninth `embedMany` call, while assertions require exactly 64 committed passages and eight remaining. Those expectations silently depend on both production batching rules in `src/memory/index.ts`, `HistoryIndex.prepare()`:

- inference batches contain eight passages;
- commits happen at 64 pending passages **or after one second**.

Consequently, this test can fail without a behavioral regression. For example, a scheduling pause can trigger an early eight-passage commit. The following 56 passages can remain uncommitted when the ninth call throws, correctly leaving more than eight passages to retry. Changing inference batch size would also require coordinated test edits unrelated to the behavior being protected.

**Minimal correction:** Have the fixture fail the next embedding request after observing the first nonzero committed-progress update. Record that committed count and derive retry expectations from it, rather than from call ordinal nine and fixed counts 64/eight.

**Preserve and establish:**

- unchanged preparation performs no inference or derived writes;
- progress reports committed work, not merely computed vectors;
- completed work survives failure and is reused on retry;
- the remaining delta is eventually completed;
- original vector bytes and review coverage remain unchanged.

The existing assertions provide the right coverage; the failure trigger and expected retry counts need to follow the observable commit boundary.

### 2. Agent API coverage inherits the developer’s authentication configuration

**Location:** `tests/agents.test.cjs:14–20` and `132–145`, “agent settings validate exact requests …”.

The fixture configures source/data directories but not authentication. The API test then makes unauthenticated requests and requires `/api/overview` to return 200.

`src/auth/middleware.ts` deliberately enables authentication when `DRAKEN_NO_AUTH=false`, credentials are configured, or the configured host is non-loopback. `src/server.ts:createApp()` installs that middleware on the tested routes. Thus an otherwise valid developer environment can make this test fail before reaching agent-settings behavior. Binding the test listener to `127.0.0.1` does not override those configuration rules.

This is a hidden dependency between an agent-settings regression test and the caller’s application-launch environment.

**Minimal correction:** Explicitly own local anonymous configuration in this fixture—set `DRAKEN_NO_AUTH=true` and `DRAKEN_HOST=127.0.0.1`, restoring their previous values afterward. Do not bypass the real API or origin middleware.

**Preserve and establish:**

- exact request validation and unknown-agent rejection;
- rejection of foreign origins;
- enabling an agent does not scan;
- metadata GETs create neither source/sync activity nor a memory index.

The existing API assertions should remain; they should pass independently of inherited authentication settings. Authentication behavior already has dedicated coverage in `tests/sync.test.cjs`.

## Meaningful coverage retained

No wholesale test removal or new test framework is justified.

- **Agents, sync and sources:** opt-in admission, namespace separation, immutable source-backed snapshots, branch/edit semantics, malformed-tail handling, cancellation/retry, migrations, durable checkpoints, exclusions, and explicit review coverage.
- **Memory:** hybrid retrieval, semantic versus lexical matches, original-byte verification, cutoff/admission enforcement, cache reuse, vector integrity, readiness, bounded packets, worker retirement and progress validation. The optional benchmark remains a current-implementation compatibility/throughput comparison, not proof of retrieval quality.
- **Summaries and home:** complete snapshot processing, negative qualifications, citation closure and repair, invocation ceilings, cached-work reuse, cancellation, recap redaction, cost accounting, pagination and idempotency.
- **Runtime and tray:** argument preservation without shell interpretation, environment isolation, server discovery/ownership, IPC authority, attachment versus ownership, and shutdown refusal.
- **Voice:** real browser audio and cleanup, RPC framing/privacy/denial, native-adapter ordering, retired endpoint boundaries, historical playback qualifications, bounded continuation and complete history-packet transport.

Migration, security and protocol explanations generally supply useful rationale. I found no additional narration-only comment cleanup substantial enough to retain as a finding. Dynamic cache fixtures remain useful mechanics tests; they should not be mistaken for independently frozen historical-compatibility proof.

## Complete scope-read certification

All **18 named files, 2,396 physical lines**, were read completely through EOF using bounded reads. No byte-truncated output was accepted. Files exceeding a read boundary were explicitly continued.

| File | Complete physical-line ranges read |
|---|---|
| `tests/agents.test.cjs` | 1–156 |
| `tests/memory-performance.cjs` | 1–38 |
| `tests/memory.test.cjs` | 1–220; 221–384 |
| `tests/native-launch.test.cjs` | 1–32 |
| `tests/pi-output.test.cjs` | 1–48 |
| `tests/realtime-browser.cjs` | 1–149 |
| `tests/realtime-native.cjs` | 1–55 |
| `tests/realtime.test.cjs` | 1–192 |
| `tests/server-state.test.cjs` | 1–83 |
| `tests/source-batch.test.cjs` | 1–109 |
| `tests/summary-batches.test.cjs` | 1–220; 221–239 |
| `tests/sync-home.test.cjs` | 1–104 |
| `tests/sync.test.cjs` | 1–220; 221–440 |
| `tests/tray-native.cjs` | 1–15 |
| `tests/tray.test.cjs` | 1–138 |
| `tests/voice-boundary.test.cjs` | 1–92 |
| `tests/voice-continuation.test.cjs` | 1–95 |
| `tests/voice-history-delivery.test.cjs` | 1–27 |

Also read `/tmp/draken-review-instructions.md` and `docs/refactor-decisions.md` completely. Production/fixture follow-up was limited to relevant references. **No named-scope read gaps remain.** Runtime, real-model, native-desktop and provider qualification were not performed.

**CONFIRMED FINDINGS REMAIN**
