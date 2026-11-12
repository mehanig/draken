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
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open) dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!open || saving) return;
    let alive = true;
    const poll = async () => { try { const value = await autoIndexSettings(); if (alive) { setSettings(value); setError(''); } }
      catch (error) { if (alive) setError(error instanceof Error ? error.message : 'Could not read settings'); } };
    void poll(); const timer = setInterval(() => void poll(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [open, saving]);
  return <>
    <button type="button" className="btn btn-secondary header-settings" aria-haspopup="dialog" onClick={() => setOpen(true)}><Settings size={16} aria-hidden="true" />Settings</button>
    <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); setOpen(false); }} onClose={event => { if (!event.currentTarget.open) setOpen(false); }}>
    <div className="section-heading"><h2 id="settings-title">Settings</h2><button type="button" className="icon-button" aria-label="Close settings" autoFocus onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button></div>
    <PreparationUsageDashboard active={open} />
    <label className="index-toggle"><input type="checkbox" role="switch" checked={settings?.enabled || false} disabled={!settings || saving}
      onChange={async event => { const enabled = event.target.checked, previous = settings; setSaving(true); setError('');
        setSettings(current => current ? { ...current, enabled } : current);
        try { setSettings(await setAutoIndex(enabled)); } catch (error) { setSettings(previous); setError(error instanceof Error ? error.message : 'Could not save settings'); }
        finally { setSaving(false); }
      }} /><span><strong>Automatically index history</strong><span className="small muted">Accumulate searchable history locally, without creating syncs, summaries or briefings.</span></span></label>
    <p className="small muted">On by default for new installations. Existing installations keep their saved indexing choice, including off. While the server runs, check once a minute and index batches at 64 source changes. Smaller tails wait for explicit foreground preparation, such as a sync, Prepare history or search; there is no timed flush. Only your Sync with Draken or Chat instead action creates a snapshot and starts its briefing. Calls and foreground work take priority.</p>
    <p className="small muted">Indexing makes no provider model calls. Local embeddings use CPU, memory and disk; first use may download about 136 MB of pinned search model files. Disabling cancels automatic indexing, keeping completed embeddings. Local failures back off for at least five minutes; foreground preemption waits at least one minute. Existing conversations, notes and frozen snapshots are not rewritten. Nothing is marked reviewed and no microphone or call starts automatically. Agent and session exclusions remain respected.</p>
    {saving && <p role="status">Saving…</p>}
    {error && <p className="small" role="alert">{error}</p>}
    {open && settings && <AutomaticProgress settings={settings} />}
    {settings?.enabled && settings.phase === 'error' && <button type="button" className="btn btn-secondary" disabled={saving} onClick={async () => {
      setSaving(true); setError(''); try { setSettings(await setAutoIndex(true)); } catch (error) { setError(error instanceof Error ? error.message : 'Could not retry indexing'); } finally { setSaving(false); }
    }}>Retry automatic indexing</button>}
    <AgentSources open={open} />
    <SetupPanel active={open} always />
    </dialog>
  </>;
}
