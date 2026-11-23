import { InfoDisclosure } from '../components/InfoDisclosure';
import { useEffect, useState } from 'react';
import { autoIndexSettings, setAutoIndex } from '../api';
import type { AutoIndexSettings } from '../types';
import { AutomaticProgress } from '../components/AutomaticPreparation';
import { AgentSources } from '../components/AgentSources';
import { SetupPanel } from '../components/SetupPanel';
import { PreparationUsageDashboard } from '../components/PreparationUsage';

export function Settings() {
  const [settings, setSettings] = useState<AutoIndexSettings | null>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [readError, setReadError] = useState('');
  useEffect(() => {
    if (saving) return;
    let alive = true;
    const poll = async () => { try { const value = await autoIndexSettings(); if (alive) { setSettings(value); setReadError(''); } }
      catch (error) { if (alive) setReadError(error instanceof Error ? error.message : 'Could not read settings'); } };
    void poll(); const timer = setInterval(() => void poll(), 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [saving]);
  return <main className="settings-page" aria-labelledby="settings-title">
    <h1 id="settings-title">Settings</h1>
    <PreparationUsageDashboard active />
    <label className="index-toggle"><input type="checkbox" role="switch" checked={Boolean(settings?.enabled && settings.summary_enabled)} disabled={!settings || saving}
      onChange={async event => { const enabled = event.target.checked, previous = settings; setSaving(true); setError('');
        setSettings(current => current ? { ...current, enabled, summary_enabled: enabled } : current);
        try { setSettings(await setAutoIndex(enabled)); } catch (error) { setSettings(previous); setError(error instanceof Error ? error.message : 'Could not save settings'); }
        finally { setSaving(false); }
      }} /><span><strong>Automatically prepare history</strong><span className="small muted">Local indexing uses no model API. Summaries and workflow preparation use your configured models and their quota or API billing.</span></span></label>
    <InfoDisclosure label="About automatic preparation">
      <p>Preparation runs while Draken is idle. Turning it off keeps completed work. A failed model-preparation attempt pauses further model preparation until you explicitly retry. Local indexing continues separately.</p>
      <p>Local search uses CPU, memory and disk, and may download about 136 MB on first use. Starting a chat or call creates its briefing. Preparation never starts a call or marks work reviewed.</p>
    </InfoDisclosure>
    {saving && <p role="status">Saving…</p>}
    {(error || readError) && <p className="small" role="alert">{error || readError}</p>}
    {settings && <AutomaticProgress settings={settings} />}
    {settings?.enabled && settings.phase === 'error' && <><p className="small muted">Retrying can make model calls and incur costs. It does not execute saved workflows.</p><button type="button" className="btn btn-secondary" disabled={saving} onClick={async () => {
      setSaving(true); setError(''); try { setSettings(await setAutoIndex(true)); } catch (error) { setError(error instanceof Error ? error.message : 'Could not retry preparation'); } finally { setSaving(false); }
    }}>Retry automatic preparation</button></>}
    <AgentSources open />
    <SetupPanel always />
  </main>;
}
