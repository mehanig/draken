import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeRpc } from './rpc.mjs';
import { createReadOnlyBackend } from './backend.mjs';

export const CODEX_VERSION = '0.166.0';
export const realtimeRoot = path.join(os.homedir(), '.draken', 'realtime');
export function codexExecutable(root, platform = process.platform, arch = process.arch) {
  if (platform !== 'win32') return path.join(root, 'runtime', 'node_modules', '.bin', 'codex');
  const target = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!target) throw new Error('Native voice requires Windows x64 or arm64.');
  // The pinned official optional package contains the actual executable. Own
  // that process directly: killing a Node/.cmd wrapper on Windows can orphan it.
  return path.join(root, 'runtime', 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', `${target}-pc-windows-msvc`, 'bin', 'codex.exe');
}
export const defaultBinary = codexExecutable(realtimeRoot);
export const defaultHome = path.join(realtimeRoot, 'account');
const exec = promisify(execFile);

// Positive allowlist: no API keys, pi session ownership, cloud credentials,
// proxy overrides, provider URLs, NODE_OPTIONS, or user agent configuration.
export function helperEnvironment(home, source = process.env) {
  const env = { CODEX_HOME: home, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), RUST_LOG: 'off' };
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (source[key]) env[key] = source[key];
  return env;
}
export function hasNativeLogin(home) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
    return !value.OPENAI_API_KEY && (!value.auth_mode || value.auth_mode === 'chatgpt') &&
      ['access_token', 'refresh_token', 'id_token'].every(key => typeof value.tokens?.[key] === 'string' && value.tokens[key].length > 0);
  } catch { return false; }
}
export async function nativeStatus({ binary = defaultBinary, home = defaultHome } = {}) {
  let installed = false;
  try {
    const { stdout } = await exec(binary, ['--version'], { env: helperEnvironment(home), timeout: 5000, maxBuffer: 4096 });
    installed = stdout.trim() === `codex-cli ${CODEX_VERSION}`;
  } catch { /* Report a structural status only; never leak subprocess output. */ }
  return { installed, expectedVersion: CODEX_VERSION, nativeLoginPresent: hasNativeLogin(home),
    readyForProbe: installed && hasNativeLogin(home), audioVerified: false };
}

/** The backing endpoint is owned by Draken, never a coding-model provider.
 * By default it denies every inference; an explicit read-only host callback may
 * return text through backend.mjs. It cannot return executable tool messages.
 * Feature flags and sandboxing are additional precautions, not that boundary.
 */
export function helperArguments(denyUrl) {
  const config = {
    forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file',
    check_for_update_on_startup: false, approval_policy: 'on-request', sandbox_mode: 'read-only',
    allow_login_shell: false, project_doc_max_bytes: 0, web_search: 'disabled',
    model_provider: 'draken_readonly', model: 'gpt-5.4',
    'model_providers.draken_readonly.name': 'Draken voice: no backend execution',
    'model_providers.draken_readonly.base_url': denyUrl,
    'model_providers.draken_readonly.wire_api': 'responses',
    'model_providers.draken_readonly.requires_openai_auth': true,
    'model_providers.draken_readonly.request_max_retries': 0,
    'model_providers.draken_readonly.stream_max_retries': 0,
    'features.realtime_conversation': true, 'features.shell_tool': false,
    'features.unified_exec': false, 'features.code_mode': false, 'features.js_repl': false,
    'features.apply_patch_freeform': false, 'features.apps': false, 'features.plugins': false,
    'features.hooks': false, 'features.codex_hooks': false, 'features.plugin_hooks': false,
    'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.collab': false,
    'features.computer_use': false, 'features.browser_use': false, 'features.memories': false,
    'features.remote_models': false, 'features.api_key_model_discovery': false,
    'features.enable_request_compression': false,
    'features.shell_snapshot': false, 'features.shell_snapshot_v2': false,
    'features.skip_host_skill_discovery': true, 'features.plugin_discovery_prefetch': false,
    'features.skill_mcp_dependency_install': false, 'features.image_generation': false,
    'features.worktrees': false, 'features.goals': false, 'features.remote_control': false,
    'history.persistence': 'none', 'analytics.enabled': false, 'feedback.enabled': false,
    // Call creation uses native Codex auth, never pi's direct-token credential.
    // The WebRTC control socket is a DIFFERENT endpoint: leave it at the
    // official helper's default. Pointing it at this call-creation origin fails.
    experimental_realtime_webrtc_call_base_url: 'https://chatgpt.com/backend-api/codex',
  };
  return [...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), 'app-server', '--stdio'];
}

