import { getDb } from '../db/schema';
import { Evidence, ObservedSession, Overview, SyncDetail, SyncModels, SyncSummary, TreeNode, TreeProgress, TreeRun } from '../types';
import { getSessionRoot } from './collector';
import { cleanText, sourceKey } from './normalize';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const busySyncs = new Set<number>();
const summaryQuery = `SELECT s.id, s.status, s.created_at, s.completed_at, s.briefing, s.decisions, s.carry_forward,
  s.remaining_count, s.snapshot_version, s.snapshot_at,
  (SELECT COUNT(*) FROM sync_items i WHERE i.sync_id = s.id) AS item_count FROM syncs s`;
const historyWindow = `e.timestamp >= COALESCE((SELECT value FROM sync_settings WHERE key = 'history_since'), '')`;
const pendingWhere = `e.active = 1 AND e.present = 1 AND e.is_activity = 1 AND e.effective_text != ''
  AND ${historyWindow} AND s.included = 1 AND s.missing = 0 AND NOT EXISTS (SELECT 1 FROM sync_coverage c WHERE c.event_key = e.event_key)`;
const evidenceSelect = `SELECT e.id AS source_id, e.event_key, e.session_id, s.name AS session_name, s.path AS source_path,
  s.cwd, e.entry_id, e.timestamp, e.role, e.effective_text AS text FROM pi_entries e JOIN pi_sessions s ON s.id = e.session_id`;

export function defaultModels(): SyncModels {
  const limit = Number(process.env.DRAKEN_PI_MAX_INVOCATIONS || 120);
  return {
    summary: process.env.DRAKEN_PI_SUMMARY_MODEL || 'openai/gpt-6-luna',
    final: process.env.DRAKEN_PI_FINAL_MODEL || process.env.DRAKEN_PI_MODEL || 'openai/gpt-6-astra',
    max_invocations: Number.isInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 120,
  };
}

export function pendingCount(): number {
  return (getDb().prepare(`SELECT COUNT(DISTINCT e.event_key) AS count FROM pi_entries e
    JOIN pi_sessions s ON s.id = e.session_id WHERE ${pendingWhere}`).get() as { count: number }).count;
}

function historySince(): string | null {
  const row = getDb().prepare("SELECT value FROM sync_settings WHERE key = 'history_since'").get() as { value: string } | undefined;
  return row?.value || null;
}

export function overview(): Overview {
  const db = getDb();
  const sessions = db.prepare(`SELECT s.id, s.path, s.cwd, s.name, s.included, s.missing, s.modified_at,
    (SELECT COUNT(DISTINCT e.event_key) FROM pi_entries e WHERE e.session_id = s.id AND e.active = 1
    AND e.present = 1 AND e.is_activity = 1 AND e.effective_text != '' AND ${historyWindow}
    AND NOT EXISTS (SELECT 1 FROM sync_coverage c WHERE c.event_key = e.event_key)) AS pending
    FROM pi_sessions s ORDER BY s.modified_at DESC`).all() as ObservedSession[];
  const syncs = db.prepare(`${summaryQuery} ORDER BY s.id DESC LIMIT 50`).all() as SyncSummary[];
  const models = defaultModels();
  return {
    sessions, syncs, pending: pendingCount(), active_sync_id: syncs.find(s => s.status === 'open')?.id || null,
    session_root: getSessionRoot(), model: models.final || 'pi configured default', summary_model: models.summary,
    history_since: historySince(),
    history_initialized: Boolean(db.prepare("SELECT 1 FROM sync_settings WHERE key = 'history_since'").get()),
  };
}

export function setIncluded(sessionId: string, included: boolean): void {
  const result = getDb().prepare('UPDATE pi_sessions SET included = ? WHERE id = ?').run(Number(included), sessionId);
  if (!result.changes) throw new HttpError(404, 'Session not found');
}

export function getProgress(id: number): TreeProgress {
  const db = getDb();
  const sync = db.prepare('SELECT compression_complete FROM syncs WHERE id = ?').get(id) as { compression_complete: number } | undefined;
  if (!sync) throw new HttpError(404, 'Sync not found');
  const run = db.prepare(`SELECT id, status, stage, summary_model, final_model, invocations, max_invocations,
    processed_entries, total_entries, cache_hits, error, question, started_at, completed_at
    FROM sync_runs WHERE sync_id = ? ORDER BY id DESC LIMIT 1`).get(id) as TreeRun | undefined;
  const nodes = (db.prepare('SELECT key, kind, label, status, children_json, source_count, error FROM sync_tree_nodes WHERE sync_id = ? ORDER BY rowid').all(id) as any[])
    .map(({ children_json, ...node }) => ({ ...node, children: JSON.parse(children_json) })) as TreeNode[];
  return { busy: busySyncs.has(id), complete: Boolean(sync.compression_complete), run: run || null, nodes };
}

