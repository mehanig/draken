# Contributing to Draken

For normal installation, use the npm instructions in [SETUP.md](SETUP.md). This guide is for people changing, building or qualifying Draken itself. Node.js **22.19+** and npm are required.

## Build and run a checkout

```sh
git clone https://github.com/mehanig/draken.git
cd draken
npm ci
npm --prefix client ci
npm run build
node dist/cli.js
```

Use `node dist/cli.js` in place of `draken` when following the user guides from a checkout—for example, `node dist/cli.js status` or `node dist/cli.js tray`. No global npm installation is needed for development.

The foreground server defaults to `http://127.0.0.1:40333`; Ctrl+C stops it. Use a disposable `DRAKEN_DATA_DIR` and synthetic source roots when testing changes. A manually launched development server otherwise uses the normal private state/history locations. Do not build over or replace files used by a live deployment; use a separate checkout for staged work.

For frontend development, run the backend and `npm run dev:client` in separate terminals. Vite proxies `/api` to port 40333. Server changes need a rebuild/restart; `npm run dev` runs the TypeScript watcher.

## Ordinary checks

```sh
npm run check                  # Root/client typechecks and Knip
npm test                       # Build server, then backend tests
npm run build                  # Server and frontend production builds
npx --no-install playwright install chromium
node --test tests/live-browser.cjs tests/realtime-browser.cjs
npx --no-install playwright test
node --test tests/site-browser.cjs
```

On a Linux CI image, Playwright may also need `--with-deps`. `npm run test:ui` combines the full build and application UI suite.

These tests use temporary synthetic records, fake providers and browser peers. They do not read your real source histories or call a real model provider. Website checks serve only the public static files and verify mobile layout, evidence-reference interaction and the absence of microphone/external-request activity.

### Fresh package and runtime qualification

After a full build:

```sh
node tests/package-smoke.cjs
node tests/runtime-smoke.cjs
npm audit
npm --prefix client audit
npm --prefix runtime/pi audit --omit=dev
```

These smoke checks download npm dependencies into isolated temporary homes. The runtime check installs the pinned pi/Codex packages, checks missing-auth metadata, verifies pi text/usage behavior against synthetic loopback responses, and exercises native RPC denial/text boundaries and confirmed helper exit. It does not sign in, refresh real credentials, call real providers or acquire a microphone. Root/client audits do not cover the separately shipped pi lock; audit it explicitly.

## Voice qualification

Ordinary voice tests cover native-only UI/control behavior, source lookup, interruption, no-capture-on-reload, absent retired endpoints and readable legacy records. Synthetic audio is not a human recording and is not proof of physical microphone, speaker, Bluetooth or mobile performance.

The following optional commands require their stated setup and, for real provider use, explicit consent:

```sh
# Requires the pinned native helper; synthetic auth and loopback backends only:
npm run test:realtime:native

# Requires separate native ChatGPT sign-in; real provider, synthetic data/audio:
npm run voice:realtime:probe -- --allow-provider
DRAKEN_TEST_STATIC_DIR=/path/to/staged/frontend npm run test:live:real -- --allow-provider

# Real voice with a controlled delayed lookup:
DRAKEN_TEST_STATIC_DIR=/path/to/staged/frontend node tests/voice-continuation-real.cjs --allow-provider
```

The environment-prefix examples above use Bash syntax. Real-provider probes are not included in ordinary tests or CI. Never add automatic credential copying, provider fallback, execution tools or approval grants to make a probe pass.

## Local-model qualification

After building, opt into downloading the pinned embedding weights, or supply an existing private test copy:

```sh
npm run test:memory:local -- --download-model
npm run test:memory:local -- --model-dir=/private/path/to/model
node tests/memory-performance.cjs --model-dir=/private/path/to/model
```

The local-model check uses temporary synthetic records, real offline embeddings and the actual worker. It covers paraphrase/multilingual retrieval, abstention, native context, H citations, cancellation/resume and unchanged evidence/coverage. It does not open the production database or call OpenAI. The download flag controls this test harness, not ordinary product search.

The performance check compares the prior single-session runtime with the bounded pool on 48 synthetic passages plus long-window/query-prefix cases. It reports wall time, RSS, cosine similarity and byte equality. It does not download weights, inspect production history or guarantee whole-sync speed or retrieval quality.

## Desktop tray qualification

On an interactive macOS/Windows desktop, after building:

```sh
node --test tests/tray.test.cjs tests/native-launch.test.cjs
npm run test:tray:native
```

The native smoke check opens a temporary icon, updates status and checks orderly exit. It does not start a Draken server, open a browser, scan history or access a provider. Hosted success does not verify physical menu clicks, desktop policies, logout behavior or every architecture. Complete the manual checks in [TRAY.md](TRAY.md) and [ACCEPTANCE.md](ACCEPTANCE.md).

## Public website

`site/` is plain HTML/CSS with a small, synthetic evidence-reference interaction. It has no account/API integration, remote fonts, analytics or microphone access. Keep demo content labelled and never use private project screenshots or histories.

Merging `site/**` changes into `master` triggers `.github/workflows/web-deploy.yml`, which deploys to the existing Cloudflare R2 site and purges its cache. A feature-branch push does not deploy it. npm publication and application deployment are separate operations. Keep version notices and installation commands accurate. Before announcing a release on the site, verify that the npm registry serves the expected version and test a fresh production-only installation. A successful publish command can precede registry availability while npm processes the package. Update the site and user documentation to match the confirmed release.

## Keep the code lean and the boundaries explicit

- Server and React UI code are TypeScript; native helpers/installers and some tests are JavaScript. The old Python speech worker is removed.
- Both TypeScript configurations reject unused locals/parameters. Pinned Knip models both packages, spawned fixtures, HTTP-served modules and generated-to-source mappings.
- Prefer individually inspectable client API exports. Preserve real test seams even where CommonJS namespace imports prevent exact unused-export attribution.
- Static reachability is not runtime proof. Trace HTTP routes, dynamic imports, generated assets, declarations and failure/cancellation/security paths. Do not remove safeguards to quiet an analyzer or test.
- Source-only pointers, exact compatible vectors, explicit source permissions, independent voice sign-in and review-only coverage are product boundaries—not optional implementation details.
- Keep credentials, private runtime data, databases, original histories and diagnostic artifacts out of git/npm. Never deploy a proof database.

## Code map

| Area | Location |
| --- | --- |
| Runtime selection, private setup and pi-owned auth | `src/pi/`, `src/npm-cli.ts` |
| Agent registry and supported log readers | `src/sources/`, `src/sync/collector.ts` |
| Source-only evidence and migrations | `src/db/`, `src/sync/source-files.ts` |
| Frozen snapshots, notes and review | `src/sync/store.ts` |
| Summary trees, references and accounting | `src/sync/{tree,pi,pi-output,cost,references}.ts` |
| Recaps and conversation orchestration | `src/sync/{recap,manager}.ts` |
| Retrieval, embedding pool and batching/checkpoints | `src/memory/` |
| Authenticated application APIs | `src/routes/` |
| Native voice ownership and browser controls | `src/voice/`, `voice/realtime/`, `client/src/voice/` |
| Home, snapshots and history UI | `client/src/pages/`, `client/src/components/` |
| Tray ownership and OS helpers | `src/tray/`, `tray/` |
| Landing page | `site/` |

See [ARCHITECTURE.md](ARCHITECTURE.md) for design details and [ACCEPTANCE.md](ACCEPTANCE.md) for review/release gates. Passing CI is not permission to merge, publish, deploy, change real credentials or make provider calls.
