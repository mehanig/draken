import { useEffect, useState } from 'react';
import { autoIndexSettings } from '../api';
import type { AutoIndexSettings } from '../types';
import { HistoryProgress } from './HistoryProgress';

export function AutomaticProgress({ settings }: { settings: AutoIndexSettings }) {
  const phase = {
    off: 'Automatic indexing is off.',
    waiting: 'Waiting for the next indexing batch.',
    scanning: 'Checking history for changes…', indexing: 'Indexing searchable history…',
    paused: 'Paused for your conversation or foreground work.',
    stopping: 'Stopping automatic indexing…', error: 'Automatic indexing needs attention.',
  }[settings.phase];
  return <section className="history-progress" aria-label="Automatic indexing">
    <p role="status"><strong>{phase}</strong></p>
    {settings.enabled && <>
      <p className="small muted">{settings.pending_records.toLocaleString()} source changes waiting for local indexing. {settings.last_completed_at && `Last completed indexing batch: ${new Date(settings.last_completed_at).toLocaleString()}.`}</p>
      <p className="small muted">{settings.pending_entries.toLocaleString()} entries available for your next sync. History accumulates without creating snapshots or briefings.</p>
    </>}
    {settings.error && <p role="alert">{settings.error}</p>}
    <HistoryProgress enabled={settings.enabled && settings.phase === 'indexing'} backgroundOnly />
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
  if (error) return <p role="status" className="small muted">Automatic indexing status is temporarily unavailable.</p>;
  return settings?.enabled ? <AutomaticProgress settings={settings} /> : null;
}
