import { useEffect, useRef, useState } from 'react';
import { Settings, X } from 'lucide-react';
import { autoIndexSettings, setAutoIndex } from '../api';
import type { AutoIndexSettings } from '../types';
import { HistoryProgress } from './HistoryProgress';
import { AgentSources } from './AgentSources';
import { SetupPanel } from './SetupPanel';

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
  const phase = settings && ({ off: 'Off', waiting: settings.pending_records ? `${settings.pending_records} source changes waiting for a batch` : 'Waiting for the next background check',
    scanning: 'Checking session sources', indexing: 'Indexing in the background', paused: 'Paused for foreground work', stopping: 'Stopping background work', error: 'Background indexing needs attention' })[settings.phase];
  return <>
    <button type="button" className="btn btn-secondary header-settings" aria-haspopup="dialog" onClick={() => setOpen(true)}><Settings size={16} aria-hidden="true" />Settings</button>
    <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); setOpen(false); }} onClose={event => { if (!event.currentTarget.open) setOpen(false); }}>
    <div className="section-heading"><h2 id="settings-title">Settings</h2><button type="button" className="icon-button" aria-label="Close settings" autoFocus onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button></div>
    <label className="index-toggle"><input type="checkbox" role="switch" checked={settings?.enabled || false} disabled={!settings || saving}
      onChange={async event => { const enabled = event.target.checked, previous = settings; setSaving(true); setError('');
        setSettings(current => current ? { ...current, enabled } : current);
        try { setSettings(await setAutoIndex(enabled)); } catch (error) { setSettings(previous); setError(error instanceof Error ? error.message : 'Could not save settings'); }
        finally { setSaving(false); }
      }} /><span><strong>Automatically index history</strong><span className="small muted">Local background preparation, off by default.</span></span></label>
    <p className="small muted">While the server is running, check once a minute and index only when at least 64 changed source records have accumulated. Smaller batches wait until you sync, start a call or search; there is no timed flush. Calls, sync preparation and searches take priority. Newly discovered sessions from enabled agents are selected by default; agent and session exclusions remain respected.</p>
    <p className="small muted">This scans text logs and prepares local search embeddings; first use may download the pinned search model. It does not create or change frozen syncs, mark anything reviewed, use your microphone, or run summary models. The final aggregation still runs when you click Sync with Draken.</p>
    {settings && <p className="small muted" role="status">{saving ? 'Saving…' : phase}{settings.last_completed_at && ` · Last completed batch: ${new Date(settings.last_completed_at).toLocaleString()}`}</p>}
    {(error || settings?.error) && <p className="small" role="alert">{error || settings?.error}</p>}
    <HistoryProgress enabled={open && settings?.phase === 'indexing'} backgroundOnly />
    <AgentSources open={open} />
    <SetupPanel active={open} always />
    </dialog>
  </>;
}
