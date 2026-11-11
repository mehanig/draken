import { getDb } from '../db/schema';
import { Evidence, HomeOverview, ObservedSession, Overview, SyncDetail, SyncModels, SyncSummary, TreeNode, TreeProgress, TreeRun } from '../types';
import { EntryReader } from './source-files';
import { getSessionRoot } from './jsonl';
import { EvidenceReader } from '../db/evidence';
import { cleanText, sourceKey } from './normalize';
import { aggregationCost } from './cost';
import { recapInput, invalidateRecap, type RecapInput } from './recap';
import { admittedAgent, agentSources, AGENTS } from '../sources/registry';

import { HttpError } from '../errors';

import { activity } from './activity';
import { defaultModels } from './models';
const summaryQuery = `SELECT s.id, s.status, s.created_at, s.completed_at, s.briefing, s.decisions, s.carry_forward,
  s.remaining_count, s.snapshot_version, s.snapshot_at,
  COALESCE((SELECT recap FROM sync_presentations WHERE sync_id=s.id), '') AS recap,
  COALESCE((SELECT recap_state FROM sync_presentations WHERE sync_id=s.id), 'empty') AS recap_state,
  COALESCE((SELECT recap_error FROM sync_presentations WHERE sync_id=s.id), '') AS recap_error,
  (SELECT COUNT(*) FROM sync_items i WHERE i.sync_id = s.id) AS item_count FROM syncs s`;
const historyWindow = `e.timestamp >= COALESCE((SELECT value FROM sync_settings WHERE key = 'history_since'), '')`;
const pendingWhere = `e.active = 1 AND e.present = 1 AND e.is_activity = 1 AND e.effective_length > 0
  AND ${historyWindow} AND s.included = 1 AND s.missing = 0 AND ${admittedAgent('s')} AND NOT EXISTS (SELECT 1 FROM sync_coverage c WHERE c.event_key = e.event_key)`;
const availableFilter = (exceptSync = 0) => `${pendingWhere} AND NOT EXISTS (SELECT 1 FROM sync_items i JOIN syncs held ON held.id=i.sync_id WHERE i.event_key=e.event_key AND held.status='open' AND held.id != ${exceptSync})`;
const availableWhere = availableFilter();
const evidenceSelect = `SELECT s.agent,e.id AS source_id, e.event_key, e.session_id, s.name AS session_name, s.path AS source_path,
  s.cwd, e.entry_id, e.timestamp, e.role FROM agent_entries e JOIN agent_sessions s ON s.id = e.session_id`;

export function pendingCount(): number {
  return (getDb().prepare(`SELECT COUNT(DISTINCT e.event_key) AS count FROM agent_entries e
    JOIN agent_sessions s ON s.id = e.session_id WHERE ${pendingWhere}`).get() as { count: number }).count;
}

function historySince(): string | null {
  const row = getDb().prepare("SELECT value FROM sync_settings WHERE key = 'history_since'").get() as { value: string } | undefined;
  return row?.value || null;
}

export function overview(): Overview {
  const db = getDb();
  const sessions = db.prepare(`SELECT s.id, s.agent, COALESCE(s.external_id,s.id) AS external_id, s.path, s.cwd, s.name, s.included, s.missing, s.modified_at,
    (SELECT COUNT(DISTINCT e.event_key) FROM agent_entries e WHERE e.session_id = s.id AND e.active = 1
    AND e.present = 1 AND e.is_activity = 1 AND e.effective_length > 0 AND ${historyWindow}
    AND NOT EXISTS (SELECT 1 FROM sync_coverage c WHERE c.event_key = e.event_key)) AS pending
    FROM agent_sessions s ORDER BY s.modified_at DESC`).all() as ObservedSession[];
  const syncs = (db.prepare(`${summaryQuery} ORDER BY s.id DESC LIMIT 50`).all() as SyncSummary[])
    .map(row => ({ ...row, aggregation_cost: aggregationCost(db, row.id, Boolean(row.briefing)) }));
  const models = defaultModels();
  return {
    agents: agentSources(db), sessions, syncs, pending: pendingCount(), active_sync_id: syncs.find(s => s.status === 'open')?.id || null,
    session_root: getSessionRoot(), model: models.final || 'pi configured default', summary_model: models.summary,
    history_since: historySince(),
    history_initialized: Boolean(db.prepare("SELECT 1 FROM sync_settings WHERE key = 'history_since'").get()),
  };
}

