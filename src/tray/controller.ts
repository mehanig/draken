import type { ServerTarget } from '../server-status';

export type TrayAction = 'open' | 'start' | 'stop' | 'quit';
export type TrayPhase = 'running' | 'stopped' | 'starting' | 'stopping' | 'error';
export interface TrayView {
  phase: TrayPhase; title: string; detail: string;
  canOpen: boolean; canStart: boolean; canStop: boolean; owned: boolean;
}
export interface OwnedServer {
  ready: Promise<ServerTarget>;
  exited: Promise<void>;
  stop(): Promise<boolean>;
}
export interface TrayOps {
  target(): ServerTarget;
  configured(): ServerTarget;
  probe(target: ServerTarget): Promise<{ instance?: string }>;
  launch(): OwnedServer;
  open(url: string): Promise<void>;
  changed(view: TrayView): void;
}

/** Only this in-memory child handle confers ownership. Saved PIDs never do. */
export class TrayController {
  private child?: OwnedServer;
  private target?: ServerTarget;
  private previousOwned?: ServerTarget;
  private foreign = false;
  private failure = '';
  private busy = false;
  private closing = false;
  private polling?: Promise<void>;
  private epoch = 0;
  private operation?: Promise<void>;
  view: TrayView = { phase: 'stopped', title: 'Draken — Checking', detail: '', canOpen: false, canStart: false, canStop: false, owned: false };
  constructor(private ops: TrayOps) {}
  private set(phase: TrayPhase, detail = '', flags: Partial<TrayView> = {}) {
    this.view = { phase, title: `Draken — ${phase[0].toUpperCase() + phase.slice(1)}`, detail,
      canOpen: phase === 'running', canStart: false, canStop: Boolean(this.child) && !this.busy,
      owned: Boolean(this.child), ...flags };
    this.ops.changed(this.view);
  }
  async initialize() {
    await this.poll();
    // A fresh install may launch immediately. A saved but stopped instance
    // requires an explicit Start click, using this invocation's environment.
    if (this.view.canStart && !this.ops.target().instance) await this.act('start');
  }
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.check().finally(() => { this.polling = undefined; });
    return this.polling;
  }
  private async check() {
    if (this.busy || this.closing) return;
    const epoch = this.epoch;
    let target: ServerTarget;
    try { target = this.child && this.target ? this.target : this.ops.target(); }
    catch { this.set('error', 'Cannot read the saved server address. Check draken status.'); return; }
    let live = false;
    try { await this.ops.probe(target); live = true; } catch { /* Stopped, stale or unavailable; never infer readiness. */ }
    if (this.busy || this.closing || epoch !== this.epoch) return;
    this.target = target;
    if (live) {
      if (!this.child) this.foreign = true;
      this.set('running', this.child ? 'Managed by this tray' : 'Existing server — managed elsewhere');
    } else if (this.child) this.set('error', 'Owned server is not responding. Stop it before starting another.');
    else {
      let compatible = false;
      try {
        const configured = this.ops.configured();
        compatible = configured.url === target.url && configured.open === target.open
          || Boolean(this.previousOwned?.instance && this.previousOwned.instance === target.instance && this.previousOwned.url === target.url && this.previousOwned.open === target.open);
      } catch { /* Invalid launch configuration. */ }
      this.set(this.failure ? 'error' : 'stopped', this.failure || (this.foreign ? 'Existing server stopped. Restart it with its original launcher.'
        : compatible ? 'Start uses the environment supplied to draken tray.' : 'Saved server has different settings. Use its original launch configuration.'),
      { canStart: compatible && !this.foreign });
    }
  }
  act(action: Exclude<TrayAction, 'quit'>): Promise<void> {
    if (this.closing || this.operation) return Promise.resolve();
    this.operation = this.perform(action).finally(() => { this.operation = undefined; });
    return this.operation;
  }
  private async perform(action: Exclude<TrayAction, 'quit'>) {
    if (action === 'open') {
      if (!this.view.canOpen || !this.target) return;
      try { await this.ops.probe(this.target); if (!this.closing) await this.ops.open(this.target.open); }
      catch { if (!this.closing) this.set('error', 'Could not open Draken. Check the server or default browser.'); }
      return;
    }
    if (action === 'start') {
      if (!this.view.canStart) return;
      await this.poll(); // Another launcher may have started while the menu was open.
      if (!this.view.canStart || this.closing) return;
      this.failure = ''; this.busy = true; ++this.epoch; this.set('starting');
      let child: OwnedServer | undefined;
      try {
        child = this.ops.launch(); this.child = child;
        void child.exited.then(() => {
          if (this.child !== child) return;
          this.child = undefined; ++this.epoch;
          if (!this.busy && !this.closing) { this.failure = 'Draken exited. Use Start to retry.'; this.set('error', this.failure, { canStart: true }); }
        });
        this.target = await child.ready;
        this.previousOwned = this.target;
        if (this.child !== child) throw new Error('Server exited during startup');
        await this.ops.probe(this.target);
        if (!this.closing) this.set('running', 'Managed by this tray');
      } catch {
        if (child && this.child === child && await child.stop()) this.child = undefined;
        this.failure = this.child ? 'Startup failed; shutdown was not confirmed. No replacement will start.' : 'Draken could not start. Check its configuration and server log.';
        if (!this.closing) this.set('error', this.failure, { canStart: !this.child });
      } finally { this.busy = false; if (!this.closing) this.set(this.view.phase, this.view.detail, { canStart: this.view.canStart }); }
    } else if (action === 'stop' && this.child && this.view.canStop) {
      this.busy = true; ++this.epoch; this.set('stopping');
      const child = this.child, stopped = await child.stop();
      if (stopped && this.child === child) this.child = undefined;
      this.busy = false;
      if (stopped) this.failure = '';
      this.set(stopped ? 'stopped' : 'error', stopped ? 'Stopped by this tray' : 'Shutdown was not confirmed. No replacement will start.', { canStart: stopped });
    }
  }
  async close(): Promise<boolean> {
    this.closing = true; ++this.epoch;
    await this.operation;
    if (this.child) {
      this.busy = true; this.set('stopping', 'Stopping Draken before quitting…');
      if (!await this.child.stop()) {
        this.busy = false; this.closing = false;
        this.set('error', 'Could not confirm shutdown. Retry Stop before quitting.'); return false;
      }
      this.child = undefined;
    }
    return true;
  }
}
