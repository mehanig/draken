import { useEffect, useRef, useState } from 'react';
import { Settings, X } from 'lucide-react';
import { autoIndexSettings, setAutoIndex } from '../api';
import type { AutoIndexSettings } from '../types';
import { AutomaticProgress } from './AutomaticPreparation';
import { AgentSources } from './AgentSources';
import { SetupPanel } from './SetupPanel';
import { PreparationUsageDashboard } from './PreparationUsage';

export function IndexSettings() {
  const [open, setOpen] = useState(false), [settings, setSettings] = useState<AutoIndexSettings | null>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [readError, setReadError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open) dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!open || saving) return;
    let alive = true;
    const poll = async () => { try { const value = await autoIndexSettings(); if (alive) { setSettings(value); setReadError(''); } }
      catch (error) { if (alive) setReadError(error instanceof Error ? error.message : 'Could not read settings'); } };
    void poll(); const timer = setInterval(() => void poll(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [open, saving]);
  return <>
    <button type="button" className="btn btn-secondary header-settings" aria-haspopup="dialog" onClick={() => setOpen(true)}><Settings size={16} aria-hidden="true" />Settings</button>
    <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); setOpen(false); }} onClose={event => { if (!event.currentTarget.open) setOpen(false); }}>
    <div className="section-heading"><h2 id="settings-title">Settings</h2><button type="button" className="icon-button" aria-label="Close settings" autoFocus onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button></div>
    <PreparationUsageDashboard active={open} />
    <label className="index-toggle"><input type="checkbox" role="switch" checked={Boolean(settings?.enabled && settings.summary_enabled)} disabled={!settings || saving}
      onChange={async event => { const enabled = event.target.checked, previous = settings; setSaving(true); setError('');
        setSettings(current => current ? { ...current, enabled, summary_enabled: enabled } : current);
        try { setSettings(await setAutoIndex(enabled)); } catch (error) { setSettings(previous); setError(error instanceof Error ? error.message : 'Could not save settings'); }
        finally { setSaving(false); }
      }} /><span><strong>Automatically prepare history</strong><span className="small muted">Index locally, then cache summaries using your configured provider and its quota or API billing.</span></span></label>
    <p className="small muted">On by default; saved opt-outs are preserved until you enable this option. At idle minute checks, index new or changed activity, then prepare reusable summaries. Foreground work takes priority. Disabling stops both stages and retains completed work. Provider failures pause paid retries until you explicitly retry; invocation limits still apply.</p>
    <p className="small muted">Local embeddings use CPU, memory and disk; first use may download about 136 MB of pinned search model files. Only your Sync with Draken or Chat instead action creates a snapshot and opening briefing. Changed inputs may still need preparation. Nothing is marked reviewed; conversations, notes, exclusions and frozen evidence are preserved.</p>
    {saving && <p role="status">Saving…</p>}
    {(error || readError) && <p className="small" role="alert">{error || readError}</p>}
    {open && settings && <AutomaticProgress settings={settings} />}
    {settings?.enabled && settings.phase === 'error' && <button type="button" className="btn btn-secondary" disabled={saving} onClick={async () => {
      setSaving(true); setError(''); try { setSettings(await setAutoIndex(true)); } catch (error) { setError(error instanceof Error ? error.message : 'Could not retry preparation'); } finally { setSaving(false); }
    }}>Retry automatic preparation</button>}
    <AgentSources open={open} />
    <SetupPanel active={open} always />
    </dialog>
  </>;
}
