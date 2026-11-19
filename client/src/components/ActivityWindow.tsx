import { useEffect, useState } from 'react';
import { activityWindow, setActivityWindow } from '../api';
import { InfoDisclosure } from './InfoDisclosure';
import type { ActivityWindowSettings } from '../../../src/types';

export function ActivityWindow({ active, disabled, onChanged }: { active: boolean; disabled: boolean; onChanged: () => Promise<void> }) {
  const [settings, setSettings] = useState<ActivityWindowSettings | null>(null), [working, setWorking] = useState(false), [error, setError] = useState(''), [readError, setReadError] = useState('');
  useEffect(() => {
    if (!active || working) return;
    let alive = true;
    const refresh = () => { void activityWindow().then(value => { if (alive) { setSettings(value); setReadError(''); } }, failure => { if (alive) setReadError(failure.message); }); };
    refresh(); const timer = setInterval(refresh, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [active, working]);
  const change = async (value: string) => {
    if (working) return;
    setWorking(true); setError('');
    try {
      const days = value === 'all' ? null : Number(value), preview = await activityWindow(days);
      if (preview.confirmation_required && !window.confirm(`Include ${preview.additional_sessions} additional discovered sessions? Older sessions found in later scans will also qualify. If automatic preparation is enabled, their summaries may use your provider's quota or API billing. Completed work is reused.`)) return;
      setSettings(await setActivityWindow(days, preview.confirmation_required ? preview.confirmation : undefined));
      await onChanged();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not change the activity window'); }
    finally { setWorking(false); }
  };
  const options = [...new Set([1, 7, 14, 30, 90, 365, ...(settings?.days ? [settings.days] : [])])].sort((a, b) => a - b);
  return <section aria-label="Session activity window">
    <label>Prepare sessions active in <select aria-label="Session activity window" value={settings ? settings.days ?? 'all' : 7} disabled={!settings || disabled || working || Boolean(readError)} onChange={event => void change(event.target.value)}>
      {options.map(days => <option key={days} value={days}>Last {days} {days === 1 ? 'day' : 'days'}</option>)}<option value="all">All history</option>
    </select></label>
    <InfoDisclosure label="About the activity window"><p>Uses the last message, not the file’s modification date. A recent session includes its older messages too. Manual exclusions still apply. Ignored sessions keep their cached work and saved citations.</p></InfoDisclosure>
    {working && <p role="status">Updating session eligibility…</p>}
    {(error || readError) && <p role="alert">{error || readError}</p>}
  </section>;
}
