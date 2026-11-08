import type { HistoryResults } from '../memory/types';

type Source = { ref: string; session_id?: string | null; sequence?: number };
type Alias = { ref: string; session: string; sequence: number | null };
/** A citation-consistency guard, not semantic verification of each claim.
 * If an answer uses an old checkpoint, it must address its supplied follow-ups
 * too, or remove that unsupported status claim. Frozen E/C aliases count. */
export function reconciliationGaps(answer: string, packet?: { text: string }, aliases: Alias[] = []) {
  if (!packet) return [];
  const data = JSON.parse(packet.text) as { sources: Source[]; reconciliation?: HistoryResults['reconciliation'] };
  const cited = new Set([...answer.matchAll(/\[((?:[EC]\d+)|(?:H[a-f0-9]{24}))\]/g)].map(match => match[1]));
  const citedSource = (ref: string) => {
    if (cited.has(ref)) return true;
    const source = data.sources.find(item => item.ref === ref);
    return source && Number.isSafeInteger(source.sequence) && source.sequence! > 0 && aliases.some(alias =>
      alias.session === source.session_id && alias.sequence === source.sequence && cited.has(alias.ref));
  };
  return (data.reconciliation?.threads || []).filter(thread => citedSource(thread.earlier_ref))
    .map(thread => ({ earlier_ref: thread.earlier_ref, missing_later_refs: thread.later_refs.filter(ref => !citedSource(ref)) }))
    .filter(thread => thread.missing_later_refs.length);
}
