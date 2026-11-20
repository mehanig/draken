import { getDb } from '../db/schema';
import { HttpError } from '../errors';
import { COMPARISON_FORMAT, LEARNING_FORMAT, readWorkflowComparison, type LearningRow } from './learning-store';
import type { FactoryPage } from './types';

/** Reads saved proposals only. Background summarization owns all learning. */
export async function readFactory(cursor: number | undefined, signal: AbortSignal): Promise<FactoryPage> {
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new HttpError(400, 'Invalid Factory cursor');
  signal.throwIfAborted();
  const db = getDb();
  const setting = (key: string) => (db.prepare('SELECT value FROM sync_settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
  const enabled = setting('auto_index') === 'true' && setting('auto_summary') !== 'false';
  const rows = db.prepare(`SELECT rowid cursor,* FROM process_extractions WHERE kind='comparison' AND status='completed'
    AND json_extract(source_dependencies_json,'$.format')=? AND json_extract(source_dependencies_json,'$.phase')='match'
    AND rowid<? ORDER BY rowid DESC LIMIT 21`).all(COMPARISON_FORMAT, cursor ?? Number.MAX_SAFE_INTEGER) as (LearningRow & { cursor: number })[];
  const failedExtractions = (db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE kind='summary' AND status='failed' AND json_extract(source_dependencies_json,'$.format')=?").get(LEARNING_FORMAT) as { n: number }).n;
  const result: FactoryPage = { proposals: [], nextCursor: rows.length > 20 ? rows[19].cursor : null, unavailable: 0,
    learning: !enabled ? 'paused' : setting('auto_summary_error') ? 'error' : 'enabled', failedExtractions };
  for (const row of rows.slice(0, 20)) {
    try {
      const { decision, evidence } = await readWorkflowComparison(row, signal);
      signal.throwIfAborted();
      if (decision.sameWorkflow) result.proposals.push({ id: row.id, model: row.model, createdAt: row.created_at, decision, evidence });
    } catch {
      signal.throwIfAborted();
      result.unavailable++;
    }
  }
  return result;
}
