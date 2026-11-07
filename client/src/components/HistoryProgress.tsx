import { useEffect, useState } from 'react';
import { historyProgress } from '../api';
import type { HistoryProgress as Progress } from '../../../src/memory/types';

const labels = { scanning: 'Checking history for changes…', downloading: 'Downloading the local search model…', loading: 'Preparing the local search model…',
  indexing: 'Indexing new and changed history…', searching: 'Finding matching history…', reading: 'Reading a historical source…' };
const duration = (seconds: number) => seconds < 60 ? `${Math.ceil(seconds)} sec` : `${Math.ceil(seconds / 60)} min`;
const count = (value: number) => value.toLocaleString();
export function HistoryProgress({ enabled, waiting = false, backgroundOnly = false, onLookupChange }: { enabled: boolean; waiting?: boolean; backgroundOnly?: boolean; onLookupChange?: (active: boolean) => void }) {
  const [progress, setProgress] = useState<Progress | null>(null), [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    onLookupChange?.(false);
    if (!enabled) return;
    setProgress(null); setUnavailable(false);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await historyProgress(controller.signal);
        if (!controller.signal.aborted) {
          setProgress(value); setUnavailable(false);
          onLookupChange?.(Boolean(value.active && !value.background && value.work && ['scanning', 'searching', 'reading'].includes(value.work.stage)
            && value.updated_at && Math.abs(Date.now() - value.updated_at) < 5000));
        }
      }
      catch { if (!controller.signal.aborted) { setUnavailable(true); onLookupChange?.(false); } }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); onLookupChange?.(false); };
  }, [enabled, onLookupChange]);
  if (!enabled) return null;
  if (!progress?.active || !progress.work || (backgroundOnly && !progress.background)) return waiting ? <p className="small muted" role="status">{unavailable ? 'Progress is unavailable; your search is still pending.' : 'Waiting for local history work…'}</p> : null;
  const work = progress.work, indexing = work.stage === 'indexing', downloading = work.stage === 'downloading';
  const completed = downloading ? work.downloaded_bytes : work.completed, total = downloading ? work.download_total_bytes : work.total;
  const percent = total ? Math.floor(completed / total * 100) : 0;
  const staleSeconds = progress.updated_at ? Math.floor((Date.now() - progress.updated_at) / 1000) : 0;
  return <section className="history-progress" aria-label="Local history progress">
    <p role="status"><strong>{indexing && !total ? 'History is up to date.' : labels[work.stage]}</strong></p>
    {((indexing && total > 0) || downloading) && <>
      <progress aria-label={downloading ? 'Model download' : 'History indexing'} max={total || 1} value={total ? completed : undefined} />
      <p>{downloading ? `${(completed / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB` : `${count(completed)} / ${count(total)} new or changed passages ready`} · {percent}%</p>
    </>}
    <p className="small muted">{indexing && `${count(work.reused)} unchanged passages reused (not part of this progress). `}Elapsed {duration(progress.elapsed_ms / 1000)}.
      {indexing && work.remaining_seconds !== null && work.remaining_seconds > 0 && ` About ${duration(work.remaining_seconds)} remaining (estimate).`}
      {indexing && total > 0 && work.parallelism && ` Up to ${work.parallelism.workers} embedding worker${work.parallelism.workers === 1 ? '' : 's'}, ${work.parallelism.threads} CPU threads total.`}
      {progress.queued > 0 && ` ${count(progress.queued)} other history request${progress.queued === 1 ? '' : 's'} waiting.`}</p>
    {(unavailable || staleSeconds >= 15) && <p className="small muted">{unavailable ? 'Progress updates are temporarily unavailable.' : `No new progress for ${duration(staleSeconds)}.`} Cancelling keeps completed embeddings for the next request.</p>}
  </section>;
}
