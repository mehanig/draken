import { getDb } from '../db/schema';
import { getDataDir } from '../data-dir';
import { sourceStamps, loadSourceCheckpoint } from '../memory/stamps';
import { scanSessions } from './collector';
import { availableCount } from './store';
import { activity } from './activity';
import { HttpError } from '../errors';
import { historyProgress, prepareHistory } from '../memory/service';
import type { AutoIndexSettings } from '../types';

const CHECK_MS = 60_000, RETRY_MS = 5 * 60_000, BATCH = 64;
type State = Pick<AutoIndexSettings, 'phase' | 'pending_records' | 'last_completed_at' | 'error'>;
interface Operations {
  enabled(): boolean; idle(): boolean; now(): number;
  scan(signal: AbortSignal): Promise<{ warnings: string[] }>;
  stamp(before: string): Map<string, string>;
  baseline(): Map<string, string> | undefined;
  prepare(before: string, signal: AbortSignal): Promise<void>;
  completed(at: string): void;
}
const initial = (): State => ({ phase: 'off', pending_records: 0, last_completed_at: null, error: '' });

/** Automatic work only discovers and indexes history. Snapshot creation and
 * provider summarization require a user action, regardless of backlog size. */
class AutoIndexer {
  state = initial();
  private retryAt = 0;
  private life?: AbortController;
  private job?: Promise<void>;
  constructor(private ops: Operations) {}
  async tick(): Promise<void> {
    if (this.job) return this.job;
    if (!this.ops.enabled()) { this.state.phase = 'off'; return; }
    if (!this.ops.idle()) { this.state.phase = 'paused'; return; }
    if (this.ops.now() < this.retryAt) return;
    const life = new AbortController(); this.life = life;
    this.job = this.run(life.signal).finally(() => { this.life = undefined; this.job = undefined; });
    return this.job;
  }
  pause() {
    this.retryAt = Math.max(this.retryAt, this.ops.now() + CHECK_MS);
    this.life?.abort(); this.state.phase = this.life ? 'stopping' : this.ops.enabled() ? 'paused' : 'off';
  }
  async stop() { this.pause(); await this.job; }
  retry() { this.retryAt = 0; this.state.error = ''; if (!this.job) this.state.phase = this.ops.enabled() ? 'waiting' : 'off'; }
  private async run(signal: AbortSignal) {
    try {
      this.state.phase = 'scanning'; this.state.error = '';
      const scanned = await this.ops.scan(signal);
      if (signal.aborted || !this.ops.enabled()) return;
      if (scanned.warnings.length) throw new Error('Scan incomplete');
      const before = new Date(this.ops.now()).toISOString();
      const baseline = this.ops.baseline();
      const current = this.ops.stamp(before);
      let changed = 0;
      for (const [key, value] of current) if (baseline?.get(key) !== value) changed++;
      if (baseline) for (const key of baseline.keys()) if (!current.has(key)) changed++;
      this.state.pending_records = changed;
      if (changed < BATCH) { this.state.phase = 'waiting'; return; }
      if (!this.ops.idle()) { this.state.phase = 'paused'; return; }
      this.state.phase = 'indexing';
      await this.ops.prepare(before, signal);
      if (signal.aborted || !this.ops.enabled()) return;
      const completed = new Date(this.ops.now()).toISOString();
      this.ops.completed(completed);
      this.state = { phase: 'waiting', pending_records: 0, last_completed_at: completed, error: '' };
    } catch (error) {
      if (!signal.aborted && error instanceof HttpError && error.status === 409) {
        this.state.phase = 'paused'; this.retryAt = this.ops.now() + CHECK_MS;
      } else if (!signal.aborted) {
        this.state.phase = 'error';
        this.state.error = 'Automatic indexing could not finish. Check session sources and local model availability. Completed work is retained; indexing retries in five minutes.';
        this.retryAt = this.ops.now() + RETRY_MS;
      }
    } finally {
      if (signal.aborted || !this.ops.enabled()) this.state.phase = this.ops.enabled() ? 'paused' : 'off';
    }
  }
}

export function createAutoIndexer(ops: Operations) { return new AutoIndexer(ops); }

const enabled = () => (getDb().prepare("SELECT value FROM sync_settings WHERE key='auto_index'").get() as { value: string } | undefined)?.value === 'true';
let worker: AutoIndexer | undefined, timer: NodeJS.Timeout | undefined;
export function startBackgroundIndexing() {
  if (timer) return;
  worker = createAutoIndexer({ enabled, idle: () => !activity.busy && !activity.callActive && !historyProgress().active && !historyProgress().queued,
    now: Date.now, scan: scanSessions, stamp: before => sourceStamps(getDb(), before), baseline: () => loadSourceCheckpoint(getDataDir()), prepare: (before, signal) => prepareHistory(before, signal, true),
    completed: at => { getDb().prepare("INSERT INTO sync_settings(key,value) VALUES ('auto_last_completed',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(at); } });
  timer = setInterval(() => { void worker?.tick().catch(() => {
    if (worker) { worker.state.phase = 'error'; worker.state.error = 'Background indexing is unavailable. Check server storage and settings.'; }
  }); }, CHECK_MS); timer.unref();
}
export async function stopBackgroundIndexing() {
  clearInterval(timer); timer = undefined;
  const prior = worker; worker = undefined; await prior?.stop();
}
export async function yieldBackgroundIndexing() { await worker?.stop(); }
export function autoIndexSettings(): AutoIndexSettings {
  const on = enabled();
  const last = getDb().prepare("SELECT value FROM sync_settings WHERE key='auto_last_completed'").get() as { value: string } | undefined;
  return { enabled: on, check_seconds: CHECK_MS / 1000, batch_records: BATCH, pending_entries: availableCount(),
    ...(worker?.state || initial()), last_completed_at: worker?.state.last_completed_at || last?.value || null, ...(!on && worker?.state.phase !== 'stopping' ? { phase: 'off' as const }
      : on && (!worker || worker.state.phase === 'off') ? { phase: 'waiting' as const } : {}) };
}
export function setAutoIndex(value: unknown): AutoIndexSettings {
  if (typeof value !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
  getDb().prepare("INSERT INTO sync_settings(key,value) VALUES ('auto_index',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(value));
  startBackgroundIndexing();
  if (!value) worker!.pause(); else worker!.retry();
  return autoIndexSettings();
}
