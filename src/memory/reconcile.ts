import type { HistoryQuery, HistoryResults } from './types';
import type { SourceRecord } from './sources';

export const statusQuestion = (text: string) => /\b(?:status|current|latest|blocked|blockers?|unfinished|unconfirmed|remaining|finished|completed?|still|how (?:long|much longer)|where (?:are we|we are)|what(?:'s| is) left)\b/i.test(text);
const pending = /\b(?:not (?:yet |fully )?(?:implemented|connected|wired|complete\w*|finished|enabled|available|established|activated)|unfinished|unconfirmed|pending|remain\w*|block\w*|disabled|incomplete|next|need\w*|todo|unverified)\b/i;
const stop = new Set(('the and for from with without this that these those have has had are was were will would could should into still ' +
  'not yet now then next only before after while more most some same other all any new old our your its but also which what where when how ' +
  'app native project work working implementation implemented implement implementing complete completed completion finished unfinished ' +
  'remaining remains remain pending blocked blockers needs need needed verified verification unverified passed passing tests test tested testing ' +
  'check checks checked build builds release debug simulator strict concurrency source sources report reported reports checkpoint updated ' +
  'continue continued continuing details documented documentation unchanged preserved evidence changes change requested existing later current ' +
  'ready readiness feature features fully end local locally real live enabled disabled intended result results planned plan full ' +
  'nothing deployed uncommitted mobile ios docs rewrite progress updated update there their several just functionality functional area').split(' '));
const narrative = (text: string) => text.split('\nTool requested:')[0];
function terms(text: string): Set<string> {
  return new Set((text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(word => word.length >= 3 && !stop.has(word) && !/^\d+$/.test(word))
    .map(word => /^(?:push|apns|notifications?)$/.test(word) ? 'notification' : word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word));
}
type Hit = HistoryResults['results'][number];
function blocks(text: string) {
  let change = false;
  return narrative(text).split(/\n\s*\n/).map(block => {
    const lead = block.split('\n')[0].replace(/^[#*\s-]+/, '');
    if (/^(?:verification|tests?|details|documentation|live delivery|overall)/i.test(lead)
      || (pending.test(lead) && !/^(?:implemented|completed|added|fixed|integrated|wired)\b/i.test(lead))) change = false;
    else if (/\b(?:implemented|completed|added|fixed|integrated|wired|reopened|reverted|rolled back)\b/i.test(lead)) change = true;
    else if (/^\s*#/.test(block)) change = false;
    return { words: terms(block), change };
  });
}

/** Candidate follow-ups, NOT an automatic truth/status classifier. Walk verified
 * original narratives after each retrieved blocker in the SAME source session.
 * Never use generated Draken replies, aliases, or another project's test result
 * to declare a feature done. Source sequence wins over skewed timestamps. */
export function reconcileHistory(records: SourceRecord[], hits: Hit[], query: HistoryQuery): Pick<HistoryResults, 'results' | 'reconciliation'> {
  if (!query.reconcile || query.kind !== 'sources' || !(query.recent || statusQuestion(query.question))) return { results: hits };
  const all = records.filter(record => record.kind === 'session' && record.session_id && record.role === 'assistant'
    && (!query.before || Boolean(record.at && record.at <= query.before))
    && (!query.session_id || record.session_id === query.session_id)
    && (!query.session_ids || query.session_ids.includes(record.session_id))
    && narrative(record.text).trim().length >= 40 && !/^Tool requested:/.test(record.text));
  const selected = all.sort((a, b) => b.position - a.position).slice(0, 4096);
  const corpus = selected.map(record => ({ record, words: terms(narrative(record.text)), blocks: blocks(record.text) }));
  const frequency = new Map<string, number>();
  for (const item of corpus) for (const word of item.words) frequency.set(word, (frequency.get(word) || 0) + 1);
  const weight = (word: string) => 1 + Math.log(1 + corpus.length / (frequency.get(word) || 1));
  const byRef = new Map(records.map(record => [record.ref, record]));
  const follow = (ref: string) => {
    const seed = byRef.get(ref);
    if (!seed || seed.role !== 'assistant' || seed.kind !== 'session') return [];
    const clauses = narrative(seed.text).split(/\n|(?<=[.!?])\s+/u).filter(line => pending.test(line));
    const facets = clauses.flatMap(line => line.split(/[,;:]\s*/)).map(terms).filter(words => words.size >= 2);
    const anchor = new Set(facets.flatMap(words => [...words]));
    if (anchor.size < 2) return [];
    const candidates = corpus.filter(item => item.record.session_id === seed.session_id && item.record.position > seed.position
      && item.record.identity !== seed.identity).map(item => ({ ...item, shared: [...anchor].filter(word => item.words.has(word)) }))
      .filter(item => item.shared.length >= Math.min(3, anchor.size) && facets.some(facet => item.blocks.some(block =>
        [...facet].filter(word => block.words.has(word)).length >= Math.min(3, facet.size))));
    if (!candidates.length) return [];
    const winners = new Map<typeof candidates[number], number>();
    // Search each comma/line-delimited sub-task separately. A client report
    // repeating 'backend jobs remain' must not crowd out the later job report.
    // Prefer locally matching change sections, not broad whole-document overlap.
    // This is ranking only: plans/negations still reach the model as quoted data.
    for (const facet of facets) {
      const ranked = candidates.map(item => ({ item, score: Math.max(...item.blocks.map(block => {
        const shared = [...facet].filter(word => block.words.has(word));
        return shared.length < Math.min(2, facet.size) ? 0 : shared.reduce((sum, word) => sum + weight(word), 0)
          / facet.size * (block.change ? 2 : 0.6);
      })) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.item.record.position - a.item.record.position);
      if (ranked[0]) winners.set(ranked[0].item, (winners.get(ranked[0].item) || 0) + ranked[0].score);
    }
    const chosen = [...winners].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([item]) => item);
    const latest = candidates.reduce((a, b) => a.record.position > b.record.position ? a : b);
    if (!chosen.includes(latest)) chosen.push(latest);
    return [{ seed, chosen: chosen.sort((a, b) => a.record.position - b.record.position),
      score: [...winners.values()].reduce((sum, value) => sum + value, 0) / Math.sqrt(facets.length), candidates: candidates.length }];
  };
  const rank = (groups: ReturnType<typeof follow>) => groups.sort((a, b) => b.score - a.score || b.seed.position - a.seed.position);
  const initial = rank(hits.flatMap(hit => follow(hit.ref))), groups = initial.slice(0, 4);
  let omitted = initial.length - groups.length, frontier = groups.slice();
  const visited = new Set(groups.map(group => group.seed.ref));
  // A follow-up may itself have become stale (client done, jobs still pending,
  // then jobs implemented). Check two further bounded generations, not just the
  // initially ranked excerpts. No extra model inference or corpus writes.
  for (let depth = 0; depth < 2; depth++) {
    const refs = [...new Set(frontier.flatMap(group => group.chosen.map(item => item.record.ref)))].filter(ref => !visited.has(ref));
    refs.forEach(ref => visited.add(ref));
    const next = rank(refs.flatMap(follow));
    frontier = next.slice(0, 4); omitted += next.length - frontier.length; groups.push(...frontier);
  }
  const threads = groups.map(group => ({ earlier_ref: group.seed.ref,
    later_refs: group.chosen.map(item => item.record.ref), matched_terms: [...new Set(group.chosen.flatMap(item => item.shared))].slice(0, 24),
    other_candidates: group.candidates - group.chosen.length }));
  const result: Hit[] = [];
  const add = (record: SourceRecord) => {
    if (result.some(item => item.ref === record.ref)) return;
    result.push({ ...record, text: narrative(record.text), offset: 0, score: 1, sequence: record.position });
  };
  // Later reports precede their earlier anchor for packing priority. If space
  // runs out, discard the old anchor, never preserve it without its follow-ups.
  // All roots' direct follow-ups come before deeper dependencies and anchors;
  // one broad roadmap must not consume the packet ahead of another feature.
  for (const group of groups) group.chosen.forEach(item => add(item.record));
  for (const group of groups) add(group.seed);
  for (const hit of hits) if (!result.some(item => item.ref === hit.ref)) result.push(hit);
  return { results: result, reconciliation: {
    checked_narratives: corpus.length, omitted_narratives: all.length - corpus.length,
    omitted_threads: omitted, threads,
    qualification: 'Bounded lexical follow-up candidates within the same original session (4096 narratives, four starting threads, two further generations). Not exhaustive or verified supersession. Reconcile each sub-task: implemented, tested, enabled/deployed and device/provider acceptance are different. A later partial success does not close the whole feature; a delivery gate does not erase implemented client work. No match is not proof that no later update exists.',
  } };
}
