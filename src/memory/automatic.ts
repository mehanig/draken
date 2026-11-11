import { getDataDir, getDb } from '../db/schema';
import { sourceStamps, loadSourceCheckpoint } from './stamps';
import { scanSessions } from '../sync/collector';
import { activeVoiceSyncs, automaticSyncId, availableCount, backgroundSyncs, busySyncs } from '../sync/store';
import { HttpError } from '../errors';
import { automaticBriefingError, pendingAutomaticBriefing, prepareAutomaticBriefing, retryAutomaticBriefing } from '../sync/automatic';
import { historyProgress, historyReadiness, prepareHistory } from './service';
import type { AutoIndexSettings } from '../types';

const CHECK_MS = 60_000, RETRY_MS = 5 * 60_000, BATCH = 64;
type State = Pick<AutoIndexSettings, 'phase' | 'pending_records' | 'last_completed_at' | 'error'>;
interface Operations {
  enabled(): boolean; idle(): boolean; now(): number;
  scan(signal: AbortSignal): Promise<{ warnings: string[] }>;
  stamp(before: string): Map<string, string>;
  baseline?(): Map<string, string> | undefined;
  prepare(before: string, signal: AbortSignal): Promise<void>;
  waiting?(): number;
  unfinished?(): boolean;
  briefing?(signal: AbortSignal): Promise<void>;
  problem?(): string;
  completed?(at: string): void;
}
const initial = (): State => ({ phase: 'off', pending_records: 0, last_completed_at: null, error: '' });

/** One enabled pipeline: source discovery, local search and a ready briefing.
 * Full batches start at 64 changes or waiting entries; interrupted work resumes.
 * Smaller new tails wait for foreground preparation, with no timed flush.
 * Provider failures require explicit retry; cancellation retains cached work. */
class AutoIndexer {
  state = initial();
  private baseline?: Map<string, string>;
  private retryAt = 0;
  private life?: AbortController;
  private job?: Promise<void>;
  constructor(private ops: Operations) {}
  async tick(): Promise<void> {
    if (this.job) return this.job;
    if (!this.ops.enabled()) { this.state.phase = 'off'; return Promise.resolve(); }
    if (!this.ops.idle()) { this.state.phase = 'paused'; return Promise.resolve(); }
    const problem = this.ops.problem?.();
    if (problem) { this.state.phase = 'error'; this.state.error = problem; return; }
    if (this.ops.now() < this.retryAt) return Promise.resolve();
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
      const baseline = this.ops.baseline ? this.ops.baseline() : this.baseline;
      if (this.ops.baseline && !baseline && !this.ops.briefing) {
        this.state.phase = 'waiting'; this.state.pending_records = 0;
        this.state.error = 'Prepare history once with a foreground call or unfiltered history search to establish the background checkpoint for this older index.';
        return;
      }
      const current = this.ops.stamp(before);
      let changed = 0;
      for (const [key, value] of current) if (baseline?.get(key) !== value) changed++;
      if (baseline) for (const key of baseline.keys()) if (!current.has(key)) changed++;
      const waiting = this.ops.waiting?.() || 0, unfinished = this.ops.unfinished?.() || false;
      this.state.pending_records = Math.max(changed, waiting);
      if (changed < BATCH && waiting < BATCH && !unfinished) { this.state.phase = 'waiting'; return; }
      if (!this.ops.idle()) { this.state.phase = 'paused'; return; }
      if (changed >= BATCH || !baseline) {
        this.state.phase = 'indexing';
        await this.ops.prepare(before, signal);
        this.baseline = current;
      }
      if (signal.aborted || !this.ops.enabled()) return;
      if (this.ops.briefing && (waiting > 0 || unfinished)) {
        if (!this.ops.idle()) throw new HttpError(409, 'Foreground work has priority');
        this.state.phase = 'briefing';
        await this.ops.briefing(signal);
      }
      if (signal.aborted || !this.ops.enabled()) return;
      const completed = new Date(this.ops.now()).toISOString();
      this.ops.completed?.(completed);
      this.state = { phase: 'waiting', pending_records: 0, last_completed_at: completed, error: '' };
    } catch (error) {
      const problem = this.ops.problem?.();
      if (!signal.aborted && problem) {
        this.state.phase = 'error'; this.state.error = problem;
      } else if (!signal.aborted && error instanceof HttpError && error.status === 409) {
        this.state.phase = 'paused'; this.retryAt = this.ops.now() + CHECK_MS;
      } else if (!signal.aborted) {
        this.state.phase = 'error';
        this.state.error = 'Automatic preparation could not finish. Check session sources and model availability. Completed work is retained; local preparation retries in five minutes.';
        this.retryAt = this.ops.now() + RETRY_MS;
      }
    } finally {
      if (signal.aborted || !this.ops.enabled()) this.state.phase = this.ops.enabled() ? 'paused' : 'off';
    }
  }
}