export function availableCount(): number {
  return (getDb().prepare(`SELECT COUNT(DISTINCT e.event_key) AS n FROM agent_entries e JOIN agent_sessions s ON s.id=e.session_id WHERE ${availableWhere}`).get() as { n: number }).n;
}

/** Automatic snapshots are immutable too. A transport request claims one once;
 * any conversation, call or edited notes makes it ineligible for reuse. */
export function automaticSyncId(ready: boolean): number | undefined {
  return (getDb().prepare(`SELECT a.id FROM syncs a JOIN sync_presentations p ON p.sync_id=a.id
    WHERE a.status='open' AND p.request_id LIKE 'auto:%'
    AND a.id=(SELECT MAX(id) FROM syncs WHERE status!='discarded')
    AND ${ready ? "a.briefing!='' AND a.compression_complete=1" : "(a.briefing='' OR a.compression_complete=0)"}
    AND a.decisions='' AND a.carry_forward=COALESCE(json_extract(a.memory_json,'$[0].carry_forward'),'')
    AND NOT EXISTS (SELECT 1 FROM sync_messages m WHERE m.sync_id=a.id)
    AND NOT EXISTS (SELECT 1 FROM live_calls c WHERE c.sync_id=a.id)
    AND NOT EXISTS (SELECT 1 FROM voice_calls c WHERE c.sync_id=a.id)
    ORDER BY a.id DESC LIMIT 1`).get() as { id: number } | undefined)?.id;
}

export function assertAutomaticScope(id: number): void {
  const stale = getDb().prepare(`SELECT 1 FROM sync_items i WHERE i.sync_id=? AND NOT EXISTS (
    SELECT 1 FROM agent_entries e JOIN agent_sessions s ON s.id=e.session_id
    WHERE e.event_key=i.event_key AND ${pendingWhere}) LIMIT 1`).get(id);
  if (stale) throw new HttpError(409, 'Automatic snapshot selection changed. Open or discard that snapshot before preparing another; excluded sources were not summarized.');
}

export function claimAutomaticSync(id: number): void {
  getDb().prepare("UPDATE sync_presentations SET request_id=NULL WHERE sync_id=? AND request_id LIKE 'auto:%'").run(id);
}

export function homeOverview(before?: number): HomeOverview {
  const db = getDb();
  const rows = db.prepare(`${summaryQuery} WHERE s.id < ? ORDER BY s.id DESC LIMIT 21`).all(before || Number.MAX_SAFE_INTEGER) as SyncSummary[];
  const available = availableCount();
  return { syncs: rows.slice(0, 20).map(row => ({ aggregation_cost: aggregationCost(db, row.id, Boolean(row.briefing)), id: row.id, status: row.status, created_at: row.created_at, item_count: row.item_count,
    preview: row.recap || row.briefing.replace(/\[([EC]\d+)\]/g, '').replace(/\s+/g, ' ').slice(0, 600),
    preview_kind: row.recap ? row.recap_state === 'ready' ? 'recap' : 'previous_recap' : row.briefing ? 'briefing' : 'empty', busy: activity.jobActive(row.id), active_call: activity.voiceActive(row.id),
    needs_retry: row.status === 'open' && !row.briefing && ['failed', 'cancelled', 'interrupted'].includes((db.prepare('SELECT status FROM sync_runs WHERE sync_id=? ORDER BY id DESC LIMIT 1').get(row.id) as any)?.status),
    calls: (db.prepare('SELECT (SELECT COUNT(*) FROM voice_calls WHERE sync_id=?) + (SELECT COUNT(*) FROM live_calls WHERE sync_id=?) AS n').get(row.id, row.id) as any).n })),
    available, included_unreviewed: pendingCount() - available,
    covered: (db.prepare('SELECT COUNT(*) AS n FROM sync_coverage').get() as any).n,
    busy: activity.foregroundBusy, active_call: activity.callActive, next_cursor: rows.length > 20 ? rows[19].id : null };
}

