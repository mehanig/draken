import { useEffect, useState } from 'react';
import { ArrowRight, Check, ChevronRight, Clock3, FolderOpen, MessageSquare, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../api';
import type { Overview, SyncDetail } from '../types';
import { CitedText, EvidenceList } from '../components/EvidenceList';
import { SummaryTree } from '../components/SummaryTree';

const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Sync() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [sync, setSync] = useState<SyncDetail | null>(null);
  const [work, setWork] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [decisions, setDecisions] = useState('');
  const [carry, setCarry] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [initialWindow, setInitialWindow] = useState('24');
  const [summaryModel, setSummaryModel] = useState('');
  const [finalModel, setFinalModel] = useState('');
  const [maxInvocations, setMaxInvocations] = useState(120);

  const showSync = (value: SyncDetail) => {
    setSync(value); setDecisions(value.decisions); setCarry(value.carry_forward);
    setSummaryModel(value.models.summary); setFinalModel(value.models.final); setMaxInvocations(value.models.max_invocations);
  };
  const refresh = async () => { const value = await api.overview(); setOverview(value); return value; };
  const run = async (label: string, fn: () => Promise<void>) => {
    setWork(label); setError(''); setNotice('');
    try { await fn(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setWork(''); }
  };
  useEffect(() => {
    let alive = true;
    api.overview().then(async value => {
      if (!alive) return;
      setOverview(value);
      if (value.active_sync_id) {
        const current = await api.sync(value.active_sync_id);
        if (alive) showSync(current);
      }
    }).catch(err => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, []);

  // Poll only compact progress, not the potentially large frozen evidence payload.
  useEffect(() => {
    if (!sync?.busy) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const progress = await api.progress(sync.id);
        if (!alive) return;
        if (progress.busy) setSync(current => current?.id === sync.id ? { ...current, tree: progress } : current);
        else {
          const current = await api.sync(sync.id);
          if (!alive) return;
          showSync(current);
          if (progress.run?.status === 'completed') setQuestion(value => value === progress.run?.question ? '' : value);
          await refresh();
          return;
        }
      } catch (err) { if (alive) setError(err instanceof Error ? err.message : 'Could not refresh progress'); }
      if (alive) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [sync?.id, sync?.busy]);

  const disabled = Boolean(work || sync?.busy);
  const open = sync?.status === 'open';
  const modelsDirty = Boolean(sync && (summaryModel !== sync.models.summary || finalModel !== sync.models.final || maxInvocations !== sync.models.max_invocations));
  const dirty = Boolean(sync && (decisions !== sync.decisions || carry !== sync.carry_forward || modelsDirty));
  const canGenerate = Boolean(summaryModel.trim() && Number.isInteger(maxInvocations) && maxInvocations >= 1 && maxInvocations <= 500 && sync?.snapshot_version === 2);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const selectSync = (id: number) => {
    if (dirty && !window.confirm('Leave without saving your notes?')) return;
    void run('Opening sync', async () => {
      showSync(await api.sync(id)); setReviewed(false); setQuestion('');
    });
  };
  const scan = () => void run('Reading local sessions', async () => {
    const result = await api.scan(); setWarnings(result.warnings); await refresh();
    setNotice(`Scanned ${result.files} files · ${result.added} new entries indexed. Nothing was sent to a model.`);
  });
  const start = () => void run('Preparing snapshot', async () => {
    const since = overview?.history_initialized ? undefined : initialWindow === 'all' ? null
      : new Date(Date.now() - Number(initialWindow) * 60 * 60 * 1000).toISOString();
    const result = await api.start(since); showSync(result.sync); setWarnings(result.scan.warnings);
    setReviewed(false); await refresh();
  });
  const saveModels = (id: number) => api.models(id, { summary: summaryModel.trim(), final: finalModel.trim(), max_invocations: maxInvocations });
  const generate = () => void run('Starting summary tree', async () => {
    if (!sync) return;
    await api.notes(sync.id, decisions, carry);
    await saveModels(sync.id);
    showSync(await api.brief(sync.id)); await refresh();
  });
  const discuss = (message = question) => void run('Starting discussion', async () => {
    if (!sync) return;
    await api.notes(sync.id, decisions, carry);
    await saveModels(sync.id);
    showSync(await api.discuss(sync.id, message));
  });
  const resume = () => sync?.tree.run?.question ? discuss(sync.tree.run.question) : generate();
  const evidence = sync ? [...sync.items, ...sync.context] : [];
  const workspaces = new Set(overview?.sessions.filter(s => s.included && !s.missing).map(s => s.cwd));
  const latest = overview?.syncs.find(s => s.status === 'completed');

  return <div className="sync-layout">
    <aside className="sidebar">
      <div className="section-heading"><h2>Session sources</h2><button className="icon-button" disabled={disabled} onClick={scan} aria-label="Scan sessions"><RefreshCw size={17} /></button></div>
      <p className="muted small">Read-only access to local pi history. Select which sessions belong in your next sync.</p>
      <code className="source-path">{overview?.session_root || 'Loading…'}</code>
      <div className="session-list">
        {overview?.sessions.map(session => <label className={`session-source ${session.missing ? 'missing' : ''}`} key={session.id}>
          <input type="checkbox" checked={Boolean(session.included)} disabled={disabled || Boolean(session.missing) || Boolean(open)} onChange={event => {
            const included = event.target.checked;
            void run('Updating sources', async () => setOverview(await api.include(session.id, included)));
          }} />
          <span><strong>{session.name || session.cwd.split('/').filter(Boolean).pop() || session.id.slice(0, 8)}</strong>
            <span className="source-cwd" title={session.cwd}>{session.cwd}</span>
            <span className="small muted">{session.id.slice(0, 8)} · {session.missing ? 'source unavailable' : `${session.pending} uncovered entries`}</span>
          </span>
        </label>)}
        {overview && !overview.sessions.length && <div className="empty-sidebar"><FolderOpen size={25} /><p>No sessions indexed yet.</p><button className="btn btn-secondary" onClick={scan} disabled={disabled}>Scan local sessions</button></div>}
      </div>
      {open && <p className="muted small">This sync is frozen. Finish or discard it before changing sources.</p>}
      <div className="section-heading history-heading"><h2>Previous syncs</h2><Clock3 size={16} /></div>
      <div className="history-list">{overview?.syncs.map(item => <button key={item.id} disabled={disabled} className={`history-item ${sync?.id === item.id ? 'selected' : ''}`} onClick={() => selectSync(item.id)}>
        <span><strong>Sync #{item.id}</strong><span className="small muted">{date(item.created_at)}</span></span>
        <span className={`status ${item.status}`}>{item.status}</span>
      </button>)}</div>
      {!overview?.syncs.length && <p className="muted small">Your first conversation starts here.</p>}
    </aside>

    <main className="sync-main">
      <div className="page-heading"><div><span className="eyebrow">YOUR ENGINEERING SYNC</span><h1>Pick up where you left off.</h1>
        <p className="muted">{latest ? `Last completed sync: ${date(latest.completed_at!)}` : 'Across sessions. Across projects. One conversation.'}</p></div>
        {(!open || overview?.active_sync_id !== sync?.id) && <button className="btn btn-primary" disabled={disabled || !overview} onClick={() => {
          if (overview?.active_sync_id) selectSync(overview.active_sync_id); else start();
        }}>{overview?.active_sync_id ? 'Resume sync' : 'Start sync'}<ArrowRight size={17} /></button>}
      </div>
      <div className="stats"><span><strong>{overview?.pending ?? '—'}</strong> uncovered entries</span><span><strong>{workspaces.size}</strong> workspaces</span><span className="local-badge"><span /> Local-first · read-only</span></div>
      {overview && !overview.history_initialized && !open && <div className="initial-window">
        <label htmlFor="initial-window">Start your first sync from</label>
        <select id="initial-window" value={initialWindow} disabled={disabled} onChange={e => setInitialWindow(e.target.value)}>
          <option value="24">The last 24 hours</option><option value="168">The last 7 days</option><option value="all">All indexed history</option>
        </select>
        <p className="muted small">This sets a fixed starting point. Older entries won’t be treated as new work, but may appear as background. Later syncs use uncovered activity after that starting point.</p>
      </div>}
      {overview?.history_initialized && <p className="muted small">History starts {overview.history_since ? date(overview.history_since) : 'at the beginning of indexed sessions'}. This baseline does not move between syncs.</p>}
      {error && <div className="alert error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {notice && <div className="alert success" role="status">{notice}</div>}
      {warnings.length > 0 && <details className="alert warning"><summary>{warnings.length} indexing warning{warnings.length !== 1 ? 's' : ''}</summary><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      {disabled && <div className="working" role="status"><span className="spinner" />{work || 'A reply is being generated. You can leave and resume this sync.'}</div>}

      {!sync && <section className="card welcome">
        <div className="welcome-symbol"><MessageSquare size={32} /></div><h2>What happened since we last talked?</h2>
        <p>Draken reads your pi sessions, brings the evidence together, and helps you separate progress from unfinished work.</p>
        <div className="steps"><span><b>01</b> Scan & select sessions</span><ChevronRight size={15} /><span><b>02</b> Review & discuss</span><ChevronRight size={15} /><span><b>03</b> Save decisions</span></div>
        <p className="muted small">Choose your first-sync window above. All eligible history enters one snapshot; a cheaper model builds a summary tree before the final verdict. No model calls happen while scanning.</p>
        <button className="btn btn-primary" disabled={disabled || !overview} onClick={start}>Prepare first sync <ArrowRight size={16} /></button>
      </section>}

      {sync && <>
        <section className="card briefing-card">
          <div className="section-heading"><h2>Sync #{sync.id} <span className={`status ${sync.status}`}>{sync.status}</span></h2><span className="muted small">Snapshot · {date(sync.snapshot_at)}</span></div>
          <p className="muted small">{sync.items.length} new evidence entries · {new Set(sync.items.map(item => item.session_id)).size} sessions. Activity arriving after this snapshot belongs to a later sync.</p>
          {sync.snapshot_version < 2 && <div className="alert warning">This is an old capped snapshot: {sync.remaining_count} entries were left out. Its briefing may describe outdated plans rather than later outcomes.
            {open && <p><button className="btn btn-secondary" disabled={disabled} onClick={() => {
              if (!window.confirm('Expand to all currently eligible history? Notes and discussion are kept, the old briefing is archived, and existing evidence references remain available. This performs no model calls.')) return;
              void run('Expanding snapshot', async () => {
                await api.notes(sync.id, decisions, carry);
                const result = await api.expand(sync.id); showSync(result.sync); setWarnings(result.scan.warnings);
                setReviewed(false); await refresh();
              });
            }}>Expand to full history</button></p>}
          </div>}
          {sync.briefing ? <CitedText text={sync.briefing} evidence={evidence} /> : <div className="briefing-placeholder"><Sparkles size={25} /><h3>Your evidence is ready.</h3><p>Inspect the source excerpts below, then ask Draken for a briefing. You can also review and finish without a model.</p></div>}
          {open && <div className="model-settings">
            <div className="model-grid">
              <div><label htmlFor="summary-model">Cheap model · parsing and merging</label><input id="summary-model" className="input" value={summaryModel} disabled={disabled} onChange={e => setSummaryModel(e.target.value)} placeholder="provider/model — required" /></div>
              <div><label htmlFor="final-model">Stronger model · final verdict</label><input id="final-model" className="input" value={finalModel} disabled={disabled} onChange={e => setFinalModel(e.target.value)} placeholder="Leave blank for pi’s configured default" /></div>
              <div><label htmlFor="invocation-limit">Maximum pi invocations per run</label><input id="invocation-limit" className="input" type="number" min={1} max={500} value={maxInvocations} disabled={disabled} onChange={e => setMaxInvocations(Number(e.target.value))} /></div>
            </div>
            <p className="muted small">Generate, Resume, and Ask use these models through pi. Completed summaries are cached and reused.</p>
            {(!sync.briefing || modelsDirty) && <button className="btn btn-primary" disabled={disabled || !canGenerate} onClick={generate}><Sparkles size={16} />Generate briefing</button>}
          </div>}
        </section>

        <SummaryTree key={sync.id} syncId={sync.id} progress={sync.tree} evidence={evidence} onResume={open ? resume : undefined} resumeEnabled={!disabled && canGenerate} onCancel={() => void run('Cancelling generation', async () => { await api.cancel(sync.id); })} />

        {(sync.messages.length > 0 || open) && <section className="card discussion"><h2>Talk it through</h2>
          {sync.messages.map(message => <div className={`message ${message.role}`} key={message.id}><span className="message-author">{message.role === 'user' ? 'You' : 'Draken'}</span><CitedText text={message.content} evidence={evidence} /></div>)}
          {open && <form onSubmit={e => { e.preventDefault(); discuss(); }}><label htmlFor="question" className="sr-only">Ask Draken about this sync</label>
            <textarea id="question" rows={3} maxLength={4000} placeholder="What is still blocked? Did we actually validate that change?" value={question} disabled={disabled} onChange={e => setQuestion(e.target.value)} />
            <div className="form-footer"><span className="muted small">Answers stay attached to this sync.</span><button className="btn btn-primary" disabled={disabled || !canGenerate || !question.trim()}>Ask Draken <ArrowRight size={16} /></button></div></form>}
        </section>}

        <section className="card notes-card"><div className="section-heading"><h2>What we’re taking away</h2>{dirty && <span className="small unsaved">Unsaved changes</span>}</div>
          <div className="notes-grid"><div><label htmlFor="decisions">Decisions</label><textarea id="decisions" rows={5} maxLength={4000} disabled={!open || disabled} value={decisions} onChange={e => setDecisions(e.target.value)} placeholder="What did we agree? Priorities, choices, things not to do…" /></div>
            <div><label htmlFor="carry-forward">Carry into the next sync</label><textarea id="carry-forward" rows={5} maxLength={4000} disabled={!open || disabled} value={carry} onChange={e => setCarry(e.target.value)} placeholder="Open questions, blockers, deferred topics. Remove resolved items." /></div></div>
          <p className="muted small">These are your notes, not automatic model conclusions. Carry-forward items persist until you remove them; the manager also receives decisions from the last 10 completed syncs.</p>
          {open && <div className="finish-controls"><button className="btn btn-secondary" disabled={disabled || !dirty} onClick={() => void run('Saving notes', async () => { await api.notes(sync.id, decisions, carry); if (modelsDirty) await saveModels(sync.id); showSync(await api.sync(sync.id)); setNotice('Notes saved. Coverage has not advanced.'); })}>Save notes</button>
            <label className="check-row"><input type="checkbox" checked={reviewed} disabled={disabled} onChange={e => setReviewed(e.target.checked)} /><span>I reviewed this snapshot. Mark its {sync.items.length} entries covered when I finish.</span></label>
            <div className="finish-actions"><button className="btn btn-ghost" disabled={disabled} onClick={() => {
              if (window.confirm('Discard this sync? Its entries remain uncovered. The discarded snapshot stays in history.')) void run('Discarding sync', async () => { showSync(await api.discard(sync.id)); await refresh(); });
            }}>Discard sync</button><button className="btn btn-primary" disabled={disabled || !reviewed || Boolean(sync.tree.run && !sync.tree.complete)} onClick={() => void run('Finishing sync', async () => {
              showSync(await api.finish(sync.id, decisions, carry)); await refresh(); setReviewed(false); setNotice('Sync saved. Activity arriving after this snapshot remains for next time.');
            })}><Check size={17} />Finish sync</button></div>
          </div>}
        </section>
        {sync.memory.length > 0 && <details className="memory-panel"><summary>Memory from previous syncs</summary>{sync.memory.map((item, index) => <div key={item.sync_id}><h4>Sync #{item.sync_id}{index === 0 ? ' · most recent' : ''}</h4><p className="prose">{item.decisions || 'No decisions recorded.'}</p>{index === 0 && <p className="prose muted">Carried forward: {item.carry_forward || 'Nothing recorded.'}</p>}</div>)}</details>}
        <EvidenceList key={`new-${sync.id}`} items={sync.items} title="New evidence in this snapshot" />
        <EvidenceList key={`context-${sync.id}`} items={sync.context} title="Earlier context — not new progress" />
      </>}
    </main>
  </div>;
}
