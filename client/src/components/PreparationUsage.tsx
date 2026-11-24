import { useEffect, useState } from 'react';
import { preparationUsage } from '../api';
import type { PreparationUsage, UsageRange, UsageBucket } from '../types';

const money = (usd: number | null) => usd === null ? 'Unavailable' : usd > 0 && usd < 0.000001 ? '<$0.000001' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: usd < 0.01 ? 6 : 2 }).format(usd);
const date = (iso: string) => iso.slice(0, 16).replace('T', ' ');
const number = (value: number) => value.toLocaleString();
const operationLabels: Record<string, string> = { summarize: 'Summarization', group_topics: 'Topic grouping', repair_summary_citations: 'Summary citation repair', reconstruct_task: 'Task reconstruction', review_task_reconstruction: 'Task reconstruction review', select_workflow_candidates: 'Workflow selection', compare_workflow_identity: 'Workflow comparison', enrich_workflow: 'Workflow enrichment', prepare_workflow_process: 'Historical process extraction', create_workflow_from_history: 'Requested workflow creation', final_verdict: 'Briefing', unknown: 'Unknown (not recorded)' };
const operationLabel = (value: string) => Object.prototype.hasOwnProperty.call(operationLabels, value) ? operationLabels[value] : value.replace(/_/g, ' ');

function chartScale(peak: number, batches: boolean) {
  const target = (peak || 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = Math.max(batches ? 1 : Number.MIN_VALUE, [1, 2, 5, 10].find(value => value * magnitude >= target)! * magnitude);
  const intervals = Math.max(1, Math.ceil((peak || 1) / step));
  const maximum = intervals * step;
  const decimals = Math.max(2, -Math.floor(Math.log10(step)));
  const label = (value: number) => batches ? number(value) : value === 0 ? '$0' : step < 0.000001 || maximum >= 1e9
    ? `$${Number(value.toPrecision(3)).toExponential()}`
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Math.min(6, decimals) }).format(value);
  return { maximum, ticks: Array.from({ length: intervals + 1 }, (_, index) => ({ fraction: index / intervals, label: label(index * step) })) };
}

