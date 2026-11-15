import { useEffect, useState } from 'react';
import { setAutoSummary, summaryPreparationSettings } from '../api';
import type { SummaryPreparationSettings } from '../types';

export function SummaryPreparation({ active, indexing, controls = false, disabled = false, onBusyChange }: {
  active: boolean; indexing: boolean; controls?: boolean; disabled?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<SummaryPreparationSettings | null>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [readError, setReadError] = useState('');
  useEffect(() => {
    if (!active || saving) return;
    let alive = true;
    const poll = async () => {
      try { const value = await summaryPreparationSettings(); if (alive) { setSettings(value); setReadError(''); } }
      catch (error) { if (alive) setReadError(error instanceof Error ? error.message : 'Could not read summary preparation status'); }
    };
    void poll(); const timer = setInterval(() => void poll(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [active, saving]);
  const save = async (enabled: boolean) => {
    setSaving(true); onBusyChange?.(true); setError('');
    try { setSettings(await setAutoSummary(enabled)); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save summary preparation settings'); }
    finally { setSaving(false); onBusyChange?.(false); }
  };
  const status = settings && {
    off: 'Background summary preparation is off.', waiting: 'Waiting for the next summary preparation batch.',
    running: 'Preparing reusable summaries ahead of your next sync…', paused: 'Summary preparation is paused.',
    error: 'Summary preparation needs an explicit retry.',
  }[settings.status];
  return <section aria-label="Background summary preparation">
    {controls && <>
      <label className="index-toggle"><input type="checkbox" role="switch" checked={settings?.enabled || false}
        disabled={!settings || saving || disabled || (!indexing && !settings.enabled)}
        onChange={event => void save(event.target.checked)} />
        <span><strong>Prepare summaries ahead</strong><span className="small muted">Use the configured summary provider and its quota or API billing to cache reusable summaries. Never create a sync or briefing automatically.</span></span>
      </label>
      <p className="small muted">Off until you enable it, including after an upgrade. Requires automatic indexing. After 64 new or changed eligible entries, prepare summary chunks and compaction in the background. Starting a chat or sync reuses completed work; changed tails, reconciliation and the opening briefing may still need preparation.</p>
      <p className="small muted">Foreground work takes priority. Disabling either option stops background preparation and keeps valid cache entries. Provider failures pause paid retries until you explicitly retry. Preparation usage includes these requests; cached entries are not reviewed work or completed syncs.</p>
    </>}
    {settings && (controls || settings.enabled) && <>
      <p role="status" className="small muted">{!indexing && settings.enabled ? 'Summary preparation is paused while automatic indexing is off.' : status}</p>
      {settings.last_completed_at && <p className="small muted">Last successful background pass: {settings.prepared_entries.toLocaleString()} entries, {new Date(settings.last_completed_at).toLocaleString()}. Later changes may still need preparation.</p>}
      {settings.error && <p role="alert">{settings.error}</p>}
      {controls && settings.enabled && settings.status === 'error' && <button type="button" className="btn btn-secondary"
        disabled={saving || disabled || !indexing} onClick={() => void save(true)}>Retry summary preparation</button>}
    </>}
    {saving && <p role="status">Saving summary preparation…</p>}
    {(error || readError) && <p role="alert" className="small">{error || readError}</p>}
  </section>;
}
