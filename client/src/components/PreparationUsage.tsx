import { useEffect, useState } from 'react';
import { preparationUsage } from '../api';
import type { PreparationUsage, UsageRange, UsageBucket } from '../types';

const money = (usd: number | null) => usd === null ? 'Unavailable' : usd > 0 && usd < 0.000001 ? '<$0.000001' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: usd < 0.01 ? 6 : 2 }).format(usd);
const date = (iso: string) => iso.slice(0, 16).replace('T', ' ');
const number = (value: number) => value.toLocaleString();

export function PreparationUsageDashboard({ active }: { active: boolean }) {
  const [range, setRange] = useState<UsageRange>('7d'), [bucket, setBucket] = useState<UsageBucket>('1h');
  const [metric, setMetric] = useState<'cost' | 'batches'>('cost');
  const [snapshot, setData] = useState<PreparationUsage | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); let busy = false;
    setData(null); setError('');
    const poll = async () => {
      if (busy) return; busy = true;
      try { const value = await preparationUsage(range, bucket, controller.signal); if (!controller.signal.aborted) { setData(value); setError(''); } }
      catch (error) { if (!controller.signal.aborted) { setData(null); setError(error instanceof Error ? error.message : 'Could not load preparation usage'); } }
      finally { busy = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active, range, bucket]);
  if (!active) return null;
  const data = snapshot?.range === range && snapshot.bucket === bucket ? snapshot : null;
  const total = data?.totals;
  const values = data?.buckets.map(bin => metric === 'cost' ? bin.cost.usd || 0 : bin.completed_batches) || [];
  const peak = Math.max(0, ...values), scale = peak || 1;
  return <section className="preparation-usage" aria-labelledby="preparation-usage-title">
    <h3 id="preparation-usage-title">Preparation usage</h3>
    <p className="small muted">Automatic and manual preparation, including retries and discarded batches. Estimates use recorded model usage and prices—not your bill, subscription charge or remaining quota.</p>
    <div className="usage-controls">
      <label>Look back<select value={range} onChange={event => setRange(event.target.value as UsageRange)}><option value="6h">6 hours</option><option value="1d">1 day</option><option value="7d">7 days</option><option value="14d">14 days</option></select></label>
      <label>Bucket size<select value={bucket} onChange={event => setBucket(event.target.value as UsageBucket)}><option value="1h">1 hour</option><option value="6h">6 hours</option><option value="24h">24 hours</option></select></label>
      <label>Chart<select value={metric} onChange={event => setMetric(event.target.value as 'cost' | 'batches')}><option value="cost">Estimated cost</option><option value="batches">Completed batches</option></select></label>
    </div>
    {error ? <p role="alert">Usage unavailable: {error}</p> : !data ? <p role="status">Loading preparation usage…</p> : total && <>
      <div className="usage-totals">
        <div><span className="small">{total.incomplete_pricing ? 'Known cost subtotal' : 'Est. preparation cost'}</span><strong>{money(total.cost.usd)}</strong><span className="small muted">{total.incomplete_pricing ? `${number(total.incomplete_pricing)} ${total.incomplete_pricing === 1 ? 'request has' : 'requests have'} incomplete pricing` : 'USD · recorded API-price estimate'}</span></div>
        <div><span className="small">Completed batches</span><strong>{number(total.completed_batches)}</strong><span className="small muted">{number(total.entries)} entries across these batches</span></div>
        <div><span className="small">Model requests</span><strong>{number(total.requests)}</strong><span className="small muted">{number(data.active_attempts)} preparation {data.active_attempts === 1 ? 'attempt' : 'attempts'} active now</span></div>
      </div>
      <p className="small muted">{date(data.from)} – {date(data.to)} UTC. Refreshes every 15 seconds while Settings is open.</p>
      {!total.requests && !total.completed_batches && !total.failed_attempts ? <p>No preparation recorded in this period.</p> : <>
        <div className="usage-chart-heading small"><strong>{metric === 'cost' ? 'Estimated cost' : 'Completed batches'} per {bucket}</strong><span>{metric === 'cost' ? `Peak known: ${money(total.cost.usd === null ? null : peak)}` : `Peak: ${number(peak)}`}</span></div>
        <svg className="usage-chart" viewBox="0 0 720 120" preserveAspectRatio="none" role="img" aria-label={`${metric === 'cost' ? 'Estimated preparation cost' : 'Completed batches'} by ${bucket} bucket. Exact values in bucket details below.`}>
          <line x1="0" y1="119" x2="720" y2="119" />
          {data.buckets.map((bin, index) => {
            const incomplete = metric === 'cost' && !bin.cost.complete;
            const height = Math.max(values[index] > 0 ? 2 : incomplete ? 4 : 0, values[index] / scale * 112);
            return <rect key={bin.from} x={index / values.length * 720} y={119 - height} width={Math.max(0.5, 720 / values.length - 1)} height={height} className={incomplete ? 'usage-incomplete' : undefined}><title>{date(bin.from)} – {date(bin.to)} UTC: {metric === 'cost' ? money(bin.cost.usd) + (incomplete ? ' (incomplete pricing)' : '') : `${bin.completed_batches} batches`}; {bin.requests} requests</title></rect>;
          })}
        </svg>
        <div className="usage-chart-axis small muted"><span>{date(data.from).slice(5)}</span><span>UTC</span><span>{date(data.to).slice(5)}</span></div>
        {metric === 'cost' && total.incomplete_pricing > 0 && <p className="small muted">Gray bars have incomplete pricing. Their heights show only the known subtotal; an unpriced request is not free.</p>}
        <details className="usage-details"><summary>Bucket details</summary><div className="usage-table-wrap" tabIndex={0} role="region" aria-label="Usage bucket details"><table><caption className="sr-only">Preparation usage by UTC time bucket, newest first</caption><thead><tr><th scope="col">UTC interval</th><th scope="col">Batches</th><th scope="col">Requests</th><th scope="col">Est. cost</th><th scope="col">Incomplete pricing</th></tr></thead><tbody>{[...data.buckets].reverse().map(bin => <tr key={bin.from}><th scope="row">{date(bin.from)}<br />to {date(bin.to)}</th><td>{number(bin.completed_batches)}</td><td>{number(bin.requests)}</td><td>{money(bin.cost.usd)}{!bin.cost.complete && ' (partial)'}</td><td>{number(bin.incomplete_pricing)}</td></tr>)}</tbody></table></div></details>
      </>}
      <p className="small muted">{number(total.failed_attempts)} failed or stopped {total.failed_attempts === 1 ? 'attempt' : 'attempts'} in this period. {number(total.approximate_timing)} {total.approximate_timing === 1 ? 'request uses' : 'requests use'} older, approximate timing (the preparation run’s start); newer requests use their recorded start time. Buckets align to UTC hours, with partial first and last buckets.</p>
    </>}
    <p className="small muted">A completed batch is a snapshot’s first successful briefing preparation. Retries and rebuilds add costs, not extra batches. Batch counts use completion time; request costs use start time. Counts do not mean reviewed work or current call readiness. Chat, voice and post-conversation recaps are excluded. Local search indexing uses no model API; machine and network costs are not measured.</p>
  </section>;
}
