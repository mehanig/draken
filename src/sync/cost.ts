import type Database from 'better-sqlite3';
import type { ModelCallMetric, SyncCost } from '../types';

/** Preparation only, across its retries/rebuilds. Follow-up questions, voice,
 * embeddings and post-conversation recaps never enter this total. No backfill
 * guesses from historical planning-token estimates or today's price catalog. */
export function aggregationCost(db: Database.Database, syncId: number, hasBriefing = false): SyncCost | null {
  const runs = db.prepare('SELECT invocations,status,metrics_json FROM sync_runs WHERE sync_id=? AND question IS NULL ORDER BY id').all(syncId) as { invocations: number; status: string; metrics_json: string }[];
  if (!runs.length) return hasBriefing ? { usd: null, complete: false } : null;
  let usd = 0, priced = 0, complete = true, calls = 0;
  for (const run of runs) {
    const metrics: ModelCallMetric[] = JSON.parse(run.metrics_json);
    calls += Math.max(run.invocations, metrics.length);
    if (run.status === 'running' || metrics.length !== run.invocations) complete = false;
    for (const metric of metrics) {
      const accounting = metric.accounting;
      if (accounting?.source === 'pi-usage/catalog-pricing' && typeof accounting.cost_usd === 'number' && Number.isFinite(accounting.cost_usd) && accounting.cost_usd >= 0) {
        usd += accounting.cost_usd; priced++;
        if (accounting.complete !== true) complete = false;
      } else complete = false;
    }
  }
  return { usd: priced || calls === 0 ? usd : null, complete };
}