export function createAutoIndexer(ops: Operations) { return new AutoIndexer(ops); }

// Old local-index-only consent must not silently become paid model consent on
// another installation. Fresh databases seed this combined scope at creation;
// existing databases and explicit choices are never defaulted by this getter.
const enabled = () => (getDb().prepare("SELECT value FROM sync_settings WHERE key='auto_prepare_conversations'").get() as { value: string } | undefined)?.value === 'true';
let worker: AutoIndexer | undefined, timer: NodeJS.Timeout | undefined;
export function startBackgroundIndexing() {
  if (timer) return;
  worker = createAutoIndexer({ enabled, idle: () => !busySyncs.size && !activeVoiceSyncs.size && !historyProgress().active && !historyProgress().queued,
    now: Date.now, scan: scanSessions, stamp: before => sourceStamps(getDb(), before), baseline: () => loadSourceCheckpoint(getDataDir()), prepare: (before, signal) => prepareHistory(before, signal, true),
    waiting: availableCount, unfinished: () => pendingAutomaticBriefing() !== undefined, briefing: prepareAutomaticBriefing, problem: automaticBriefingError,
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
  const on = enabled(), syncId = [...backgroundSyncs][0] ?? pendingAutomaticBriefing() ?? null;
  const progress = syncId === null ? null : getDb().prepare('SELECT stage,processed_entries AS completed,total_entries AS total,invocations,max_invocations FROM sync_runs WHERE sync_id=? ORDER BY id DESC LIMIT 1').get(syncId) as AutoIndexSettings['progress'];
  const prepared = automaticSyncId(true), problem = on ? automaticBriefingError() : '';
  const last = getDb().prepare("SELECT value FROM sync_settings WHERE key='auto_last_completed'").get() as { value: string } | undefined;
  return { enabled: on, check_seconds: CHECK_MS / 1000, batch_records: BATCH,
    pending_entries: availableCount(), sync_id: syncId, ready_sync_id: prepared !== undefined && historyReadiness(true).ready ? prepared : null, progress: progress || null,
    ...(worker?.state || initial()), last_completed_at: worker?.state.last_completed_at || last?.value || null, ...(!on && worker?.state.phase !== 'stopping' ? { phase: 'off' as const }
      : on && (!worker || worker.state.phase === 'off') ? { phase: 'waiting' as const } : {}),
    ...(problem ? { phase: 'error' as const, error: problem } : {}) };
}
export function setAutoIndex(value: unknown): AutoIndexSettings {
  if (typeof value !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
  getDb().transaction(() => {
    const save = getDb().prepare('INSERT INTO sync_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const key of ['auto_index', 'auto_prepare_conversations']) save.run(key, String(value));
  })();
  startBackgroundIndexing();
  if (!value) worker!.pause();
  else { retryAutomaticBriefing(); worker!.retry(); }
  // The periodic server timer owns work; neither GET nor rendering starts a job.
  return autoIndexSettings();
}
