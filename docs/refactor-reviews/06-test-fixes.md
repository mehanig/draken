## Final gate: clear

The **four reported findings are resolved**, and I found no worthwhile new regression in the qualification changes or terminal cancellation tests.

This was an independent **read-only static review**. I ran no tests, commands, builds or mutations. The terminal16, hostile-auth agents9, normal/early-commit retry runs, and qualification mutation results are parent-reported evidence—not my execution.

### Remediation verified

| Finding | Current assessment |
|---|---|
| Missing synthetic history readiness | `tests/live-voice-real.cjs` installs `fixtures/fake-memory.cjs` before loading application/voice consumers and asserts `callReadiness(syncId).ready` before browser/provider work. It also requires an enabled **Call Draken** button. Production readiness is not weakened. |
| Stale default client build | The script now passes only the optional `DRAKEN_TEST_STATIC_DIR` override; otherwise `createApp()` selects the repository build. The UI regression excludes inherited overrides and compares the served HTML hash with `public/index.html`. |
| Fixed retry batch/timing assumptions | `tests/memory.test.cjs` now triggers failure after observing nonzero committed progress, verifies that progress against committed database rows, and derives remaining/reused counts from that observation. It retains unchanged-index, original-vector and coverage assertions without assuming failure on call nine or exactly 64/eight passages. |
| Inherited agent API authentication | `tests/agents.test.cjs` explicitly sets anonymous loopback configuration and restores both previous values afterward. Real API validation and foreign-origin rejection remain exercised. |

### Qualification and ownership changes

- **Provider-free check:** `--check` intercepts voice API requests before navigation, supplies synthetic status, rejects other voice requests, checks that no live call was created, and never clicks the call button. The successful JSON result is emitted **after** awaited browser, native-voice, listener and database cleanup.
- **Current-build regression:** `tests/ui/qualification.spec.ts` requires successful subprocess completion and its final report, validates readiness and the served-build fingerprint, and checks that no memory directory was created. An unresolved cleanup promise cannot produce the required report and silently satisfy this test.
- **Real-provider scripts:** Both `tests/live-voice-real.cjs` and `tests/voice-continuation-real.cjs` now await `shutdownLiveVoice()`, including native status checks, rather than only stopping calls.
- **Optional native compatibility qualification:** `tests/realtime-native.cjs` owns cancellation across preflight, RPC and backing listeners. Cancellation closes check admission and RPC; guards after asynchronous boundaries prevent subsequent modes or operations. Cleanup awaits confirmed RPC exit and backend/listener closure. Cleanup rejection or noncompletion retains the host rather than permitting an apparently clean exit.
- **Actual executable cancellation tests:** `tests/native-terminal.test.cjs` launches synthetic helpers through the production default path, signals their terminal hosts, and checks helper disappearance **at host exit**, expected exit codes, and invocation logs proving no later work. Separate gated tests exercise late preflight/lab/browser completion and retained ownership after unconfirmed cleanup. The probe-server regression requires cleanup failure propagation after listener closure.

The fixture seams, process keepalives, platform distinctions and explanatory comments serve concrete isolation or ownership requirements. I found no actionable surplus, needless coupling, narration-only cleanup, or newly introduced false-pass/false-fail mechanism worth retaining as a finding.

### Complete current-file coverage

Every requested current file was read completely through EOF using bounded requests, with explicit continuation where needed:

| File | Bounded read requests |
|---|---|
| `tests/agents.test.cjs` | 1–220; EOF |
| `tests/memory.test.cjs` | 1–220, 221–440; EOF |
| `tests/live-voice-real.cjs` | 1–220; EOF |
| `tests/voice-continuation-real.cjs` | 1–220; EOF |
| `tests/realtime-native.cjs` | 1–220; EOF |
| `tests/native-terminal.test.cjs` | 1–200, 201–380; EOF |
| `tests/ui/qualification.spec.ts` | 1–220; EOF |
| `PERSONA.md` | 1–220; EOF |

Also read completely: `/tmp/draken-review-instructions.md`, `docs/refactor-decisions.md`, and reports `docs/refactor-reviews/05-tests-1.md`, `05-tests-2.md`, and `05-terminal-runtime.md`. Follow-up source/fixture reads were limited to the relevant readiness, authentication, batching, static serving and native cleanup contracts.

### Remaining limitations

- This gate freshly certifies the eight files above, not another complete reread of all 37 previously reviewed tests.
- Real-provider/audio, real-embedding, installation and Windows process behavior were not executed. The executable signal regressions explicitly skip Windows.
- The build comparison fingerprints served HTML—including its build asset references—not every asset’s bytes.
- Native production terminal scope retains its separate independent clearance; this review does not replace that entire source review.
- No credentials, private runtime data, generated assets or installed dependencies were read.

**NO WORTHWHILE FINDINGS REMAIN IN REVIEWED SCOPE.**
