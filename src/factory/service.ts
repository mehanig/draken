import { getDb } from '../db/schema';
import { HttpError } from '../errors';
import { digest } from '../sync/normalize';
import { PLAIN_ENGLISH } from '../plain-english';
import { MATCHING_RECIPE, CONTRACT_MATCH_PROMPT, decideContractMatch } from '../workflow-learning';
import { readMatchingSide } from '../workflow-pilot/matching';
import type { FactoryPage } from './types';

interface Row {
  cursor: number; id: string; model: string; created_at: string;
  recipe_version: string; input_key: string; source_dependencies_json: string; output_json: string;
}
/** Reads saved proposals only. No inference, importing experiment stores, or background scheduling. */
export async function readFactory(cursor: number | undefined, signal: AbortSignal): Promise<FactoryPage> {
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new HttpError(400, 'Invalid Factory cursor');
  signal.throwIfAborted();
  const db = getDb();
  const recipe = digest(JSON.stringify([MATCHING_RECIPE, CONTRACT_MATCH_PROMPT, PLAIN_ENGLISH]));
  const rows = db.prepare(`SELECT rowid cursor,* FROM process_extractions
    WHERE kind='comparison' AND status='completed' AND recipe_version=? AND rowid<? ORDER BY rowid DESC LIMIT 21`)
    .all(recipe, cursor ?? Number.MAX_SAFE_INTEGER) as Row[];
  const result: FactoryPage = { proposals: [], nextCursor: rows.length > 20 ? rows[19].cursor : null, unavailable: 0, learning: 'not-enabled' };
  for (const row of rows.slice(0, 20)) {
    signal.throwIfAborted();
    try {
      const metadata = JSON.parse(row.source_dependencies_json);
      // Never follow an experiment's external SQLite paths, or present synthetic fixtures as learned history.
      if (!Array.isArray(metadata.sources) || metadata.sources.length !== 2 || metadata.sources.some((s: {kind?: string; store?: string}) => s.kind !== 'historical' || s.store !== db.name)) throw Error('Not application history');
      const sides = [];
      for (const source of metadata.sources) sides.push(await readMatchingSide(source, signal, db.name));
      if (JSON.stringify(metadata.sourceIdentities) !== JSON.stringify(sides.map(s => s.identity)) ||
        row.input_key !== digest(JSON.stringify([metadata.manifestHash, sides, row.model])) ||
        row.id !== digest(JSON.stringify([recipe, row.input_key]))) throw Error('Saved comparison dependencies changed');
      const evidence = sides.map(s => s.input);
      const decision = decideContractMatch(JSON.parse(row.output_json).assessment, evidence);
      signal.throwIfAborted();
      // Shared parts are relationships, not identity proposals or permission to merge parent workflows.
      if (decision.sameWorkflow) result.proposals.push({ id: row.id, model: row.model, createdAt: row.created_at, decision, evidence });
    } catch {
      signal.throwIfAborted();
      // Withhold derived content, not just its citations, if any supplied source cannot be revalidated.
      result.unavailable++;
    }
  }
  return result;
}
