import { HttpError } from '../errors';

/** Callable release remains compatible with existing call owners. All child
 * leases close over this reservation, never a sync ID that can be reused. */
export interface VoiceLease {
  (): void;
  connected(): void;
  hold(): () => void;
  beginTurn(): () => void;
}

/** Process-local ownership, separate from durable run status. Cancellation only
 * requests a stop: the owner keeps its lease until its resources are released. */
class SyncActivity {
  private jobs = new Map<number, { controller: AbortController }>();
  private call?: { id: number; token: symbol; connected: boolean; holds: Set<symbol>; turns: Set<symbol> };
  private start?: symbol;
  private stopping = false;
  private drained?: Promise<void>;
  private finishDrain?: () => void;

  private admit() { if (this.stopping) throw new HttpError(503, 'Draken is stopping. No new work can start.'); }
  private changed() { if (!this.jobs.size && !this.call && !this.start) this.finishDrain?.(); }
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
  get backgroundIdle(): boolean { return !this.stopping && !this.busy && (!this.call || (this.call.connected && !this.call.holds.size && !this.call.turns.size)); }
  voiceTurnActive(id: number): boolean { return this.call?.id === id && this.call.turns.size > 0; }
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
  beginCall(id: number): VoiceLease {
    this.admit();
    if (this.call) throw new HttpError(409, 'End the existing call first.');
    if (this.jobs.has(id)) throw new HttpError(409, 'A reply is still being generated. Wait or cancel before changing this sync.');
    const token = Symbol();
    const owner = { id, token, connected: false, holds: new Set<symbol>(), turns: new Set<symbol>() };
    this.call = owner;
    const lease = (leases: Set<symbol>) => {
      if (this.call !== owner) return () => {};
      const child = Symbol(); leases.add(child);
      return () => { leases.delete(child); };
    };
    return Object.assign(() => { if (this.call === owner) { this.call = undefined; this.changed(); } }, {
      connected: () => { if (this.call === owner) owner.connected = true; },
      hold: () => lease(owner.holds),
      beginTurn: () => lease(owner.turns),
    });
  }
}

export const activity = new SyncActivity();
