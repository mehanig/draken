import { getDb } from '../db/schema';
import { HttpError } from '../errors';
import type { SummaryPreparationSettings } from '../types';
import { activity } from './activity';
import { historyProgress } from '../memory/service';
import { assertEvidenceAvailable, previewSummaryInput } from './store';
import { SummaryTree, summaryPreparationKey } from './tree';
import { digest } from './normalize';
import { defaultModels } from './models';
import { learnSummaryWorkflows } from '../factory/learning';
import { pendingWorkflows } from '../factory/learning-store';
import { prepareCachedProcesses } from '../factory/prepare';

const FAILURE = 'Background summaries could not finish. Check provider settings, invocation limits and original session files, then explicitly retry automatic preparation in Settings. Cached work is retained.';
const setting = (key: string) => (getDb().prepare('SELECT value FROM sync_settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
function save(key: string, value: string) {
  getDb().prepare('INSERT INTO sync_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
const summaryPreparationEnabled = () => (setting('auto_summary') ?? 'true') === 'true';
const indexingEnabled = () => setting('auto_index') === 'true';
const idle = () => activity.backgroundIdle && !historyProgress().active && !historyProgress().queued;
interface Receipt { cache_receipt_json: string; total_entries: number; completed_at: string | null }
interface Run { id: number; invocations: number; max_invocations: number }
let consentRevision = 0;
let active: { controller: AbortController; done: Promise<void>; working: boolean } | undefined;

/** Cancellation is irrevocable for this job even if consent is immediately re-enabled. */
export function cancelSummaryPreparation(): Promise<void> {
  const prior = active;
  prior?.controller.abort();
  // Return the owned promise, not a detached rejecting wrapper. The scheduler
  // retains its rejection handler even when a synchronous setter only aborts.
  return prior?.done || Promise.resolve();
}

/** Called by the scheduler's lifecycle owner; reads never start the scheduler. */
export function configureAutoSummary(value: unknown): void {
  if (typeof value !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
  if (value && !indexingEnabled()) throw new HttpError(409, 'Enable automatic indexing before enabling paid background summaries.');
  consentRevision++;
  active?.controller.abort();
  getDb().transaction(() => {
    save('auto_summary', String(value));
    if (value) save('auto_summary_error', '');
  })();
}

function matching(key: string): Receipt | undefined {
  return getDb().prepare("SELECT cache_receipt_json,total_entries,completed_at FROM background_runs WHERE status='completed' AND input_key=? ORDER BY id DESC LIMIT 1").get(key) as Receipt | undefined;
}

function cacheIntact(value: string | [string, string][]): boolean {
  let pairs: unknown;
  try { pairs = typeof value === 'string' ? JSON.parse(value) : value; } catch { return false; }
  if (!Array.isArray(pairs) || !pairs.length || pairs.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) return false;
  const lookup = getDb().prepare('SELECT output_json FROM summary_cache WHERE key=?');
  return pairs.every(([key, hash]) => {
    const row = lookup.get(key) as { output_json: string } | undefined;
    return row !== undefined && digest(row.output_json) === hash;
  });
}

/** Historical progress, not a live readiness claim. Polling must not reopen
 * transcript bodies; the preparing owner and explicit sync validate originals. */
export function summaryPreparationSettings(): SummaryPreparationSettings {
  const enabled = summaryPreparationEnabled(), error = setting('auto_summary_error') || '';
  const last = getDb().prepare("SELECT total_entries,completed_at FROM background_runs WHERE status='completed' ORDER BY id DESC LIMIT 1").get() as Pick<Receipt, 'total_entries' | 'completed_at'> | undefined;
  return { enabled, status: !enabled ? 'off' : error ? 'error' : !indexingEnabled() || !idle() || active?.controller.signal.aborted ? 'paused' : active?.working ? 'running' : 'waiting',
    prepared_entries: last?.total_entries || 0, last_completed_at: last?.completed_at || null, error };
}

/** Prepare only reusable summaries. No sync identity, snapshot, briefing or verdict.
 * A successful receipt suppresses repeated work; a failure blocks all automatic
 * paid retries until explicit consent/retry. Cancellation retains its allowance. */
export async function warmSummaryCache(signal: AbortSignal, onWork?: () => void, processLeaves?: readonly string[]): Promise<void> {
  if (processLeaves && (!processLeaves.length || processLeaves.length > 6 || new Set(processLeaves).size !== processLeaves.length || processLeaves.some(key => !/^[a-f0-9]{64}$/.test(key)))) throw Error('Select one to six distinct saved summary keys');
  if (signal.aborted || !summaryPreparationEnabled() || !indexingEnabled() || !idle() || setting('auto_summary_error')) return;
  if (active) return active.done;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const revision = consentRevision;
  const owner = { controller, done: Promise.resolve(), working: false };
  active = owner;
  owner.done = Promise.resolve().then(async () => {
    let run: Run | undefined;
    const admitted = () => !controller.signal.aborted && summaryPreparationEnabled() && indexingEnabled() && idle();
    const check = () => { if (!admitted()) { controller.abort(); throw new HttpError(409, 'Background preparation paused'); } };
    try {
      check();
      const db = getDb();
      // Startup recovery is responsible for interrupted ownership. A running row
      // with no process-local job can also mean failure metadata could not be
      // committed. Never silently replace that run with a fresh allowance.
      const orphan = db.prepare("SELECT id,invocations,max_invocations FROM background_runs WHERE status='running' LIMIT 1").get() as Run | undefined;
      if (orphan) { run = orphan; throw new Error('Background ownership was not recovered'); }
      const input = processLeaves ? { items: [], context: [], models: defaultModels() } : previewSummaryInput(); assertEvidenceAvailable(input);
      const key = summaryPreparationKey(input) + (processLeaves ? digest(JSON.stringify(processLeaves)) : input.items.length ? '' : digest(JSON.stringify(db.prepare("SELECT id FROM process_extractions WHERE kind='summary' AND status='completed' AND json_extract(source_dependencies_json,'$.format')='summary-workflows-v1' ORDER BY id").all())));
      const receipt = matching(key);
      const summariesReady = !!receipt && cacheIntact(receipt.cache_receipt_json);
      if ((summariesReady || (processLeaves && receipt)) && !pendingWorkflows()) return;
      if (!processLeaves && !input.items.length && !pendingWorkflows()) return;
      check();
      run = db.prepare(`SELECT id,invocations,max_invocations FROM background_runs WHERE input_key=?
        AND (status IN ('cancelled','interrupted') OR (?=1 AND status='completed')) ORDER BY id DESC LIMIT 1`).get(key, Number(summariesReady)) as Run | undefined;
      // Never resurrect an older interrupted allowance after an explicitly retried attempt.
      const latest = db.prepare('SELECT id FROM background_runs WHERE input_key=? ORDER BY id DESC LIMIT 1').get(key) as { id: number } | undefined;
      if (run && latest?.id !== run.id) run = undefined;
      if (run) {
        db.prepare("UPDATE background_runs SET status='running',stage='Planning',processed_entries=0,cache_hits=0,error='',completed_at=NULL WHERE id=?").run(run.id);
        input.models = { ...input.models, max_invocations: run.max_invocations };
      } else {
        const result = db.prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,input_key)
          VALUES (?,?,?,?,?,?)`).run(input.models.summary, input.models.final, input.models.max_invocations, input.items.length, new Date().toISOString(), key);
        run = { id: Number(result.lastInsertRowid), invocations: 0, max_invocations: input.models.max_invocations };
      }
      owner.working = true; onWork?.();
      const tree = SummaryTree.forBackground(input, run.id, controller.signal);
      // Recheck at the last boundary before *each* provider call, including repairs
      // and reconciliation after an await. Route-level yielding also drains this owner.
      const call = tree.call.bind(tree);
      tree.call = async (payload, system, final = false) => {
        check();
        if (final) throw new Error('Background preparation cannot request a verdict');
        return call(payload, system, false);
      };
      if (input.items.length) await tree.build();
      if (processLeaves) await prepareCachedProcesses(processLeaves, run.id, input.models.summary, (payload, system) => tree.call(payload, system), controller.signal);
      check();
      await learnSummaryWorkflows(run.id, input.models.summary, (payload, system) => tree.call(payload, system), controller.signal);
      check();
      // This receipt describes the captured input, not later arrivals. Verify its
      // originals and permissions without rebuilding the entire live snapshot.
      tree.verifyFinal();
      if (JSON.stringify(defaultModels()) !== JSON.stringify(input.models)) { controller.abort(); throw new Error('Models changed'); }
      const cacheReceipt = tree.cacheReceipt();
      if (input.items.length && !cacheIntact(cacheReceipt)) throw new Error('Summary cache changed before completion');
      db.prepare("UPDATE background_runs SET status='completed',stage='Cached',error='',completed_at=?,cache_receipt_json=? WHERE id=?")
        .run(new Date().toISOString(), JSON.stringify(cacheReceipt), run.id);
    } catch {
      const db = getDb();
      const counters = run && db.prepare('SELECT invocations,max_invocations FROM background_runs WHERE id=?').get(run.id) as Run | undefined;
      const cancelled = controller.signal.aborted;
      // Exhausted cancellations are also blocked: do not spin a quota 409 every minute.
      const exhausted = Boolean(counters && counters.invocations >= counters.max_invocations);
      const status = cancelled && !exhausted ? 'cancelled' : 'failed', at = new Date().toISOString();
      db.transaction(() => {
        if (run) db.prepare(`UPDATE background_runs SET status=?,error=?,completed_at=?,
          failure_events_json=json_insert(failure_events_json,'$[#]',json(?)) WHERE id=?`)
          .run(status, cancelled && !exhausted ? '' : FAILURE, at, JSON.stringify({ status, at }), run.id);
        if (revision === consentRevision && (!cancelled || exhausted)) save('auto_summary_error', FAILURE);
      })();
    }
  }).finally(() => {
    signal.removeEventListener('abort', abort);
    if (active === owner) active = undefined;
  });
  return owner.done;
}
