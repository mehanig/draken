import { spawn } from 'node:child_process';

/** Own a native-workflow command directly (Windows) or its private launcher
 * group (Unix). Launcher stdio closure cannot prove descendants have stopped. */
export class NativeHelperProcess {
  #closing = false;
  #launcherClosed = false;
  #exited = false;
  #killTimer;
  constructor(binary, args, { cwd, env, spawnProcess = spawn, stdio = ['pipe', 'pipe', 'pipe'] } = {}) {
    this.child = spawnProcess(binary, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio });
    // Piped diagnostics can contain credentials/transcripts; never log them.
    // Explicit terminal setup/login commands instead inherit the operator's IO.
    this.child.stderr?.resume();
    this.child.on('error', () => this.close());
    this.child.on('close', () => {
      this.#launcherClosed = true;
      if (!this.#confirmExit()) this.close();
    });
  }
  #confirmExit() {
    if (this.#exited) return true;
    if (!this.#launcherClosed) return false;
    if (process.platform !== 'win32' && Number.isInteger(this.child.pid) && this.child.pid > 1) {
      try { process.kill(-this.child.pid, 0); return false; }
      catch (error) { if (error.code !== 'ESRCH') return false; }
    }
    this.#exited = true; clearTimeout(this.#killTimer);
    return true;
  }
  async waitForExit(timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (!this.#confirmExit()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
    }
    return true;
  }
  #terminate(signal) {
    if (process.platform !== 'win32' && Number.isInteger(this.child.pid) && this.child.pid > 1) {
      try { process.kill(-this.child.pid, signal); return; } catch { /* Confirmation remains separate. */ }
    }
    try { this.child.kill(signal); } catch { /* An unsuccessful signal is not proof of exit. */ }
  }
  close() {
    if (this.#closing) return;
    this.#closing = true; this.child.stdin?.destroy();
    if (this.#confirmExit()) return;
    this.#terminate('SIGTERM');
    this.#killTimer = setTimeout(() => { if (!this.#confirmExit()) this.#terminate('SIGKILL'); }, 1500);
    this.#killTimer.unref();
  }
}