export function setAgentEnabled(agent: string, enabled: boolean): Overview {
  if (!AGENTS.some(value => value === agent)) throw new HttpError(404, 'Unknown agent source');
  getDb().prepare('UPDATE agent_sources SET enabled=? WHERE id=?').run(Number(enabled), agent);
  return overview();
}

export function setIncluded(sessionId: string, included: boolean): void {
  const result = getDb().prepare('UPDATE agent_sessions SET included = ? WHERE id = ?').run(Number(included), sessionId);
  if (!result.changes) throw new HttpError(404, 'Session not found');
}

export function getProgress(id: number): TreeProgress {
  const db = getDb();
  const sync = db.prepare('SELECT compression_complete FROM syncs WHERE id = ?').get(id) as { compression_complete: number } | undefined;
  if (!sync) throw new HttpError(404, 'Sync not found');
  const run = db.prepare(`SELECT id, status, stage, summary_model, final_model, invocations, max_invocations,
    processed_entries, total_entries, cache_hits, error, question, request_id, started_at, completed_at, metrics_json
    FROM sync_runs WHERE sync_id = ? ORDER BY id DESC LIMIT 1`).get(id) as (Omit<TreeRun, 'metrics'> & { metrics_json: string }) | undefined;
  const nodes = (db.prepare('SELECT key, kind, label, status, children_json, source_count, error FROM sync_tree_nodes WHERE sync_id = ? ORDER BY rowid').all(id) as any[])
    .map(({ children_json, ...node }) => ({ ...node, children: JSON.parse(children_json) })) as TreeNode[];
  const { metrics_json, ...fields } = run || { metrics_json: '[]' };
  return { busy: activity.jobActive(id), complete: Boolean(sync.compression_complete),
    run: run ? { ...fields, metrics: JSON.parse(metrics_json) } as TreeRun : null, nodes };
}

export function getSync(id: number): SyncDetail {
  const db = getDb();
  const row = db.prepare(`${summaryQuery} WHERE s.id = ?`).get(id) as SyncSummary | undefined;
  if (!row) throw new HttpError(404, 'Sync not found');
  const extra = db.prepare('SELECT context_json, memory_json, model_config_json FROM syncs WHERE id = ?').get(id) as any;
  const reader = new EvidenceReader(db);
  try {
    const items = (db.prepare('SELECT evidence_json FROM sync_items WHERE sync_id = ? ORDER BY rowid').all(id) as any[]).map(item => reader.read(item.evidence_json, true));
    return {
      ...row, aggregation_cost: aggregationCost(db, id, Boolean(row.briefing)), items, context: JSON.parse(extra.context_json).map((item: Record<string, any>) => reader.read(item, true)), memory: JSON.parse(extra.memory_json),
      messages: db.prepare('SELECT id, role, content, created_at FROM sync_messages WHERE sync_id = ? ORDER BY id').all(id) as SyncDetail['messages'],
      busy: activity.jobActive(id), history_since: historySince(),
      models: { ...defaultModels(), ...JSON.parse(extra.model_config_json) }, tree: getProgress(id),
    };
  } finally { reader.close(); }
}

export function assertEvidenceAvailable(sync: SyncDetail): void {
  if ([...sync.items, ...sync.context].some(item => item.unavailable)) throw new HttpError(409, 'Original session evidence is unavailable or changed. Restore the session files before summarizing, calling or marking this snapshot reviewed. Conversation and notes remain accessible.');
}

export function requireOpen(id: number, allowBusy = false): SyncDetail {
  const sync = getSync(id);
  if (sync.status !== 'open') throw new HttpError(409, 'This sync is already closed');
  if (!allowBusy && sync.busy) throw new HttpError(409, 'A reply is still being generated. Wait or cancel before changing this sync.');
  if (!allowBusy && activity.voiceActive(id)) throw new HttpError(409, 'End the voice call before changing this sync.');
  return sync;
}

