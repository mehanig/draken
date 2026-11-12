import { readHistory, searchHistory, searchPreparedHistory } from './service';
import { cleanText } from '../sync/normalize';
import type { HistoryQuery } from './types';
import { statusQuestion } from './reconcile';
import { historyPacket } from './packet';

export async function historyContext(question: string, before: string, signal?: AbortSignal, maxBytes = 3500, preparedOnly = false,
  selection: Pick<HistoryQuery, 'session_ids' | 'kind' | 'recent' | 'topics' | 'reconcile'> = {}) {
  const explicit = [...new Set(question.match(/\bH[a-f0-9]{24}\b/g) || [])].slice(0, 3);
  if (explicit.length && !(selection.reconcile && selection.kind === 'sources' && statusQuestion(question) && !/\boffset[ :=]+\d/i.test(question))) {
    const sources = [];
    for (const ref of explicit) {
      const requested = question.match(new RegExp(`\\b${ref}\\s+(?:at\\s+)?offset[ :=]+(\\d{1,7})\\b`, 'i'));
      const offset = requested ? Math.min(1000000, Number(requested[1])) : 0;
      const page = await readHistory(ref, offset, signal, preparedOnly ? before : undefined);
      if (page.record.at && page.record.at <= before && (!selection.session_ids || (page.record.session_id && selection.session_ids.includes(page.record.session_id)))) sources.push({ ...page.record, offset: page.offset, score: 1 });
    }
    return historyPacket({ results: sources, mode: 'reference_read', limitations: 'Explicit historical references, not a new archive search. Missing or undated records cannot establish an as-of claim.' }, maxBytes, explicit.length === 1 ? (maxBytes > 3500 ? 4000 : 2400) : 800);
  }
  const found = await (preparedOnly ? searchPreparedHistory : searchHistory)({ ...selection, question: cleanText(question, 2000), before }, signal);
  found.limitations += ` Prepared history cutoff: ${before}. This is the latest recorded evidence within that cutoff, not live process observation.`;
  // Work questions need original records, not neighboring conversation chatter.
  if (selection.kind === 'sources') return historyPacket(found, maxBytes, maxBytes > 7000 ? 3000 : maxBytes > 3500 ? 1200 : 800);
  if (found.results[0]) {
    const hit = found.results[0], page = await readHistory(hit.ref, Math.max(0, hit.offset - 200), signal, preparedOnly ? before : undefined);
    const neighbors = page.neighbors.filter(item => item.at && item.at <= before);
    found.results = [hit, ...found.results.slice(1, 2), ...neighbors.map(item => ({ ...item, offset: 0, score: 0 })), ...found.results.slice(2)]
      .filter((item, index, all) => all.findIndex(other => other.ref === item.ref) === index);
  }
  return historyPacket(found, maxBytes);
}
