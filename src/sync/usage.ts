import type Database from 'better-sqlite3';
import type { ModelCallMetric, PreparationUsage, PreparationUsageTotals, UsageBucket, UsageRange } from '../types';
import { recordedCost } from './cost';
import { HttpError } from '../errors';

const ranges = { '6h': 6, '1d': 24, '7d': 168, '14d': 336 };
const widths = { '1h': 1, '6h': 6, '24h': 24 };
type Counters = PreparationUsageTotals & { priced: number };
const empty = (): Counters => ({ cost: { usd: 0, complete: true }, completed_batches: 0, entries: 0, requests: 0,
  incomplete_pricing: 0, approximate_timing: 0, failed_attempts: 0, priced: 0 });
function finish({ priced, ...value }: Counters): PreparationUsageTotals {
  return { ...value, cost: { usd: priced || !value.requests ? value.cost.usd : null, complete: value.incomplete_pricing === 0 } };
}

/** Read-only accounting metadata, never source discovery, model pricing lookup,
 * inference, index preparation or mutation. Includes failed/discarded work. */
export function preparationUsage(db: Database.Database, query: Record<string, unknown>, now = Date.now()): PreparationUsage {
  const range = query.range ?? '7d', bucket = query.bucket ?? '1h';
  if (Object.keys(query).some(key => !['range', 'bucket'].includes(key)) || typeof range !== 'string' || !Object.hasOwn(ranges, range) || typeof bucket !== 'string' || !Object.hasOwn(widths, bucket)) {
    throw new HttpError(400, 'Choose a range of 6h, 1d, 7d or 14d and a bucket of 1h, 6h or 24h');
  }
  const selectedRange = range as UsageRange, selectedBucket = bucket as UsageBucket;
  const from = now - ranges[selectedRange] * 3600000, width = widths[selectedBucket] * 3600000;
  const aligned = Math.floor(from / width) * width, totals = empty();
  const bins: (Counters & { from: string; to: string })[] = [];
  for (let start = aligned; start < now; start += width) bins.push({ ...empty(), from: new Date(Math.max(from, start)).toISOString(), to: new Date(Math.min(now, start + width)).toISOString() });
  const at = (date: string | null) => {
    const time = date ? Date.parse(date) : NaN;
    return time >= from && time < now ? bins[Math.floor((time - aligned) / width)] : undefined;
  };
  type Run = { id: number; invocations: number; status: string; started_at: string; completed_at: string | null; metrics_json: string };
  const runs = db.prepare(`SELECT id,invocations,status,started_at,completed_at,metrics_json FROM sync_runs
    WHERE question IS NULL AND (started_at>=? OR completed_at>=? OR status='running')`).all(new Date(from).toISOString(), new Date(from).toISOString()) as Run[];
  let active = 0;
  for (const run of runs) {
    if (run.status === 'running') active++;
    let metrics: ModelCallMetric[];
    try { metrics = JSON.parse(run.metrics_json); if (!Array.isArray(metrics) || metrics.some(m => !m || typeof m !== 'object')) throw Error(); }
    catch { throw new HttpError(503, 'Preparation usage metadata could not be read. No totals were estimated from missing records.'); }
    const add = (date: string, count: number, metric?: ModelCallMetric, approximate = false) => {
      const bin = at(date); if (!bin) return;
      const cost = metric ? recordedCost(metric) : { usd: null, complete: false };
      for (const target of [bin, totals]) {
        target.requests += count;
        if (cost.usd !== null) { target.cost.usd! += cost.usd; target.priced += count; }
        if (!cost.complete) target.incomplete_pricing += count;
        if (approximate) target.approximate_timing += count;
      }
    };
    for (const metric of metrics) {
      const exact = typeof metric.started_at === 'string' && Number.isFinite(Date.parse(metric.started_at));
      add(exact ? metric.started_at! : run.started_at, 1, metric, !exact);
    }
    // Older/crashed runs may have reserved invocations without a metric. Never
    // turn those requests into zero-cost work or fabricate per-call timestamps.
    add(run.started_at, Math.max(0, run.invocations - metrics.length), undefined, true);
    if (['failed', 'cancelled', 'interrupted'].includes(run.status)) {
      const bin = at(run.completed_at); if (bin) { bin.failed_attempts++; totals.failed_attempts++; }
    }
  }
  const completed = db.prepare(`SELECT r.completed_at,r.total_entries FROM sync_runs r
    WHERE r.question IS NULL AND r.status='completed' AND r.completed_at>=? AND r.completed_at<?
    AND NOT EXISTS (SELECT 1 FROM sync_runs prior WHERE prior.sync_id=r.sync_id AND prior.question IS NULL AND prior.status='completed' AND prior.id<r.id)`).all(new Date(from).toISOString(), new Date(now).toISOString()) as { completed_at: string; total_entries: number }[];
  for (const run of completed) {
    const bin = at(run.completed_at); if (bin) for (const target of [bin, totals]) { target.completed_batches++; target.entries += run.total_entries; }
  }
  return { from: new Date(from).toISOString(), to: new Date(now).toISOString(), range: selectedRange, bucket: selectedBucket,
    active_attempts: active, totals: finish(totals), buckets: bins.map(bin => ({ ...finish(bin), from: bin.from, to: bin.to })) };
}
