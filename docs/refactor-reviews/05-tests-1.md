## Result

**Two confirmed test-quality findings remain**, both in `tests/live-voice-real.cjs`. The other listed files retain meaningful coverage; I found no additional change worth recommending.

This was a **read-only static review**. I executed no commands or tests and made no mutations. I completed the entire named scope before following production references. The known terminal-host lifecycle finding and concurrent fix are excluded from this review and require their separate gate.

## Confirmed findings

### 1. The real-provider qualification never establishes required history readiness

**Location:** `tests/live-voice-real.cjs:7–50`, fixture initialization and first “Call Draken” click.

The script creates a fresh data directory and inserts a completed briefing plus frozen evidence, but never prepares history or installs the synthetic history fixture. It then immediately clicks “Call Draken.”

This cannot reach the intended provider qualification against the current application:

- `src/memory/readiness.ts:82–84` returns `ready: false` when the fresh directory has no `memory/index.sqlite`.
- `src/sync/preparation.ts`, `callReadiness()`, requires history readiness independently of briefing completion.
- `client/src/components/VoiceCall.tsx:47,145` disables “Call Draken” until readiness is true.
- `src/voice/live.ts:233` also rejects an unprepared call.

`createApp()` does not start automatic preparation. Thus, even with correct client assets and a configured native provider, this script stops at its disabled-button interaction rather than testing voice behavior.

**Change-together rationale:** The qualification fixture still assumes that inserting a completed briefing establishes all call prerequisites. The application now deliberately separates briefing completion from prepared-history readiness.

**Minimal correction:** Initialize the existing test-only synthetic history service before loading the voice/application modules, as `tests/voice-continuation-real.cjs` does. This script qualifies real provider/UI behavior, not real embedding preparation; `tests/memory-real.cjs` already owns that separate qualification. Assert call readiness before entering the paid/provider portion so fixture failures are immediate and intelligible.

**Preserve:** Real native-provider audio, injected rather than physical microphone input, actual frozen-source retrieval, prior-recap recall, one-peer ownership, and unchanged coverage/decisions.

**Validation needed:** With a fresh temporary data directory and no local model, establish readiness and an enabled call button before proceeding. Retain the existing E2 retrieval, recap, audio, and cleanup assertions. Do not weaken the production readiness guard.

### 2. The same qualification defaults to an unrelated temporary client build

**Location:** `tests/live-voice-real.cjs:29`.

```js
staticDir: process.env.DRAKEN_TEST_STATIC_DIR || '/tmp/draken-live-preview'
```

The script neither creates nor validates this directory. A normal repository build produces the application’s `public` assets, while `createApp()` already defaults to that location.

Consequences:

- Without that ad hoc preview directory, the qualification fails before reaching the application.
- If an old preview remains there, it can qualify a stale client against the current backend, hiding browser regressions or reporting failures unrelated to the current client.

This is an implicit dependency on a previous developer workflow, not a provider requirement.

**Change-together rationale:** The qualification must serve the client build belonging to the code being qualified, rather than an independently maintained temporary copy.

**Minimal correction:** Pass the explicit environment override when supplied; otherwise use `createApp()`’s normal static-directory default. Keep the override for intentional alternate-build qualification. `tests/voice-continuation-real.cjs` already uses the repository build by default.

**Preserve:** Testing the real built UI rather than substituting an API-only or synthetic-controller test.

**Validation needed:** After building the client, with `DRAKEN_TEST_STATIC_DIR` unset and no preview directory, verify that the qualification loads the repository application. A missing build should produce a clear prerequisite failure rather than dependence on leftover assets.

## Meaningful coverage retained

- **References, chat, reconciliation, and summary trees:** Closed citation catalogs, stable wire labels, untrusted quoted references, bounded repair, later-report inclusion, cancellation, invocation ceilings, idempotent delivery, cache reuse, independently frozen legacy cache compatibility, and unchanged review coverage.
- **History and local-model qualification:** User-owned project focus, cutoff/admission constraints, source-versus-conversation selection, duplicate suppression, relevant explanatory excerpts, explicit offset reads, read-only prepared lookup, real local inference, and cancellation/resumption.
- **Voice and browser lifecycle:** Reservation before microphone access, cancellation during permission/negotiation, late-event ownership, typed replies after Stop, multipart evidence delivery, failure without partial publication, generated-versus-heard distinctions, authentication/origin restrictions, and automatic continuation.
- **Runtime, packaging, release, and TLS:** Private runtime installation and credential isolation, immutable release-version checks, production-only package installation, synthetic protocol/accounting qualification, trusted TLS, authenticated certificate download, and exclusion of private keys.
- **Persona, recap, and usage:** Audio-energy-driven presentation, reduced-motion/suspended-clock behavior, bounded recap reflow without lost qualifications, limited repair, pricing uncertainty, retry costs, and nonduplicated completed-batch accounting.

I would retain the explanatory comments concerning synthetic-only fixtures, protocol omissions, historical qualification, immutable source metadata, and privacy boundaries. I found no worthwhile standalone narration-only cleanup in this scope.

## Complete-read certification

All **19 named files were read completely** through EOF. The table records the **inclusive bounded read requests**, not inferred line counts. Where a request extends beyond EOF, the tool returned the complete remainder. No byte/output truncation occurred; every response indicating additional lines was followed by a continuation read.

| File | Bounded read requests |
|---|---|
| `tests/answer-references.test.cjs` | 1–250; EOF reached |
| `tests/chat.test.cjs` | 1–250; EOF reached |
| `tests/history-relevance.test.cjs` | 1–250; EOF reached |
| `tests/live-browser.cjs` | 1–250, 251–400; EOF reached |
| `tests/live-voice-real.cjs` | 1–220; EOF reached |
| `tests/live-voice.test.cjs` | 1–220, 221–460; EOF reached |
| `tests/memory-real.cjs` | 1–220; EOF reached |
| `tests/package-smoke.cjs` | 1–240; EOF reached |
| `tests/persona.test.cjs` | 1–240; EOF reached |
| `tests/pi-setup.test.cjs` | 1–240; EOF reached |
| `tests/realtime-backend.test.cjs` | 1–240; EOF reached |
| `tests/recap-format.test.cjs` | 1–240; EOF reached |
| `tests/reconciliation.test.cjs` | 1–240; EOF reached |
| `tests/release.test.cjs` | 1–240; EOF reached |
| `tests/runtime-smoke.cjs` | 1–240; EOF reached |
| `tests/tls.test.cjs` | 1–240; EOF reached |
| `tests/tree.test.cjs` | 1–240, 241–390; EOF reached |
| `tests/usage.test.cjs` | 1–240; EOF reached |
| `tests/voice-continuation-real.cjs` | 1–240; EOF reached |

Also read `/tmp/draken-review-instructions.md` completely and `docs/refactor-decisions.md` completely using requests 1–200 and 201–320. Subsequent implementation reads/searches were targeted to verifying the findings above.

**Coverage gaps:** None within the named file-reading scope. Runtime execution, real-provider acceptance, and the separate terminal-host gate are not claimed.

**CONFIRMED FINDINGS REMAIN**