export function getSync(id: number): SyncDetail {
  const db = getDb();
  const row = db.prepare(`${summaryQuery} WHERE s.id = ?`).get(id) as SyncSummary | undefined;
  if (!row) throw new HttpError(404, 'Sync not found');
  const extra = db.prepare('SELECT context_json, memory_json, model_config_json FROM syncs WHERE id = ?').get(id) as any;
  const items = (db.prepare('SELECT evidence_json FROM sync_items WHERE sync_id = ? ORDER BY rowid').all(id) as any[])
    .map(item => JSON.parse(item.evidence_json));
  return {
    ...row, items, context: JSON.parse(extra.context_json), memory: JSON.parse(extra.memory_json),
    messages: db.prepare('SELECT id, role, content, created_at FROM sync_messages WHERE sync_id = ? ORDER BY id').all(id) as SyncDetail['messages'],
    busy: busySyncs.has(id), history_since: historySince(),
    models: { ...defaultModels(), ...JSON.parse(extra.model_config_json) }, tree: getProgress(id),
  };
}

export function requireOpen(id: number, allowBusy = false): SyncDetail {
  const sync = getSync(id);
  if (sync.status !== 'open') throw new HttpError(409, 'This sync is already closed');
  if (!allowBusy && sync.busy) throw new HttpError(409, 'A reply is still being generated. Wait or cancel before changing this sync.');
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
  for (const row of db.prepare(`${evidenceSelect} WHERE ${pendingWhere} ORDER BY e.timestamp, e.id`).iterate() as Iterable<Evidence & { source_id: number }>) {
    if (seen.has(row.event_key)) continue;
    const { source_id, ...data } = row;
    const prior = old.get(row.event_key);
    const same = prior && prior.text === row.text;
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
      AND e.id < ? AND e.effective_text != '' ORDER BY e.id DESC LIMIT 6`).all(sessionId, firstId) as Evidence[];
    for (const row of prior.reverse()) {
      if (seen.has(row.event_key)) continue;
      const item = { ...row, ref: `C${nextContext}`, text: cleanText(row.text, 2000) };
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
}

function persistItems(id: number, items: Evidence[]): void {
  const insert = getDb().prepare('INSERT INTO sync_items(sync_id, event_key, evidence_json) VALUES (?, ?, ?)');
  for (const item of items) insert.run(id, item.event_key, JSON.stringify(item));
}

export function startSync(since?: string | null): SyncDetail {
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare("SELECT id FROM syncs WHERE status = 'open'").get() as { id: number } | undefined;
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
      VALUES (?, ?, 2, ?, ?, ?)`).run(now, now, JSON.stringify(context), JSON.stringify(memory), memory[0]?.carry_forward || '');
    const id = Number(result.lastInsertRowid);
    persistItems(id, items);
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
    const { items, context } = snapshot(sync);
    archiveBriefing(sync, 'the old partial snapshot was expanded; later evidence may change its conclusions');
    db.prepare('DELETE FROM sync_items WHERE sync_id = ?').run(id);
    persistItems(id, items);
    db.prepare('UPDATE syncs SET snapshot_version = 2, snapshot_at = ?, context_json = ?, remaining_count = 0 WHERE id = ?')
      .run(new Date().toISOString(), JSON.stringify(context), id);
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
  getDb().prepare("UPDATE sync_runs SET status = 'interrupted', error = 'Server restarted. Retry to reuse completed summaries.', completed_at = ? WHERE status = 'running'")
    .run(new Date().toISOString());
}

export function saveNotes(id: number, decisions: string, carryForward: string): SyncDetail {
  requireOpen(id);
  getDb().prepare('UPDATE syncs SET decisions = ?, carry_forward = ? WHERE id = ?').run(decisions, carryForward, id);
  return getSync(id);
}

export function completeSync(id: number, decisions: string, carryForward: string, reviewed: boolean): SyncDetail {
  const db = getDb();
  return db.transaction(() => {
    const sync = requireOpen(id);
    if (!reviewed) throw new HttpError(400, 'Confirm you reviewed this snapshot before finishing the sync');
    if (sync.tree.run && !sync.tree.complete) throw new HttpError(409, 'Compression or the final verdict is incomplete. Retry or discard; failed work cannot advance coverage.');
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
