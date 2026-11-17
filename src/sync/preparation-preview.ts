import type Database from 'better-sqlite3';
import { getDb } from '../db/schema';
import type { PreparationPreview } from '../types';
import { activity } from './activity';
import { historyProgress, stopHistory } from '../memory/service';
import { yieldIndexingForPreview } from './background';
import { defaultModels } from './models';
import { getSourceRoots } from '../sources/registry';
import { withPreviewClone } from './preview-clone';
import { importPreviewMetadata } from './preview-metadata';

// Physical originals outside indexed metadata have a bounded proof lifetime.
const MAX_AGE = 5 * 60_000;
const FAILURE = 'Local verification could not finish. Check session sources and cached summaries, then retry. No model calls were made.';
const unknown = (phase: PreparationPreview['phase'], checked_at: string | null = null, error = ''): PreparationPreview =>
  ({ phase, needs_processing: null, cached: null, total: null, checked_at, error });
let state = unknown('stale');
let database: Database.Database | undefined;
let active: { controller: AbortController; done: Promise<void> } | undefined;
let checked: { stamp: string; expires: number } | undefined;

/** Connection-local metadata revisions: status polls are O(1), never scan source
 * bodies or rebuild plans. No durable schema/accounting/consent writes. Ignore
 * scan offsets/timestamps and unchanged UPDATEs, but watch effective pointers,
 * admission, reservations, and every summary artifact. External writers are
 * conservatively detected with SQLite data_version as well. */
