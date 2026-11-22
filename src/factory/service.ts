import { getDb } from '../db/schema';
import { HttpError } from '../errors';
import { LEARNING_FORMAT } from './learning-store';
import { discoveryFromProposal, readProposal } from './discovery';
import { savedEnrichment } from './enrichment';
import type { FactoryPage } from './types';

export async function readFactory(cursor: number | undefined, signal: AbortSignal): Promise<FactoryPage> {
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new HttpError(400, 'Invalid Factory cursor');
  signal.throwIfAborted();
  const db = getDb();
  const setting = (key: string) => (db.prepare('SELECT value FROM sync_settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
  const enabled = setting('auto_index') === 'true' && setting('auto_summary') !== 'false';
  const rows = db.prepare('SELECT rowid cursor,id FROM workflow_discoveries WHERE rowid<? ORDER BY rowid DESC LIMIT 21')
    .all(cursor ?? Number.MAX_SAFE_INTEGER) as { id: string; cursor: number }[];
  const failedExtractions = (db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE kind='summary' AND status='failed' AND json_extract(source_dependencies_json,'$.format')=?").get(LEARNING_FORMAT) as { n: number }).n;
  const result: FactoryPage = { proposals: [], nextCursor: rows.length > 20 ? rows[19].cursor : null, unavailable: 0,
    learning: !enabled ? 'paused' : setting('auto_summary_error') ? 'error' : 'enabled', failedExtractions };
  for (const row of rows.slice(0, 20)) {
    try {
      const proposal = await readProposal(row.id, signal);
      signal.throwIfAborted();
      if (proposal.task || proposal.decision?.sameWorkflow) {
        result.proposals.push({ ...proposal, enrichment: savedEnrichment(discoveryFromProposal(proposal)) });
      }
    } catch {
      signal.throwIfAborted();
      result.unavailable++;
    }
  }
  return result;
}