/** No LIMIT: the snapshot contains ALL eligible entries. Inference, not coverage, is chunked. */
function snapshot(previous?: SyncDetail): { items: Evidence[]; context: Evidence[] } {
  const db = getDb();
  const old = new Map(previous?.items.map(item => [item.event_key, item]) || []);
  let nextRef = Math.max(0, ...[...(previous?.items || []), ...(previous?.context || [])]
    .map(item => item.ref.startsWith('E') ? Number(item.ref.slice(1)) : 0)) + 1;
  const items: Evidence[] = [];
  const seen = new Set<string>();
  const firstBySession = new Map<string, number>();
  const reader = new EntryReader(db);
  try {
  for (const row of db.prepare(`${evidenceSelect} WHERE ${availableFilter(previous?.id)} ORDER BY e.timestamp, e.id`).iterate() as Iterable<Evidence & { source_id: number }>) {
    if (seen.has(row.event_key)) continue;
    const { source_id, ...metadata } = row;
    const data = { ...metadata, text: reader.effective(source_id) };
    const prior = old.get(row.event_key);
    const same = prior && prior.text === data.text;
    items.push({ ...data, sequence: source_id, ref: same ? prior.ref : `E${nextRef++}` });
    seen.add(row.event_key);
    firstBySession.set(row.session_id, Math.min(firstBySession.get(row.session_id) ?? Infinity, source_id));
  }
  // Preserve evidence behind old conversation citations, but don't treat obsolete branch evidence as new work.
  const current = new Set(items.map(sourceKey));
  const context = [...(previous?.context || []), ...(previous?.items || [])].filter(item => !current.has(sourceKey(item)));
  const contextKeys = new Set(context.map(sourceKey));
  let contextChars = 0;
  let nextContext = Math.max(0, ...context.map(item => item.ref.startsWith('C') ? Number(item.ref.slice(1)) : 0)) + 1;
  for (const [sessionId, firstId] of firstBySession) {
    const prior = db.prepare(`${evidenceSelect} WHERE e.session_id = ? AND e.active = 1 AND e.present = 1
      AND e.id < ? AND e.effective_length > 0 ORDER BY e.id DESC LIMIT 6`).all(sessionId, firstId) as (Evidence & { source_id: number })[];
    for (const row of prior.reverse()) {
      if (seen.has(row.event_key)) continue;
      const { source_id, ...metadata } = row;
      const item = { ...metadata, ref: `C${nextContext}`, text: cleanText(reader.effective(source_id), 2000) };
      if (contextKeys.has(sourceKey(item))) continue;
      nextContext++;
      const cost = JSON.stringify(item).length;
      if (contextChars + cost > 24000) break;
      context.push(item);
      contextKeys.add(sourceKey(item));
      contextChars += cost;
    }
  }
  return { items, context };
  } finally { reader.close(); }
}

function frozenContext(db: ReturnType<typeof getDb>, items: Evidence[]): string {
  const reader = new EvidenceReader(db);
  try { return JSON.stringify(items.map(item => JSON.parse(reader.freeze(item)))); } finally { reader.close(); }
}

function persistItems(id: number, items: Evidence[]): void {
  const insert = getDb().prepare('INSERT INTO sync_items(sync_id, event_key, evidence_json) VALUES (?, ?, ?)');
  const reader = new EvidenceReader(getDb());
  try { for (const item of items) insert.run(id, item.event_key, reader.freeze(item)); } finally { reader.close(); }
}