export function PreparationUsageDashboard({ active }: { active: boolean }) {
  const [range, setRange] = useState<UsageRange>('7d'), [bucket, setBucket] = useState<UsageBucket>('1h');
  const [model, setModel] = useState(''), [operation, setOperation] = useState('');
  const [choices, setChoices] = useState<{ models: string[]; operations: string[] }>({ models: [], operations: [] });
  const filtered = !!(model || operation);
  const [metric, setMetric] = useState<'cost' | 'batches'>('cost');
  const [snapshot, setData] = useState<PreparationUsage | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); let busy = false;
    setData(null); setError('');
    const poll = async () => {
      if (busy) return; busy = true;
      try { const value = await preparationUsage(range, bucket, model, operation, controller.signal); if (!controller.signal.aborted) { setData(value); setChoices({ models: value.models, operations: value.operations }); setError(''); } }
      catch (error) { if (!controller.signal.aborted) { setData(null); setError(error instanceof Error ? error.message : 'Could not load preparation usage'); } }
      finally { busy = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active, range, bucket, model, operation]);
  if (!active) return null;
  const data = snapshot?.range === range && snapshot.bucket === bucket && snapshot.filters.model === (model || null) && snapshot.filters.operation === (operation || null) ? snapshot : null;
  const total = data?.totals;
  const values = data?.buckets.map(bin => metric === 'cost' ? bin.cost.usd || 0 : bin.completed_batches) || [];
  const peak = Math.max(0, ...values), scale = chartScale(peak, metric === 'batches');
  const unpriced = metric === 'cost' && total?.cost.usd === null;
  const ticks = unpriced ? [] : scale.ticks;
  const unit = metric === 'cost' ? 'USD' : 'Briefings';
  return <section className="preparation-usage" aria-labelledby="preparation-usage-title">
    <h3 id="preparation-usage-title">Preparation usage</h3>
    <p className="small muted">Model usage for summaries, workflow preparation and briefings, including failed attempts, retries and discarded briefings. Estimates use recorded API prices—not your bill, subscription charge or remaining quota.</p>
    <div className="usage-controls">
      <label>Look back<select value={range} onChange={event => setRange(event.target.value as UsageRange)}><option value="6h">6 hours</option><option value="1d">1 day</option><option value="7d">7 days</option><option value="14d">14 days</option></select></label>
      <label>Bucket size<select value={bucket} onChange={event => setBucket(event.target.value as UsageBucket)}><option value="1h">1 hour</option><option value="6h">6 hours</option><option value="24h">24 hours</option></select></label>
      <label>Chart<select value={metric} onChange={event => setMetric(event.target.value as 'cost' | 'batches')}><option value="cost">Estimated cost</option><option value="batches" disabled={filtered}>Briefings prepared</option></select></label>
      <label>Model<select value={model} onChange={event => { setModel(event.target.value); setMetric('cost'); }}><option value="">All models</option>{[...new Set([...choices.models, ...(model ? [model] : [])])].sort().map(value => <option key={value} value={value}>{value === 'unknown' ? 'Unknown (not recorded)' : value}</option>)}</select></label>
      <label>Operation<select value={operation} onChange={event => { setOperation(event.target.value); setMetric('cost'); }}><option value="">All operations</option>{[...new Set([...choices.operations, ...(operation ? [operation] : [])])].sort().map(value => <option key={value} value={value}>{operationLabel(value)}</option>)}</select></label>
    </div>
    {filtered && <p className="small muted">Filters apply to costs and requests. Clear both filters to chart briefings.</p>}
    {error ? <p role="alert">Usage unavailable: {error}</p> : !data ? <p role="status">Loading preparation usage…</p> : total && <>
      <div className="usage-totals">
        <div><span className="small">{total.incomplete_pricing ? 'Known cost subtotal' : 'Est. preparation cost'}</span><strong>{money(total.cost.usd)}</strong><span className="small muted">{total.incomplete_pricing ? `${number(total.incomplete_pricing)} ${total.incomplete_pricing === 1 ? 'request has' : 'requests have'} incomplete pricing` : 'USD · recorded API-price estimate'}</span></div>
        <div><span className="small">Briefings prepared{filtered && ' (all preparation)'}</span><strong>{number(total.completed_batches)}</strong><span className="small muted">{number(total.entries)} entries across these briefings</span></div>
        <div><span className="small">{filtered ? 'Matching model requests' : 'Model requests'}</span><strong>{number(total.requests)}</strong><span className="small muted">{number(data.active_attempts)} preparation {data.active_attempts === 1 ? 'attempt' : 'attempts'} active now{filtered && ' (all preparation)'}</span></div>
      </div>
      <p className="small muted">{date(data.from)} – {date(data.to)} UTC. Refreshes every 15 seconds while Settings is open.</p>
      {!total.requests && (filtered || (!total.completed_batches && !total.failed_attempts)) ? <p>{filtered ? 'No model requests match these filters in this period.' : 'No preparation recorded in this period.'}</p> : <>
        <div className="usage-chart-heading small"><strong>{metric === 'cost' ? 'Estimated cost' : 'Briefings prepared'} per {bucket}</strong><span>{metric === 'cost' ? `Peak known: ${money(total.cost.usd === null ? null : peak)}` : `Peak: ${number(peak)}`}</span></div>
        <div className="usage-chart-frame">
        <span className="usage-axis-unit small muted" aria-hidden="true">{unit}</span>
        <div className="usage-y-axis small muted" aria-hidden="true" style={{ width: `${Math.max(7, ...ticks.map(tick => tick.label.length))}ch` }}>
          {ticks.map(tick => <span key={tick.fraction} style={{ top: `${(119 - tick.fraction * 112) / 120 * 100}%` }}>{tick.label}</span>)}
        </div>
        <svg className="usage-chart" viewBox="0 0 720 120" preserveAspectRatio="none" role="img" aria-label={`${metric === 'cost' ? 'Estimated preparation cost' : 'Briefings prepared'} by ${bucket} bucket. Y-axis: ${unit}${unpriced ? ', pricing unavailable' : `, ${ticks[0].label} to ${ticks[ticks.length - 1].label}`}. Exact values in bucket details below.`}>
          {ticks.map(tick => <line className="usage-gridline" key={tick.fraction} x1="0" y1={119 - tick.fraction * 112} x2="720" y2={119 - tick.fraction * 112} />)}
          {data.buckets.map((bin, index) => {
            const incomplete = metric === 'cost' && !bin.cost.complete;
            const height = Math.max(values[index] > 0 ? 2 : incomplete ? 4 : 0, values[index] / scale.maximum * 112);
            return <rect key={bin.from} x={index / values.length * 720} y={119 - height} width={Math.max(0.5, 720 / values.length - 1)} height={height} className={incomplete ? 'usage-incomplete' : undefined}><title>{date(bin.from)} – {date(bin.to)} UTC: {metric === 'cost' ? money(bin.cost.usd) + (incomplete ? ' (incomplete pricing)' : '') : `${bin.completed_batches} briefings`}; {bin.requests} requests</title></rect>;
          })}
          <line x1="0" y1="7" x2="0" y2="119" />
          <line x1="0" y1="119" x2="720" y2="119" />
        </svg>
        <div className="usage-chart-axis small muted"><span>{date(data.from).slice(5)}</span><span>UTC</span><span>{date(data.to).slice(5)}</span></div>
        </div>
        {metric === 'cost' && total.incomplete_pricing > 0 && <p className="small muted">{unpriced ? 'No priced amounts are available. ' : ''}Gray bars have incomplete pricing. Their heights show only the known subtotal; short baseline markers indicate unpriced requests, not a measured cost. An unpriced request is not free.</p>}
        <details className="usage-details"><summary>Bucket details</summary><div className="usage-table-wrap" tabIndex={0} role="region" aria-label="Usage bucket details"><table><caption className="sr-only">Preparation usage by UTC time bucket, newest first</caption><thead><tr><th scope="col">UTC interval</th>{!filtered && <th scope="col">Briefings</th>}<th scope="col">Requests</th><th scope="col">Est. cost</th><th scope="col">Incomplete pricing</th></tr></thead><tbody>{[...data.buckets].reverse().map(bin => <tr key={bin.from}><th scope="row">{date(bin.from)}<br />to {date(bin.to)}</th>{!filtered && <td>{number(bin.completed_batches)}</td>}<td>{number(bin.requests)}</td><td>{money(bin.cost.usd)}{!bin.cost.complete && ' (partial)'}</td><td>{number(bin.incomplete_pricing)}</td></tr>)}</tbody></table></div></details>
      </>}
      <p className="small muted">{filtered && 'Across all models and operations: '}{number(total.failed_attempts)} failed or stopped {total.failed_attempts === 1 ? 'attempt' : 'attempts'} in this period. {total.approximate_timing > 0 && <>{filtered && 'Among matching calls: '}{number(total.approximate_timing)} {total.approximate_timing === 1 ? 'request uses' : 'requests use'} approximate timing from the preparation run’s start.</>}</p>
    </>}
    <p className="small muted">Each briefing is counted once, at its first successful preparation—not as reviewed work. Background summaries and workflow preparation add model usage, not briefings. Counts use completion time; costs use request start time. Chat, voice, post-conversation recaps and local CPU, storage and network costs are excluded. Local indexing uses no model API.</p>
  </section>;
}
