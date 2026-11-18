import { searchPreparedHistory } from '../memory/service';
import { cleanText } from '../sync/normalize';
import { selectHistory } from './selection';
import type { HistoryQuery } from '../memory/types';

/** The only application-facing entry point. No answer generation or state writes. */
export interface EvidenceRequest {
  question: string;
  /** Optional retrieval refinement; never replaces the actual user request. */
  lookupQuestion?: string;
  before: string;
  signal: AbortSignal;
  scope?: Pick<HistoryQuery, 'session_ids' | 'kind' | 'recent' | 'topics'>;
  previousQuestions?: string[];
  briefing?: string;
  ask: (payload: unknown, system: string) => Promise<string>;
}
export type EvidenceResult =
  | { kind: 'ready'; text: string; refs: string[] }
  | { kind: 'unrelated' | 'clarify'; text: string; refs: string[]; message: string };
export { DISCUSSION_HISTORY_BYTES } from './packet';

export async function prepareEvidence(request: EvidenceRequest): Promise<EvidenceResult> {
  request.signal.throwIfAborted();
  const query = { ...request.scope, question: cleanText(request.lookupQuestion || request.question, 2000), before: request.before, limit: 64 };
  // Search failures remain failures, never a scope decision or an empty match.
  const found = await searchPreparedHistory(query, request.signal);
  request.signal.throwIfAborted();
  return selectHistory(found, { ...query, question: cleanText(request.question, 2000) }, request.before, request.ask, request.signal,
    request.previousQuestions, request.briefing);
}
