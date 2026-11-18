# Before approving or releasing Draken

This is a read-only engineering-sync application, not the old Docker/task dashboard. A draft PR, passing CI, configuration check, or quick code skim is not a release qualification. Public npm/website content changes only through separately authorized publication/deployment.

## Automated gates

`Application qualification` runs strict typechecks/unused-code analysis, production builds, backend and browser-controller tests, Chromium UI regressions, root/client/private-pi-lock audits, a fresh production-only npm package/lifecycle smoke, and private runtime installation/protocol checks. `Tray platform checks` runs controller/executable tests, native helper startup/update/shutdown, and private pi/Codex installation on hosted macOS and Windows.

Runtime qualification uses a private HOME and synthetic loopback responses: it does **not** use real provider accounts, sign in, refresh credentials, acquire a microphone, or claim physical audio/menu usability. Package installation downloads npm dependencies. UI screenshots on failure contain synthetic fixtures only. CI dependency audits are time-specific advisory checks, not exploitability analysis or a security certification.

The release workflow requires a strict stable version already committed consistently in the manifest/lock, source on `master`, and both qualification workflows. Manual versions are passed as data, not interpolated into shell programs. Release uses pinned Node/npm versions and trusted-publishing provenance. No release is triggered by an ordinary PR push. Workflow checks are not a claim that repository branch protection has been configured.

## Short product acceptance checklist

Use disposable histories first. Real-provider checks below require the operator's explicit sign-in and consent.

- [ ] **Useful, qualified briefing:** distinguish what was proposed, attempted, tested, deployed, and still unresolved. Inspect original evidence and a late correction; verify the summary preserves chronology and qualifications rather than sounding more certain.
- [ ] **Explicit permissions:** Codex/Claude imports stay off until independently enabled. Opening Settings/setup/status does not scan transcript bodies, prepare a snapshot, download an embedding model, call a provider, or request a microphone. Automatic preparation is separate from agent-source permission; legacy local-only opt-in alone cannot authorize paid summaries.
- [ ] **Automatic preparation and restart:** eligible new activity, including small tails, gets indexed and summarized during idle checks when enabled. Background work never creates a snapshot or briefing. Session bookkeeping and aliases do not multiply the change count. Unchanged prepared input makes no further summary calls. Completed cache survives restart; cancelled foreground jobs are not retried automatically. Paid failure pauses survive restart until explicit retry. Review and notes remain untouched.
- [ ] **Evidence availability:** removing/changing a frozen original fails visibly; no cached-source fallback invents availability. Notes/discussion remain inspectable. Restore the exact original and verify recovery without regenerated evidence or review.
- [ ] **Import completeness:** a source larger than 32 MiB reaches its captured tail before a new snapshot or call readiness. Cancellation retains committed chunks without marking a partial import complete; retry resumes. An unfinished final record is deferred; an oversized or unreadable record blocks preparation. Later appends do not cause an endless chase.
- [ ] **Useful retrieval:** replay project-status and follow-up questions with older identical user questions and acknowledgements present. Confirm original project evidence, latest recorded work, technical definitions and concrete remaining work—not just source IDs. Include duplicate passages, ambiguous topics, project switches, explicit conversation recall, source readback and per-turn source lists. Passing transport tests alone is insufficient.
- [ ] **Call readiness:** a new conversation requires a briefing and a completed history receipt; an existing completed background receipt can be reused. Preparation does not reserve a call or acquire a microphone. New appends wait for preparation and a between-turn cutoff update without disabling already-prepared chat. Selected originals still require permission and matching bytes.
- [ ] **Evidence selection:** text and voice use the configured summary model to select source IDs, then their existing answering model. Check empty and invalid selections, invocation limits and original-source exclusions. Stop/new questions/end-call must cancel selection without delivering stale context. Voice must not add a text-answer call.
- [ ] **Call lifecycle:** cancel history preparation before a call; separately cancel connection before the create response arrives. Reload and start again. Microphone acquisition stays after preparation and explicit intent. End/Stop/mute/hidden-page behavior is understandable; no call restarts itself.
- [ ] **Review is yours:** included/retrieved/summarized/generated/heard/agreed/reviewed are not interchangeable. Only explicit review advances coverage. Discard, failure, cancellation and app restart do not mark work reviewed.
- [ ] **Real account and audio, separately:** configuration metadata alone does not prove provider/model access, token refresh, quota, billing or audible playback. If desired, test each explicitly with the intended account/device/browser; do not infer them from CI.
- [ ] **Physical desktop tray:** on actual macOS and Windows desktops, check icon visibility, all menu actions, browser opening, close-terminal survival, external-server observation, owned Stop/Quit and helper loss. No saved-PID adoption, external-server termination, silent settings changes or second same-data listener. Hosted helper smoke is not this test.
- [ ] **Overall value:** does the briefing and discussion help you resume engineering work better than reading the original sessions directly?

## Focused independent review

Review authentication/origin boundaries, original-pointer/storage migrations, and child-process ownership/cancellation separately. Existing synthetic and private migration proofs are scoped evidence, not proof of every source format or deployment. Back up original JSONL histories **and** Draken private state before a real migration. Preserve exact compatible vectors, identities, references, credentials, TLS configuration and original launch environment; never deploy proof databases.

Keep the PR draft until the remaining risks are accepted. Version bump, merge, npm publication, website update and live deployment are distinct decisions. Older selected pi runtimes are not silently upgraded; the operator must explicitly rerun setup or update their external pi installation.