export class NativeVoice {
  #rpc;
  #deny;
  #thread;
  #closed = false;
  #opened = false;
  #closing;
  #listeners = new Set();
  #home;
  #binary;
  #answer;
  #cleanup;
  #unsubscribe;
  constructor({ binary = defaultBinary, home = defaultHome, answer } = {}) { this.#binary = binary; this.#home = home; this.#answer = answer; }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #emit(event) { for (const listener of this.#listeners) { try { listener(event); } catch { void this.close(); } } }
  async open(sdp, { signal, prompt, initialItems, onReady } = {}) {
    if (this.#closed || this.#opened) throw new Error('A native voice instance can open only once.');
    this.#opened = true;
    if (typeof sdp !== 'string' || sdp.length > 64_000 || !sdp.startsWith('v=0') || (sdp.match(/^m=audio /gm) || []).length !== 1 || /^m=video /m.test(sdp)) throw new Error('One audio track and a bounded SDP offer are required.');
    const status = await nativeStatus({ binary: this.#binary, home: this.#home });
    if (!status.installed) throw new Error(`Install the pinned Codex ${CODEX_VERSION} helper first.`);
    if (!status.nativeLoginPresent) throw new Error('A separate native ChatGPT sign-in is required. Run npm run voice:realtime:login. The pi login is not copied or converted.');
    if (fs.existsSync(path.join(this.#home, 'config.toml'))) throw new Error('Use the dedicated voice account directory without a custom Codex config.');
    if (signal?.aborted || this.#closed) throw new Error('Native voice setup cancelled.');
    const abort = () => { void this.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    this.#cleanup = () => signal?.removeEventListener('abort', abort);
    try {
      this.#deny = await createReadOnlyBackend({ answer: this.#answer, maxRequests: 120,
        authorize: headers => {
          // Native auth already accompanies the helper's backing requests. Match
          // it locally without another secret in argv or a header that could be
          // forwarded to OpenAI. Refresh remains owned by the official helper.
          try {
            const value = JSON.parse(fs.readFileSync(path.join(this.#home, 'auth.json'), 'utf8'));
            if (value.OPENAI_API_KEY || (value.auth_mode && value.auth_mode !== 'chatgpt') || !['access_token', 'refresh_token', 'id_token'].every(key => typeof value.tokens?.[key] === 'string' && value.tokens[key])) return false;
            const expected = Buffer.from(`Bearer ${value.tokens.access_token}`), actual = Buffer.from(headers.authorization || '');
            return actual.length === expected.length && timingSafeEqual(actual, expected);
          } catch { return false; }
        }, onBlocked: () => { this.#emit({ method: 'draken/blocked', params: {} }); void this.close(); } });
      if (this.#closed || signal?.aborted) { await this.#deny.close(); throw new Error('Native voice setup cancelled.'); }
      const cwd = path.join(this.#home, 'empty-workspace'); fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      this.#rpc = new NativeRpc(this.#binary, helperArguments(this.#deny.url), { cwd, env: helperEnvironment(this.#home) });
      this.#unsubscribe = this.#rpc.subscribe(event => {
        if (event.method === 'turn/started' && !this.#answer) { this.#emit({ method: 'draken/blocked', params: {} }); void this.close(); return; }
        if (event.method === 'draken/closed') { this.#emit(event); void this.close(); return; }
        if (event.method.startsWith('thread/realtime/') && event.params?.threadId === this.#thread) {
          // SDP never enters the general event stream or a saved report.
          if (event.method !== 'thread/realtime/sdp') this.#emit(event);
        }
      });
      await this.#rpc.request('initialize', { clientInfo: { name: 'draken', title: 'Draken read-only voice', version: '0.1.6' }, capabilities: { experimentalApi: true } }, { signal });
      this.#rpc.notify('initialized');
      const account = await this.#rpc.request('account/read', { refreshToken: false }, { signal });
      if (account.account?.type !== 'chatgpt') throw new Error('Native ChatGPT authentication is required; API-key fallback is disabled.');
      if (account.workspaceRouting?.backendOrigin && account.workspaceRouting.backendOrigin !== 'https://chatgpt.com') throw new Error('This prototype has not qualified the selected workspace region. No audio was sent.');
      const result = await this.#rpc.request('thread/start', { ephemeral: true, cwd, environments: [], dynamicTools: [],
        baseInstructions: 'This is a read-only voice transport. Never execute commands, edit files, use tools, or start background work.',
        model: 'gpt-5.4', modelProvider: 'draken_readonly', approvalPolicy: 'on-request', sandbox: 'read-only' }, { signal });
      this.#thread = result.thread?.id;
      if (typeof this.#thread !== 'string' || !this.#thread || result.modelProvider !== 'draken_readonly') throw new Error('Native helper did not preserve the no-execution model boundary.');
      onReady?.();
      // Subscribe before issuing start: the SDP notification may precede its RPC response.
      const answer = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Native voice SDP timed out.')); }, 45_000);
        const off = this.#rpc.subscribe(event => {
          if (event.method === 'draken/closed') { cleanup(); reject(new Error('Native voice connection closed during setup.')); }
          if (event.params?.threadId !== this.#thread) return;
          if (event.method === 'thread/realtime/error' || event.method === 'thread/realtime/closed') { cleanup(); reject(new Error('Native voice access failed. No fallback provider was used.')); }
          if (event.method === 'thread/realtime/sdp') {
            cleanup(); const value = event.params.sdp;
            if (typeof value !== 'string' || value.length > 64_000 || !value.startsWith('v=0')) reject(new Error('Invalid native voice SDP answer.'));
            else resolve(value);
          }
        });
        const cleanup = () => { clearTimeout(timer); off(); };
      });
      const start = this.#rpc.request('thread/realtime/start', { threadId: this.#thread, outputModality: 'audio', version: 'v3',
        model: 'gpt-live-1-codex', voice: 'cove', includeStartupContext: false, clientManagedHandoffs: !this.#answer,
        flushTranscriptTailOnSessionEnd: false, delegationAckFiller: false,
        ...(initialItems ? { initialItems } : {}),
        prompt: prompt || 'You are Draken, an AI voice test. Answer briefly using only supplied facts. You cannot execute work or delegate tasks. The export tests passed; deployment has not been checked. Never claim deployment was verified.',
        transport: { type: 'webrtc', sdp } }, { signal, timeoutMs: 45_000 });
      const [remoteSdp] = await Promise.all([answer, start]);
      if (this.#closed || signal?.aborted) throw new Error('Native voice setup cancelled.');
      return remoteSdp;
    } catch (error) { await this.close(); throw error; }
  }
  async text(text) {
    if (!this.#thread || this.#closed || typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Cannot send this native voice question.');
    await this.#rpc.request('thread/realtime/appendText', { threadId: this.#thread, role: 'user', text });
  }
  async context(text) {
    if (!this.#thread || this.#closed || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 8192) throw new Error('Cannot supply this native voice context.');
    // In v3 this becomes session context, without the user-text prefix.
    await this.#rpc.request('thread/realtime/appendText', { threadId: this.#thread, role: 'developer', text });
  }
  async continueAnswer(question) {
    if (!this.#thread || this.#closed || typeof question !== 'string' || !question.trim() || question.length > 2000) throw new Error('Cannot continue this native voice answer.');
    // Official V3 speakable-context operation, not a fabricated user message.
    // Ordinary developer context is only background data and may not resume speech.
    const text = `DRAKEN_LOOKUP_READY — application control, not words to read aloud or a new user utterance. The read-only lookup is complete for this pending question: ${JSON.stringify([...question].slice(0, 500).join(''))} (bounded reminder; the original question is already in this call). Finish answering it now from the supplied context, briefly, with its uncertainty. If lookup failed, explain that instead. Do not merely acknowledge or promise to check; do not repeat an answer already completed. Do not answer an older question if the user has since interrupted or moved on.`;
    await this.#rpc.request('thread/realtime/appendSpeech', { threadId: this.#thread, text });
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = Promise.resolve().then(() => this.#closeResources());
    return this.#closing;
  }
  async #closeResources() {
    this.#cleanup?.(); this.#unsubscribe?.();
    if (this.#thread && this.#rpc && !this.#rpc.closed) {
      try { await this.#rpc.request('thread/realtime/stop', { threadId: this.#thread }, { timeoutMs: 1500 }); } catch { /* Terminate below, even if stop was rejected. */ }
    }
    this.#rpc?.close();
    const exited = !this.#rpc || await this.#rpc.waitForExit();
    await this.#deny?.close();
    this.#emit({ method: 'draken/closed', params: { reason: exited ? 'Native voice connection closed.' : 'Native helper exit could not be confirmed.', helperExited: exited } });
    this.#listeners.clear();
    return { helperExited: exited };
  }
}
