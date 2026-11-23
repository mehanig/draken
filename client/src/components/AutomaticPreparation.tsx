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
    summarizing: `${settings.summary?.operation || 'Preparing summaries and workflows'}…`,
    paused: 'Paused for your conversation or foreground work.',
    stopping: 'Stopping automatic preparation…', error: settings.summary?.status === 'error' ? 'Model preparation is paused after a failed attempt.' : `${settings.error_operation || 'Automatic preparation'} stopped after a failed attempt.`,
  }[settings.phase];
  return <section className="history-progress" aria-label="Automatic preparation">
    <p role="status"><strong>{phase}</strong></p>
    {settings.enabled && <p className="small muted">Local indexing: {settings.indexing_error ? 'failed; see error below' : 'enabled'} (no model API). Model preparation: {!settings.summary_enabled ? 'off' : settings.summary?.status === 'error' ? 'paused after a failure' : 'enabled'}.</p>}
    {settings.enabled && <InfoDisclosure label="Preparation details">
      <p className="small muted">{settings.pending_records.toLocaleString()} source changes waiting for local indexing. {settings.last_completed_at && `Last completed indexing batch: ${new Date(settings.last_completed_at).toLocaleString()}.`}</p>
      {settings.summary?.last_completed_at && <p className="small muted">Last completed automatic preparation attempt: {settings.summary.prepared_entries.toLocaleString()} entries, {new Date(settings.summary.last_completed_at).toLocaleString()}. Later changes may still need preparation.</p>}
    </InfoDisclosure>}
    {settings.error && <p role="alert">{settings.error}</p>}
    {settings.indexing_error && settings.indexing_error !== settings.error && <p role="alert">{settings.indexing_error}</p>}
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
