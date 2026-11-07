import { spawn } from 'node:child_process';

/** Private stdio only. No HTTP listener, shell, generic command route, or raw logging. */
export class NativeRpc {
  #child;
  #pending = new Map();
  #listeners = new Set();
  #sequence = 0;
  #buffer = '';
  #closed = false;
  #exited = false;
  #killTimer;
  #exitPromise;
  #resolveExit;
  constructor(binary, args, { cwd, env, spawnProcess = spawn } = {}) {
    this.#exitPromise = new Promise(resolve => { this.#resolveExit = resolve; });
    this.#child = spawnProcess(binary, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', chunk => this.#receive(chunk));
    // Native diagnostics can contain prompts, transcripts, paths and auth details.
    // Drain them, but never copy them into routine logs or browser errors.
    this.#child.stderr.resume();
    this.#child.stdin.on('error', () => this.close('Native voice input closed.'));
    this.#child.on('error', () => this.close('Cannot start the pinned native voice helper.'));
    this.#child.on('close', () => {
      this.#exited = true;
      clearTimeout(this.#killTimer);
      this.#resolveExit(true);
      this.close('Native voice helper stopped.');
    });
  }
  get closed() { return this.#closed; }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #emit(event) {
    for (const listener of this.#listeners) {
      try { listener(event); } catch { this.close('Native voice event consumer failed.'); return; }
    }
  }
  #receive(chunk) {
    if (this.#closed) return;
    this.#buffer += chunk;
    if (this.#buffer.length > 1_000_000) return this.close('Native voice event exceeds its limit.');
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline); this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { return this.close('Malformed native voice event.'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return this.close('Malformed native voice event.');
      if (typeof event.method === 'string') {
        // A call must never become an execution/approval/elicitation client.
        // Do not accept even a nominally read-only command request.
        if (Object.hasOwn(event, 'id')) {
          try { this.#send({ id: event.id, error: { code: -32601, message: 'Draken voice does not execute tools or grant approvals.' } }); }
          catch { /* A closed input pipe cannot grant an operation. */ }
          finally { this.close('Native voice requested an unsupported operation.'); }
          return;
        }
        this.#emit(event);
        if (this.#closed) return;
      } else if (Object.hasOwn(event, 'id')) {
        const pending = this.#pending.get(event.id);
        if (!pending) continue; // A timed-out response must not settle a later request.
        this.#pending.delete(event.id); pending.cleanup();
        if (Object.hasOwn(event, 'error')) pending.reject(new Error('Native voice request was rejected. Check account access and helper compatibility.'));
        else if (Object.hasOwn(event, 'result')) pending.resolve(event.result);
        else { pending.reject(new Error('Malformed native voice response.')); this.close(); }
      } else return this.close('Malformed native voice event.');
    }
  }
  #send(value) {
    if (this.#closed || this.#child.stdin.destroyed) throw new Error('Native voice connection is closed.');
    const line = JSON.stringify(value) + '\n';
    if (line.length > 200_000 || this.#child.stdin.writableLength > 1_000_000) throw new Error('Native voice input exceeds its limit.');
    this.#child.stdin.write(line);
  }
  notify(method, params = {}) { this.#send({ method, params }); }
  request(method, params = {}, { timeoutMs = 15_000, signal } = {}) {
    if (this.#closed || signal?.aborted) return Promise.reject(new Error('Native voice request cancelled.'));
    if (this.#pending.size >= 16) return Promise.reject(new Error('Too many pending native voice requests.'));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const abort = () => this.close('Native voice request cancelled.');
      const timer = setTimeout(() => this.close('Native voice request timed out.'), Math.max(1, Math.min(timeoutMs, 60_000)));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.#pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.#send({ id, method, params }); } catch { this.close('Cannot send native voice request.'); }
      if (signal?.aborted) abort();
    });
  }
  async waitForExit(timeoutMs = 2500) {
    let timer;
    try { return await Promise.race([this.#exitPromise, new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  #terminate(signal) {
    // The official npm launcher owns a native child. On Unix terminate the
    // entire group, including escalation if a launcher exits before its child.
    if (process.platform !== 'win32' && Number.isInteger(this.#child.pid) && this.#child.pid > 1) {
      try { process.kill(-this.#child.pid, signal); return; } catch { /* Already gone, or test double. */ }
    }
    try { this.#child.kill(signal); } catch { /* Exit confirmation is separate. */ }
  }
  close(reason = 'Native voice connection closed.') {
    if (this.#closed) return;
    this.#closed = true; this.#buffer = '';
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(new Error(reason)); }
    this.#pending.clear();
    this.#child.stdin.destroy();
    if (!this.#exited) {
      this.#terminate('SIGTERM');
      this.#killTimer = setTimeout(() => this.#terminate('SIGKILL'), 1500); this.#killTimer.unref();
    }
    this.#emit({ method: 'draken/closed', params: { reason } });
    this.#listeners.clear();
  }
}
