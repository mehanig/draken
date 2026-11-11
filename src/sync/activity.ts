import { HttpError } from '../errors';

/** Process-local ownership, separate from durable run status. Cancellation only
 * requests a stop: the owner keeps its lease until its resources are released. */
class SyncActivity {
  private jobs = new Map<number, { controller: AbortController }>();
  private automatic = new Map<number, symbol>();
  private call?: { id: number; token: symbol };
  private start?: symbol;
  private stopping = false;
  private drained?: Promise<void>;
  private finishDrain?: () => void;

  private admit() { if (this.stopping) throw new HttpError(503, 'Draken is stopping. No new work can start.'); }
  private changed() { if (!this.jobs.size && !this.automatic.size && !this.call && !this.start) this.finishDrain?.(); }
  shutdown(): Promise<void> {
    this.stopping = true;
    const done = this.drained ||= new Promise<void>(resolve => { this.finishDrain = resolve; });
    for (const { controller } of this.jobs.values()) controller.abort();
    this.changed(); return done;
  }

  get busyIds(): number[] { return [...this.jobs.keys()]; }
  get busy(): boolean { return Boolean(this.start || this.jobs.size); }
  get starting(): boolean { return this.start !== undefined; }
  get callActive(): boolean { return this.call !== undefined; }
  get backgroundId(): number | undefined { return this.automatic.keys().next().value; }
  get foregroundBusy(): boolean { return Boolean(this.start) || this.busyIds.some(id => !this.automatic.has(id)); }
  jobActive(id: number): boolean { return this.jobs.has(id); }
  voiceActive(id: number): boolean { return this.call?.id === id; }

  beginJob(id: number, controller: AbortController): () => void {
    this.admit();
    if (this.jobs.has(id)) throw new HttpError(409, 'A reply is still being generated. Wait or cancel before changing this sync.');
    if (this.voiceActive(id)) throw new HttpError(409, 'End the voice call before changing this sync.');
    const owner = { controller };
    this.jobs.set(id, owner);
    return () => { if (this.jobs.get(id) === owner) { this.jobs.delete(id); this.changed(); } };
  }
  cancelJob(id: number): boolean {
    const owner = this.jobs.get(id);
    if (!owner) return false;
    owner.controller.abort(); return true;
  }
  beginStart(): () => void {
    this.admit();
    if (this.start) throw new HttpError(409, 'A sync is already being prepared');
    if (this.busy || this.callActive) throw new HttpError(409, 'End the active call or wait for preparation before starting another sync.');
    const token = Symbol(); this.start = token;
    return () => { if (this.start === token) { this.start = undefined; this.changed(); } };
  }
  beginBackground(id: number): () => void {
    this.admit();
    if (this.automatic.has(id)) throw new HttpError(409, 'Automatic preparation is already running');
    const token = Symbol(); this.automatic.set(id, token);
    return () => { if (this.automatic.get(id) === token) { this.automatic.delete(id); this.changed(); } };
  }
  beginCall(id: number): () => void {
    this.admit();
    if (this.call) throw new HttpError(409, 'End the existing call first.');
    if (this.jobs.has(id)) throw new HttpError(409, 'A reply is still being generated. Wait or cancel before changing this sync.');
    const token = Symbol(); this.call = { id, token };
    return () => { if (this.call?.token === token) { this.call = undefined; this.changed(); } };
  }
}

export const activity = new SyncActivity();
