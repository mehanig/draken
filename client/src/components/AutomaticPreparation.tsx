import { useEffect, useState } from 'react';
import { autoIndexSettings } from '../api';
import type { AutoIndexSettings } from '../types';
import { HistoryProgress } from './HistoryProgress';

export function AutomaticProgress({ settings }: { settings: AutoIndexSettings }) {
  const waiting = settings.pending_entries ?? 0;
  const phase = {
    off: 'Automatic preparation is off.',
    waiting: settings.ready_sync_id ? 'Your next briefing is prepared.' : 'Waiting for the next preparation batch.',
    scanning: 'Checking history for changes…', indexing: 'Preparing searchable history…',
    briefing: 'Preparing your next briefing…', paused: 'Paused for your conversation or foreground work.',
    stopping: 'Stopping automatic preparation…', error: 'Automatic preparation needs attention.',
  }[settings.phase];
  return <section className="history-progress" aria-label="Automatic preparation">
    <p role="status"><strong>{phase}</strong></p>
    {settings.enabled && <p className="small muted">{waiting.toLocaleString()} entries not yet assigned to a preparation batch. {settings.last_completed_at && `Last completed batch: ${new Date(settings.last_completed_at).toLocaleString()}.`}</p>}
    {settings.sync_id && settings.progress && <p className="small muted">{settings.progress.total.toLocaleString()} entries in unfinished preparation #{settings.sync_id}. These are already assigned, not a ready briefing.</p>}
    {settings.phase === 'error' && settings.progress && <p className="small muted">Stopped at: {settings.progress.stage}.</p>}
    {settings.phase === 'briefing' && settings.progress && <>
      <p role="status">{settings.progress.stage}</p>
      <progress aria-label="Automatic briefing summaries" max={Math.max(1, settings.progress.total)} value={settings.progress.completed} />
      <p className="small muted">{settings.progress.completed.toLocaleString()} / {settings.progress.total.toLocaleString()} entries summarized. {settings.progress.invocations} / {settings.progress.max_invocations} model calls this attempt. The opening briefing and search readiness finish this batch.</p>
    </>}
    {settings.error && <p role="alert">{settings.error}</p>}
    {settings.sync_id && <a href={`/syncs/${settings.sync_id}`}>Open preparation</a>}
    {!settings.sync_id && settings.ready_sync_id && <a href={`/syncs/${settings.ready_sync_id}`}>Open prepared briefing</a>}
    <HistoryProgress enabled={settings.enabled && ['indexing', 'briefing'].includes(settings.phase)} backgroundOnly />
  </section>;
}

export function AutomaticPreparation() {
  const [settings, setSettings] = useState<AutoIndexSettings | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = async () => { try { const next = await autoIndexSettings(); if (alive) { setSettings(next); setError(false); } }
      catch { if (alive) setError(true); } };
    void poll(); const timer = setInterval(() => void poll(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (error) return <p role="status" className="small muted">Automatic preparation status is temporarily unavailable.</p>;
  return settings?.enabled ? <AutomaticProgress settings={settings} /> : null;
}