export function startSync(since?: string | null): SyncDetail {
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare("SELECT id FROM syncs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    if (existing) return getSync(existing.id);
    if (!db.prepare("SELECT 1 FROM sync_settings WHERE key = 'history_since'").get()) {
      const parsed = since ? new Date(since) : null;
      if (parsed && (!Number.isFinite(parsed.getTime()) || parsed.getTime() > Date.now())) throw new HttpError(400, 'The initial history start must be a valid date in the past');
      const hasCompleted = db.prepare("SELECT 1 FROM syncs WHERE status = 'completed' LIMIT 1").get();
      db.prepare("INSERT INTO sync_settings(key, value) VALUES ('history_since', ?)").run(hasCompleted ? '' : parsed?.toISOString() || '');
    }
    const { items, context } = snapshot();
    const memory = db.prepare(`SELECT id AS sync_id, decisions, carry_forward FROM syncs
      WHERE status = 'completed' ORDER BY id DESC LIMIT 10`).all() as SyncDetail['memory'];
    const now = new Date().toISOString();
    const result = db.prepare(`INSERT INTO syncs(created_at, snapshot_at, snapshot_version, context_json, memory_json, carry_forward)
      VALUES (?, ?, 2, ?, ?, ?)`).run(now, now, frozenContext(db, context), JSON.stringify(memory), memory[0]?.carry_forward || '');
    const id = Number(result.lastInsertRowid);
    persistItems(id, items);
    return getSync(id);
  })();
}

/** New one-click workflow: reserve previously unassigned entries, never review them.
 * Repeated transport requests reuse the same immutable snapshot. */
export function startConversationSync(requestId: string, automatic = false): SyncDetail {
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare('SELECT sync_id FROM sync_presentations WHERE request_id=?').get(requestId) as { sync_id: number } | undefined;
    if (existing) return getSync(existing.sync_id);
    if (activity.callActive || activity.busy) throw new HttpError(409, 'End the active call or wait for preparation before starting another sync.');
    if (!automatic) {
      const prepared = automaticSyncId(false) ?? (availableCount() === 0 ? automaticSyncId(true) : undefined);
      if (prepared !== undefined) {
        assertAutomaticScope(prepared);
        const sync = getSync(prepared); assertEvidenceAvailable(sync);
        db.prepare("UPDATE sync_presentations SET request_id=NULL WHERE request_id LIKE 'auto:%'").run();
        db.prepare('UPDATE sync_presentations SET request_id=? WHERE sync_id=?').run(requestId, prepared);
        return sync;
      }
      // Prior automatic batches now become historical context for this user's
      // new snapshot, not candidates to reopen on a later Home action.
      db.prepare("UPDATE sync_presentations SET request_id=NULL WHERE request_id LIKE 'auto:%'").run();
    }
    db.prepare("INSERT OR IGNORE INTO sync_settings(key,value) VALUES ('history_since','')").run();
    const prior = (db.prepare("SELECT id FROM syncs WHERE status != 'discarded' ORDER BY id DESC LIMIT 3").all() as { id: number }[]).map(row => getSync(row.id));
    const inputs: RecapInput[] = prior.map(recapInput);
    const memory = prior.map(item => ({ sync_id: item.id, status: item.status, snapshot_at: item.snapshot_at, decisions: item.decisions, carry_forward: item.carry_forward, recap: item.recap }));
    const { items, context } = snapshot(), now = new Date().toISOString();
    const result = db.prepare(`INSERT INTO syncs(created_at,snapshot_at,snapshot_version,context_json,memory_json,carry_forward,model_config_json)
      VALUES (?,?,2,?,?,?,?)`).run(now, now, frozenContext(db, context), JSON.stringify(memory), memory[0]?.carry_forward || '', JSON.stringify(defaultModels()));
    const id = Number(result.lastInsertRowid); persistItems(id, items);
    db.prepare('INSERT INTO sync_presentations(sync_id,request_id,memory_inputs_json) VALUES (?,?,?)').run(id, requestId, JSON.stringify(inputs));
    return getSync(id);
  })();
}

