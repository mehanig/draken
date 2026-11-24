import type { EvidenceDependencies } from './contracts';
import { historyPacket, DISCUSSION_HISTORY_BYTES } from './packet';

/** Re-read every selected page, including uncited neighbors, at the captured cutoff.
 * No new search, intent interpretation, model client or persistence lives here. */
export async function readTaskEvidence(request: { before: string; selections: { ref: string; offset: number }[]; requiredRefs?: string[]; signal: AbortSignal }, dependencies: EvidenceDependencies) {
  const { before, selections, signal } = request;
  signal.throwIfAborted();
  if (!Number.isFinite(Date.parse(before)) || selections.length > 8 || new Set(selections.map(s => s.ref)).size !== selections.length) throw Error('Invalid task evidence selection');
  const pages: Awaited<ReturnType<EvidenceDependencies['read']>>[] = [];
  for (const selected of selections) {
    if (!selected.ref || !Number.isSafeInteger(selected.offset) || selected.offset < 0) throw Error('Invalid task evidence reference');
    const page = await dependencies.read(selected.ref, selected.offset, signal, before);
    signal.throwIfAborted();
    if (page.record.ref !== selected.ref || !page.record.at || page.record.at > before) throw Error('Task evidence is outside its captured cutoff');
    pages.push(page);
  }
  const originals = [...new Map(pages.flatMap(p => [p.record, ...p.neighbors]).filter(r => r.at && r.at <= before).map(r => [r.ref, r])).values()];
  const references = originals.map(record => record.ref);
  for (const ref of request.requiredRefs || []) if (!references.includes(ref)) {
    const page = await dependencies.read(ref, 0, signal, before);
    signal.throwIfAborted();
    if (page.record.ref !== ref || !page.record.at || page.record.at > before) throw Error('Task source access changed');
  }
  const packet = historyPacket({ mode: 'task', results: originals.map(r => ({ ...r, offset: pages.find(p => p.record.ref === r.ref)?.offset || 0 })),
    limitations: 'Selected originals across sessions, not a complete task archive. Sequence establishes order only within a session. Missing outcomes do not prove failure or success.' }, dependencies.cleanText, DISCUSSION_HISTORY_BYTES, 3000);
  const shown = JSON.parse(packet.text) as { sources: { ref: string; session_id: string | null; sequence?: number; at: string; role: string; text: string; workspace: string; ending?: { text: string } }[]; limitations: string; omitted_matches: number };
  return { records: shown.sources.map(r => ({ ref: r.ref, sessionId: r.session_id, sequence: r.sequence, at: r.at, role: r.role, workspace: r.workspace,
    text: r.text + (r.ending ? '\n[Later excerpt from the same original]\n' + r.ending.text : '') })),
    limitations: [shown.limitations, ...(shown.omitted_matches ? [`${shown.omitted_matches} originals did not fit in the task packet.`] : [])],
    references, receipt: JSON.stringify(pages) };
}
