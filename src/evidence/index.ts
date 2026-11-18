import { selectHistory } from './selection';
import type { EvidenceDependencies, EvidenceRequest, EvidenceResult } from './contracts';

export type { EvidenceDependencies, EvidenceRequest, EvidenceResult } from './contracts';
export { DISCUSSION_HISTORY_BYTES } from './packet';

/** The only application-facing operation. All host operations are injected. */
export async function prepareEvidence(request: EvidenceRequest, dependencies: EvidenceDependencies): Promise<EvidenceResult> {
  request.signal.throwIfAborted();
  const query = { ...request.scope, question: dependencies.cleanText(request.lookupQuestion || request.question, 2000), before: request.before, limit: 64 };
  // Search failures remain failures, never a scope decision or an empty match.
  const found = await dependencies.search(query, request.signal);
  request.signal.throwIfAborted();
  return selectHistory(found, { ...query, question: dependencies.cleanText(request.question, 2000) }, request.before,
    request.ask, request.signal, dependencies, request.previousQuestions, request.briefing);
}
