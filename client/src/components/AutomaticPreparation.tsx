import { useEffect, useState } from 'react';
import { autoIndexSettings } from '../api';
import type { AutoIndexSettings } from '../types';
import { HistoryProgress } from './HistoryProgress';
import { InfoDisclosure } from './InfoDisclosure';

export function AutomaticProgress({ settings }: { settings: AutoIndexSettings }) {
  const phase = {
    off: 'Automatic preparation is off.',
    waiting: 'Waiting for the next preparation batch.',
    scanning: 'Checking history for changes…', indexing: 'Indexing searchable history…',
    summarizing: 'Preparing reusable summary cache…',
    paused: 'Paused for your conversation or foreground work.',
    stopping: 'Stopping automatic preparation…', error: 'Automatic preparation needs attention.',
  }[settings.phase];
  return <section className="history-progress" aria-label="Automatic preparation">
    <p role="status"><strong>{phase}</strong></p>
    {settings.enabled && !settings.summary_enabled && <p role="status">Indexing only: summary preparation is off. Enable automatic preparation in Settings to run both.</p>}
    {settings.enabled && <InfoDisclosure label="Preparation details">
      <p className="small muted">{settings.pending_records.toLocaleString()} source changes waiting for local indexing. {settings.last_completed_at && `Last completed indexing batch: ${new Date(settings.last_completed_at).toLocaleString()}.`}</p>
      {settings.summary?.last_completed_at && <p className="small muted">Last successful summary pass: {settings.summary.prepared_entries.toLocaleString()} entries, {new Date(settings.summary.last_completed_at).toLocaleString()}. Later changes may still need preparation.</p>}
    </InfoDisclosure>}
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
  if (error) return <p role="status" className="small muted">Automatic preparation status is temporarily unavailable.</p>;
  return settings?.enabled ? <AutomaticProgress settings={settings} /> : null;
}
