import { InfoDisclosure } from './InfoDisclosure';
import { useEffect, useState } from 'react';
import { setup } from '../api';
import { voiceRequest, type VoiceStatus } from '../voice/api';

export function SetupPanel({ active = true, firstRun = false, always = false, onReady, onTextReady }: { active?: boolean; firstRun?: boolean; always?: boolean; onReady?: (ready: boolean) => void; onTextReady?: (ready: boolean) => void }) {
  const [value, setValue] = useState<Awaited<ReturnType<typeof setup>> | null>(null);
  const [voice, setVoice] = useState<VoiceStatus | null>(null), [error, setError] = useState(''), [checking, setChecking] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = async (fresh = false) => {
      setChecking(true);
      try {
        const [next, audio] = await Promise.all([setup(fresh), voiceRequest<VoiceStatus>('/status').catch(() => null)]);
        if (!alive) return;
        setValue(next); setVoice(audio); setError(audio ? '' : 'Voice status is unavailable. Configured text chat can still be used.'); onReady?.(next.pi.state === 'configured' && Boolean(audio?.installed)); onTextReady?.(next.pi.state === 'configured');
      } catch { if (alive) { setError('Could not check setup or reach Draken. The last displayed state may be stale. Check the server terminal, then retry.'); onReady?.(false); onTextReady?.(false); } }
      finally { if (alive) setChecking(false); }
    };
    void load(refresh > 0);
    const timer = setInterval(() => void load(), 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [active, refresh, onReady, onTextReady]);
  if (!active || (!always && !firstRun && !error && value?.pi.state === 'configured' && voice?.installed)) return null;
  const pi = value?.pi;
  return <section className="setup-panel" aria-label="Draken setup">
    <h2>{firstRun ? 'First-time setup' : 'Runtime & sign-in'}</h2>
    <InfoDisclosure label="About setup">
      <p>Summaries and text chat use pi. Voice uses a separate ChatGPT sign-in. Setup and login run in the server terminal.</p>
      <p>Automatic preparation is managed in Settings and uses your configured provider’s quota or API billing. Configured credentials do not guarantee model access or available quota.</p>
      {pi && <><ul>{pi.models.map(model => <li key={model.model}>{model.model} · {model.state.replace(/_/g, ' ')}</li>)}</ul><p className="source-path">Pi credential directory: {pi.agent_dir}</p></>}
      {value && <p className="source-path">Draken data: {value.data_dir}</p>}
    </InfoDisclosure>
    {!value && !error && <p className="small" role="status">Checking setup…</p>}
    {pi && <>
      <p><strong>Summarization: {pi.state === 'configured' ? 'credentials configured' : pi.state === 'missing' ? 'pi not found' : pi.state === 'needs_login' ? 'sign-in needed' : 'needs attention'}</strong><span className="small muted"> · {pi.source === 'managed' ? 'Draken-private pi' : 'Existing / external pi'}{pi.version && ` ${pi.version}`}</span></p>
      <p className="small">{pi.message}</p>
      {pi.state !== 'configured' && <div className="setup-commands">
        {['missing', 'incompatible'].includes(pi.state) && <p><code>draken setup</code> — install a pinned, private pi after confirmation. An explicit <code>DRAKEN_PI_BIN</code> must be fixed or unset first.</p>}
        <p><code>draken login</code> — open pi; type <code>/login</code>, follow its prompts, then <code>/quit</code>.</p>
        <p><code>draken doctor</code> — inspect configuration without a generation request.</p>
      </div>}
    </>}
    {voice && <p><strong>ChatGPT voice: {voice.installed ? 'helper and sign-in configured' : 'setup needed'}</strong></p>}
    {voice && !voice.installed && <div className="setup-commands"><p><code>draken voice setup</code> — install the native helper.</p><p><code>draken voice login</code> — use its separate official ChatGPT sign-in. No pi tokens are copied.</p></div>}
    {(always || firstRun || pi?.state !== 'configured' || !voice?.installed) && <>
      <p className="small muted">Run commands on the server as its user, with the same environment. After login, click Check setup again. Keep the server terminal open; Ctrl+C stops it. <code>draken status</code> checks connectivity.</p>
      <p className="small muted">Choose sources in <strong>Settings → Agents & sessions</strong>, then start a chat or call.</p>
    </>}
    {error && <p className="small" role="alert">{error}</p>}
    <button type="button" className="btn btn-secondary" disabled={checking} onClick={() => setRefresh(current => current + 1)}>{checking ? 'Checking…' : 'Check setup again'}</button>
  </section>;
}
