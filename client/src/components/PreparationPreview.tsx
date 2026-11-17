import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { checkPreparationPreview, preparationPreview } from '../api';
import { previewInputs, subscribePreviewInputs } from '../api/preview-inputs';
import type { PreparationPreview as Preview } from '../types';

const checking: Preview = { phase: 'checking', needs_processing: null, cached: null, total: null, checked_at: null, error: '' };

export function PreparationPreview({ busy, loading }: { busy: boolean; loading: boolean }) {
  const inputs = useSyncExternalStore(subscribePreviewInputs, previewInputs);
  const blocked = busy || inputs.pending > 0 || loading;
  const [result, setResult] = useState({ value: checking, inputs, blocked });
  const [retry, setRetry] = useState(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const failed = useRef<{ value: Preview; inputs: typeof inputs } | null>(null);

  useEffect(() => {
    let alive = true;
    let staleRequested = false;
    let pausedRetried = false;
    const current = () => alive && previewInputs() === inputs;
    const publish = (value: Preview) => { if (current()) setResult({ value, inputs, blocked }); };
    if (failed.current?.inputs !== inputs) failed.current = null;
    if (blocked) { publish(checking); return; }

    const run = (start: boolean) => {
      if (!current() || inFlight.current || failed.current) return;
      let followUp = false;
      if (start) publish(checking);
      // One serialized lane for both GET and POST. A superseded effect waits for
      // the old transport to settle, but can never publish its late response.
      const task = (async () => {
        try {
          const value = await (start ? checkPreparationPreview() : preparationPreview());
          if (!current()) return;
          publish(value);
          if (value.phase === 'unavailable') failed.current = { value, inputs };
          if (value.phase === 'ready') { staleRequested = false; pausedRetried = false; }
          if (value.phase === 'stale') {
            followUp = !start && !staleRequested;
            staleRequested = true;
          }
          // A new paused admission can later become stale via metadata GET,
          // even after a previous stale refresh was interrupted by foreground work.
          if (value.phase === 'paused') staleRequested = false;
          // A paused POST may race Home's busy metadata. On the next idle
          // poll allow one retry, never a POST/paused/POST restart loop.
          if (value.phase === 'paused' && !start && !pausedRetried) { pausedRetried = true; followUp = true; }
        } catch (error) {
          if (!current()) return;
          const value: Preview = { ...checking, phase: 'unavailable', error: error instanceof Error ? error.message : 'Could not verify reusable work.' };
          failed.current = { value, inputs };
          publish(value);
        }
      })();
      inFlight.current = task;
      void task.then(() => {
        if (inFlight.current === task) inFlight.current = null;
        if (followUp && current()) run(true);
      });
    };

    // Defer the initial request so StrictMode's setup/cleanup rehearsal does
    // not issue a second POST. A real remount creates its own fresh estimate.
    void (inFlight.current || Promise.resolve()).then(() => run(true));
    const timer = setInterval(() => run(false), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [blocked, inputs, retry]);

  const value = blocked
    ? { ...checking, phase: loading ? 'checking' : 'paused' } as Preview
    : (failed.current?.inputs === inputs ? failed.current.value : null) ?? (result.inputs !== inputs || result.blocked !== blocked ? checking : result.value);
  const retryCheck = () => { failed.current = null; setResult({ value: checking, inputs, blocked }); setRetry(value => value + 1); };
  const count = (value: number | null) => value === null ? 'Unknown' : `${value.toLocaleString()} entries`;
  return <section aria-label="Reusable summary work" className="preparation-preview">
    <div role="status" aria-live="polite">
      {value.phase === 'ready' ? <>
        <div className="home-counts"><span>Needs new summaries: <strong>{count(value.needs_processing)}</strong></span><span>Already cached: <strong>{count(value.cached)}</strong></span></div>
        <p className="small muted">Estimates for indexed inputs{value.total !== null ? ` (${value.total.toLocaleString()} entries)` : ''}. {value.checked_at ? <>As of <time dateTime={value.checked_at}>{new Date(value.checked_at).toLocaleString()}</time>.</> : 'Check time unavailable.'}</p>
      </> : value.phase === 'checking' ? <p>Checking reusable work…</p>
        : value.phase === 'stale' ? <p>Reusable-work estimate is stale. A fresh local check has been requested; counts are hidden until verified.</p>
        : value.phase === 'paused' ? <p>Reusable-work check paused for foreground work, a call, or source changes. It will retry when idle.</p>
        : <p>Reusable-work estimate unavailable. Counts are unknown, not zero.</p>}
    </div>
    {value.phase === 'unavailable' && <p role="alert" className="small">{value.error || 'The local cached-work check could not complete.'}</p>}
    {(value.phase === 'unavailable' || value.phase === 'stale' || value.phase === 'paused' && !blocked) && <button type="button" className="btn btn-secondary" onClick={retryCheck}>Retry reusable-work check</button>}
    <p className="small muted">This free check only verifies local cached work. It makes no provider requests and does not prepare summaries or create a sync. You can start without waiting.</p>
    <p className="small muted">Reconciliation and the final briefing may still require inference, even with zero new summaries. These are entry estimates, not a billable-work or cost estimate.</p>
  </section>;
}