function observe(db: Database.Database) {
  if (database === db) return;
  database = db; checked = undefined; state = unknown('stale');
  db.exec('CREATE TEMP TABLE IF NOT EXISTS preparation_preview_revision (source INTEGER NOT NULL, artifact INTEGER NOT NULL); INSERT INTO preparation_preview_revision SELECT 0,0 WHERE NOT EXISTS (SELECT 1 FROM preparation_preview_revision)');
  const tables: [string, string[] | undefined, 'source' | 'artifact'][] = [
    ['agent_entries', undefined, 'source'],
    ['agent_sessions', ['id', 'agent', 'external_id', 'path', 'file_identity', 'cwd', 'name', 'included', 'missing'], 'source'],
    ['agent_sources', undefined, 'source'],
    ['sync_settings', ['key', 'value'], 'source'],
    ['syncs', ['id', 'status', 'created_at', 'context_json', 'conversation_last_user_at', 'conversation_ended_at'], 'source'],
    ['sync_items', undefined, 'source'], ['sync_coverage', undefined, 'source'],
    ['background_runs', ['id', 'summary_model', 'input_key', 'source_keys_json', 'cache_receipt_json', 'processed_entries', 'started_at', 'completed_at'], 'artifact'],
    ['sync_runs', ['id', 'sync_id', 'summary_model', 'started_at'], 'artifact'],
    ...['summary_cache', 'summary_leaf_inputs', 'summary_leaf_plans', 'summary_pending_plans', 'summary_parent_inputs', 'summary_planning_context', 'summary_replay_attempts', 'sync_tree_nodes']
      .map(table => [table, undefined, 'artifact'] as [string, undefined, 'artifact']),
  ];
  for (const [table, selected, revision] of tables) {
    const columns = selected || (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const changed = event === 'UPDATE' ? `(${columns.map(column => `old.${column} IS NOT new.${column}`).join(' OR ')})` : '1';
      const setting = (prefix: string) => `${prefix}.key IN ('history_since','auto_index','auto_summary','storage_schema')`;
      const consent = table === 'sync_settings' ? ` AND (${event === 'UPDATE' ? `${setting('old')} OR ${setting('new')}` : setting(event === 'DELETE' ? 'old' : 'new')})` : '';
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS preview_${table}_${event} AFTER ${event} ON main.${table}
        WHEN ${changed}${consent} BEGIN UPDATE preparation_preview_revision SET ${revision}=${revision}+1; END`);
    }
  }
}
function revisions(db: Database.Database): { source: number; artifact: number } {
  return db.prepare('SELECT source,artifact FROM preparation_preview_revision').get() as { source: number; artifact: number };
}
function stamp(db: Database.Database): string {
  return JSON.stringify([revisions(db), db.pragma('data_version', { simple: true }), defaultModels(), getSourceRoots()]);
}
function reservationExpiry(db: Database.Database): number {
  const row = db.prepare(`SELECT MIN(COALESCE(conversation_last_user_at,created_at)) AS at FROM syncs
    WHERE status='open' AND conversation_ended_at IS NULL AND COALESCE(conversation_last_user_at,created_at)>?`)
    .get(new Date(Date.now() - 30 * 60_000).toISOString()) as { at: string | null };
  return row.at ? Date.parse(row.at) + 30 * 60_000 : Infinity;
}

function canAdmitPreview(): boolean {
  const progress = historyProgress();
  return activity.previewIdle && !progress.active && !progress.queued;
}

/** Metadata only. Even stale/unavailable status never starts verification. */
export function preparationPreview(): PreparationPreview {
  const db = getDb();
  if (database !== db) return unknown('stale');
  if (active) return unknown(active.controller.signal.aborted ? 'paused' : 'checking', state.checked_at);
  if (state.phase === 'ready' && (!checked || Date.now() >= checked.expires || Date.now() < Date.parse(state.checked_at!) || stamp(db) !== checked.stamp)) {
    state = unknown('stale', state.checked_at); checked = undefined;
  }
  // Paused is an admission state, not a sticky failure. Let ordinary polling
  // discover recovery without starting work here or repeatedly POSTing while
  // background history is busy. Idle may still include native retirement:
  // the next POST owns and drains that retirement before reading originals.
  if (state.phase === 'paused' && canAdmitPreview()) state = unknown('stale', state.checked_at);
  return { ...state };
}

/** POST admission is synchronous; ownership is installed before the first await.
 * Duplicate requests coalesce. A mutation reserves its place before draining us.
 * Failure is sticky until another explicit POST (GET never retries). */
export function requestPreparationPreview(): PreparationPreview {
  activity.assertAccepting();
  const db = getDb(); observe(db);
  if (active) return preparationPreview();
  const current = preparationPreview();
  if (current.phase === 'ready') return current;
  if (!canAdmitPreview()) return state = unknown('paused', state.checked_at);
  const controller = new AbortController(), release = activity.beginPreview(controller);
  if (!release) return state = unknown('paused', state.checked_at);
  const owner = { controller, done: Promise.resolve() };
  active = owner; state = unknown('checking', state.checked_at); checked = undefined;
  owner.done = Promise.resolve().then(async () => {
    try {
      // Let the 202 response flush and foreground cancellation run before any
      // original-file snapshot (including when every drain is already idle).
      await new Promise<void>(resolve => setImmediate(resolve));
      controller.signal.throwIfAborted();
      // Separate index-only drain avoids cancelling/awaiting this very owner.
      await yieldIndexingForPreview();
      controller.signal.throwIfAborted();
      // A cancelled memory request can settle before its native worker exits.
      // Drain retirement too, without ever queuing embedding/search work.
      await stopHistory();
      controller.signal.throwIfAborted();
      const baseline = stamp(db), started = Date.now(), deadline = reservationExpiry(db);
      const valid = () => !controller.signal.aborted && active === owner && getDb() === db &&
        Date.now() >= started && Date.now() < deadline && stamp(db) === baseline;
      const completed = await withPreviewClone(db, controller.signal, (file, result) => {
        // Estimates as of the worker's final physical check, never a proof for
        // later paid work. All actual inference gates still verify freshly.
        if (!valid() || result.checkedAt < started || result.checkedAt > Date.now() || Date.now() >= result.checkedAt + MAX_AGE) return;
        db.prepare('ATTACH DATABASE ? AS preview_clone').run(file);
        const busyTimeout = db.pragma('busy_timeout', { simple: true }) as number;
        // A concurrent external writer must invalidate/refuse this estimate,
        // not make passive UI work block the main thread on a SQLite lock.
        db.pragma('busy_timeout = 0');
        try {
          return db.transaction(() => {
            // Lock out external writers BEFORE checking data_version and merging.
            // No await between the guard, complete metadata merge, and new stamp.
            if (!valid()) return;
            importPreviewMetadata(db);
            return { ...result, stamp: stamp(db) };
          }).immediate();
        } finally { db.pragma(`busy_timeout = ${busyTimeout}`); db.exec('DETACH DATABASE preview_clone'); }
      });
      controller.signal.throwIfAborted();
      // Cleanup itself awaits filesystem work: reject mutations during that gap.
      if (!completed || getDb() !== db || stamp(db) !== completed.stamp || Date.now() >= deadline ||
        Date.now() < completed.checkedAt || Date.now() >= completed.checkedAt + MAX_AGE) {
        state = unknown('stale', state.checked_at); return;
      }
      checked = { stamp: completed.stamp, expires: Math.min(completed.checkedAt + MAX_AGE, deadline) };
      state = { phase: 'ready', ...completed.counts, checked_at: new Date(completed.checkedAt).toISOString(), error: '' };
    } catch {
      if (active === owner) state = unknown(controller.signal.aborted ? 'paused' : 'unavailable', state.checked_at, controller.signal.aborted ? '' : FAILURE);
    }
  }).finally(() => {
    if (active === owner) active = undefined;
    release();
  });
  return preparationPreview();
}