function archiveBriefing(sync: SyncDetail, reason: string): void {
  if (sync.briefing) getDb().prepare('INSERT INTO sync_messages(sync_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(sync.id, 'assistant', `[Historical briefing — superseded: ${reason}]\n${sync.briefing}`, new Date().toISOString());
  getDb().prepare("UPDATE syncs SET briefing = '', compression_complete = 0 WHERE id = ?").run(sync.id);
}

export function expandSnapshot(id: number): SyncDetail {
  const db = getDb();
  return db.transaction(() => {
    const sync = requireOpen(id);
    if (sync.snapshot_version >= 2) throw new HttpError(409, 'This is already a full frozen snapshot. Later arrivals belong in the next sync.');
    assertEvidenceAvailable(sync);
    const { items, context } = snapshot(sync);
    archiveBriefing(sync, 'the old partial snapshot was expanded; later evidence may change its conclusions');
    db.prepare('DELETE FROM sync_items WHERE sync_id = ?').run(id);
    persistItems(id, items);
    db.prepare('UPDATE syncs SET snapshot_version = 2, snapshot_at = ?, context_json = ?, remaining_count = 0 WHERE id = ?')
      .run(new Date().toISOString(), frozenContext(db, context), id);
    return getSync(id);
  })();
}

export function configureModels(id: number, models: SyncModels): SyncDetail {
  const sync = requireOpen(id);
  for (const model of [models.summary, models.final]) {
    if (typeof model !== 'string' || (model !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9._/:+@-]{0,199}$/.test(model))) throw new HttpError(400, 'Use a pi provider/model selector, not a shell command');
  }
  if (!models.summary) throw new HttpError(400, 'Choose a summary model explicitly; there is no silent expensive-model fallback');
  if (!Number.isInteger(models.max_invocations) || models.max_invocations < 1 || models.max_invocations > 500) throw new HttpError(400, 'The invocation limit must be between 1 and 500');
  getDb().transaction(() => {
    if (sync.models.summary !== models.summary || sync.models.final !== models.final) archiveBriefing(sync, 'model selection changed');
    getDb().prepare('UPDATE syncs SET model_config_json = ? WHERE id = ?').run(JSON.stringify(models), id);
  })();
  return getSync(id);
}

export function getTreeNode(id: number, key: string) {
  const node = getDb().prepare(`SELECT n.kind, n.label, c.output_json FROM sync_tree_nodes n
    JOIN summary_cache c ON c.key = n.key WHERE n.sync_id = ? AND n.key = ?`).get(id, key) as any;
  if (!node) throw new HttpError(404, 'Completed summary node not found');
  const sync = getSync(id);
  return { kind: node.kind, label: node.label, output: JSON.parse(node.output_json),
    refs: Object.fromEntries([...sync.items, ...sync.context].map(item => [sourceKey(item), item.ref])) };
}

export function recoverInterruptedRuns(): void {
  getDb().prepare("UPDATE sync_presentations SET recap_state='failed',recap_error='Recap interrupted by restart. Retry to reuse cached fragments.' WHERE recap_state='running'").run();
  getDb().prepare("UPDATE sync_runs SET status = 'interrupted', error = 'Server restarted. Retry to reuse completed summaries.', completed_at = ? WHERE status = 'running'")
    .run(new Date().toISOString());
}

export function saveNotes(id: number, decisions: string, carryForward: string): SyncDetail {
  requireOpen(id);
  invalidateRecap(id);
  getDb().prepare('UPDATE syncs SET decisions = ?, carry_forward = ? WHERE id = ?').run(decisions, carryForward, id);
  return getSync(id);
}

export function completeSync(id: number, decisions: string, carryForward: string, reviewed: boolean): SyncDetail {
  const db = getDb();
  return db.transaction(() => {
    const sync = requireOpen(id);
    if (!reviewed) throw new HttpError(400, 'Confirm you reviewed this snapshot before finishing the sync');
    assertEvidenceAvailable(sync);
    if (sync.tree.run && !sync.tree.complete) throw new HttpError(409, 'Compression or the final verdict is incomplete. Retry or discard; failed work cannot advance coverage.');
    if (sync.decisions !== decisions || sync.carry_forward !== carryForward) invalidateRecap(id);
    db.prepare(`UPDATE syncs SET status = 'completed', completed_at = ?, decisions = ?, carry_forward = ? WHERE id = ?`)
      .run(new Date().toISOString(), decisions, carryForward, id);
    db.prepare('INSERT OR IGNORE INTO sync_coverage(event_key, sync_id) SELECT event_key, sync_id FROM sync_items WHERE sync_id = ?').run(id);
    return getSync(id);
  })();
}

export function discardSync(id: number): SyncDetail {
  requireOpen(id);
  getDb().prepare("UPDATE syncs SET status = 'discarded', completed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return getSync(id);
}
