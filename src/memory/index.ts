import type Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { cleanText } from '../sync/normalize';
import { getSourceRoots, type RootInput } from '../sources/registry';
import { NormalizationCache } from '../sync/jsonl';
import { initHistoryStorage } from './storage';
import { reconcileHistory } from './reconcile';
import { sourceStamps, saveSourceCheckpoint } from './stamps';
import { historyStamp, saveHistoryReadiness } from './readiness';
import { digest, historySources, type SourceRecord } from './sources';
import { historyUpdate, type Embedder, type HistoryPage, type HistoryQuery, type HistoryResults, type ReportHistory } from './types';

type Chunk = { id: number; ref: string; offset: number };
function proximity(text: string, terms: string[]): number {
  if (terms.length < 2 || terms.length > 5) return 1;
  const positions = [...text.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)].flatMap(match => terms.flatMap((term, i) => match[0].startsWith(term) ? [{ term: i, at: match.index! }] : []));
  const counts = new Map<number, number>(); let left = 0, span = Infinity;
  for (let right = 0; right < positions.length; right++) {
    const item = positions[right]; counts.set(item.term, (counts.get(item.term) || 0) + 1);
    while (counts.size === terms.length) {
      span = Math.min(span, item.at - positions[left].at);
      const term = positions[left++].term, count = counts.get(term)! - 1;
      if (count) counts.set(term, count); else counts.delete(term);
    }
  }
  return 1 + 2 * Math.exp(-span / 80);
}
const LIMITATIONS = 'Search of retained, currently admitted history, not exhaustive recall or independent verification. Excluded/missing sessions, pre-baseline session evidence and discarded sync discussions are omitted. Original logs may contain material not retained here. Summaries are not indexed as primary evidence. No review, decisions or execution changed.';

export class HistoryIndex {
  private modelPrepared = false;
  private current = new Map<string, SourceRecord>();
  private normalized = new NormalizationCache();
  constructor(private db: Database.Database, private source: Database.Database, private model: Embedder, private root: RootInput = getSourceRoots()) {
    vec.load(db);
    db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
    // Cap retained journal high-water space after checkpoints, not active work.
    db.pragma('journal_size_limit = 4194304');
    const fresh = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get();
    db.transaction(() => {
      initHistoryStorage(db, model.fingerprint);
      // A newly created cache has a known empty baseline even if its first
      // preparation is interrupted. Existing caches must not be guessed empty.
      if (fresh) saveSourceCheckpoint(db, new Map());
    })();
  }
  /** Change only derived delta rows. Revalidate sources on every search/read so an
   * exclusion, edit, source removal or discard cannot leak through stale vectors. */
  private refresh(addNew = true) {
    const current = new Map<string, SourceRecord>();
    this.source.transaction(() => this.db.transaction(() => {
      const retained = new Set<string>();
      const existing = new Set((this.db.prepare('SELECT ref FROM records').all() as { ref: string }[]).map(row => row.ref));
      const insert = this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)');
      const passage = this.db.prepare('INSERT OR IGNORE INTO passages(hash) VALUES(?)');
      const find = this.db.prepare('SELECT id FROM passages WHERE hash=?');
      const words = this.db.prepare('INSERT INTO words(rowid,body) VALUES(?,?)');
      const chunk = this.db.prepare('INSERT INTO chunk_links(ref,offset,passage_id) VALUES(?,?,?)');
      for (const item of historySources(this.source, this.root, this.normalized)) {
        retained.add(item.ref);
        if (existing.has(item.ref)) { current.set(item.ref, item); continue; }
        if (!addNew) continue;
        current.set(item.ref, item);
        insert.run(item.ref, JSON.stringify({ ...item, text: undefined }), item.session_id, item.sync_id, item.at, item.group, item.position);
        for (let offset = 0; offset < item.text.length; offset += 700) {
          const body = `${item.title}\n${item.role}\n${item.text.slice(offset, offset + 800)}`, hash = digest(this.model.fingerprint + '\0' + body);
          passage.run(hash); const row = find.get(hash) as { id: number };
          const link = chunk.run(item.ref, offset, row.id);
          words.run(link.lastInsertRowid, body);
          if (offset + 800 >= item.text.length) break;
        }
      }
      const remove = this.db.prepare('DELETE FROM records WHERE ref=?'); let removed = false;
      for (const ref of existing) if (!retained.has(ref)) { remove.run(ref); removed = true; }
      if (removed) this.db.exec('DELETE FROM passages WHERE id NOT IN (SELECT passage_id FROM chunk_links)');
    })())();
    this.current = current;
  }
  /** Automatic, on demand. A search never requires a separate setup/update action.
   * Freeze the candidate set here; revalidation may remove records, but arrivals
   * during this lookup belong to the next one rather than a partial keyword mode. */
  async prepare(scope: Partial<HistoryQuery> = {}, report?: ReportHistory, checkpoint = !scope.session_id && !scope.session_ids && !scope.kind && !scope.sync_id && !scope.before) {
    report?.(historyUpdate('scanning'));
    // Scoped lookups cannot claim global background coverage. Capture the
    // candidate metadata before inference; later source changes stay pending.
    const before = scope.before || new Date().toISOString();
    const stamps = checkpoint ? sourceStamps(this.source, before) : undefined;
    const readiness = checkpoint ? historyStamp(this.source, before, this.root) : undefined;
    const finish = () => {
      if (stamps && readiness) this.db.transaction(() => {
        saveHistoryReadiness(this.db, this.source, before, readiness, this.model.fingerprint, this.root);
        saveSourceCheckpoint(this.db, stamps);
      })();
    };
    this.refresh();
    const filter = this.filter(scope);
    const groups = this.db.prepare(`SELECT DISTINCT p.id FROM passages p JOIN chunk_links c ON c.passage_id=p.id JOIN records r ON r.ref=c.ref
      WHERE p.embedded=0 ${filter.sql} ORDER BY p.id`).all(...filter.args) as { id: number }[];
    const reused = (this.db.prepare(`SELECT COUNT(DISTINCT p.id) n FROM passages p JOIN chunk_links c ON c.passage_id=p.id JOIN records r ON r.ref=c.ref
      WHERE p.embedded=1 ${filter.sql}`).get(...filter.args) as { n: number }).n;
    const total = groups.length;
    let completed = 0, computed = 0, meanMs = 0, measured = 0;
    const notify = (stage: 'loading' | 'indexing') => report?.(historyUpdate(stage, { total, completed, reused, parallelism: this.model.parallelism,
      remaining_seconds: completed === total ? 0 : measured >= 8 ? Math.ceil((total - completed) * meanMs / 1000) : null }));
    if (!total) {
      if (reused && !this.model.ready()) { notify('loading'); await this.ensureModel(report); }
      finish(); notify('indexing'); return;
    }
    notify('loading'); await this.ensureModel(report);
    const getChunk = this.db.prepare('SELECT c.ref,c.offset,p.hash FROM chunk_links c JOIN passages p ON p.id=c.passage_id WHERE p.id=? ORDER BY c.id LIMIT 1');
    const saveVector = this.db.prepare('INSERT INTO passage_vectors(rowid,embedding) VALUES(?,?)');
    const markReady = this.db.prepare('UPDATE passages SET embedded=1 WHERE id=?');
    const pending: { id: number; embedding: Buffer }[] = [];
    let lastCommit = Date.now();
    const commit = () => {
      if (!pending.length) return;
      this.db.transaction(() => {
        for (const item of pending) {
          saveVector.run(BigInt(item.id), item.embedding); markReady.run(item.id);
        }
      })();
      completed += pending.length; pending.length = 0; lastCommit = Date.now(); notify('indexing');
    };
    notify('indexing');
    for (let offset = 0; offset < groups.length; offset += 8) {
      if (!computed) notify('loading');
      const batch = groups.slice(offset, offset + 8), bodies = batch.map(group => {
        const chunk = getChunk.get(group.id) as { ref: string; offset: number; hash: string }, record = this.record(chunk.ref);
        const body = `${record.title}\n${record.role}\n${record.text.slice(chunk.offset, chunk.offset + 800)}`;
        if (digest(this.model.fingerprint + '\0' + body) !== chunk.hash) throw new Error('Verified search passage changed');
        return body;
      });
      const start = Date.now(), vectors: Float32Array[] = [];
      if (this.model.embedMany) vectors.push(...await this.model.embedMany(bodies, total >= 32));
      else for (const body of bodies) vectors.push(await this.model.embed(body, false));
      if (vectors.length !== batch.length) throw new Error('Incomplete embedding batch');
      const embeddings = vectors.map(vector => {
        if (!(vector instanceof Float32Array) || vector.length !== 384 || vector.some(value => !Number.isFinite(value))) throw new Error('Invalid embedding');
        return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
      });
      // Wall time per completed passage reflects parallel throughput. Exclude
      // the first batch's cold model load and count only committed delta work.
      if (computed) { const ms = (Date.now() - start) / batch.length; meanMs = measured ? meanMs * 0.9 + ms * 0.1 : ms; measured += batch.length; }
      computed += batch.length;
      batch.forEach((group, i) => pending.push({ id: group.id, embedding: embeddings[i] }));
      if (pending.length >= 64 || Date.now() - lastCommit >= 1000) commit();
    }
    commit(); notify('indexing'); this.refresh(false);
    finish();
  }
  /** Voice can verify and query prepared passages, never build a missing corpus.
   * Fresh original-byte/projection checks remain mandatory; the ready receipt
   * only controls scheduling, not source authority. No derived writes here. */
  private assertPrepared(scope: Partial<HistoryQuery>, report?: ReportHistory) {
    report?.(historyUpdate('scanning'));
    const current = new Map<string, SourceRecord>();
    const chunks = this.db.prepare('SELECT c.offset,p.hash,p.embedded FROM chunk_links c JOIN passages p ON p.id=c.passage_id WHERE c.ref=? ORDER BY c.offset');
    for (const record of historySources(this.source, this.root, this.normalized, scope)) {
      if (!this.admitted(record, scope)) continue;
      const rows = chunks.all(record.ref) as { offset: number; hash: string; embedded: number }[];
      let count = 0;
      for (let offset = 0; offset < record.text.length; offset += 700) {
        const row = rows[count++], hash = digest(this.model.fingerprint + '\0' + `${record.title}\n${record.role}\n${record.text.slice(offset, offset + 800)}`);
        if (!row || row.offset !== offset || row.hash !== hash || row.embedded !== 1) throw new Error('History needs preparation before calling.');
        if (offset + 800 >= record.text.length) break;
      }
      if (rows.length !== count) throw new Error('Prepared history changed.');
      current.set(record.ref, record);
    }
    this.current = current;
  }
  private async ensureModel(report?: ReportHistory, allowDownload = true) {
    if (!this.modelPrepared || !this.model.ready()) { await this.model.setup(report, allowDownload); this.modelPrepared = true; }
  }
  private keywords(match: string, condition: string, args: (string | number)[], limit = 80): Chunk[] {
    // Aliases and repeated reads share passages. Deduplicate *before* the top-k
    // limit or eighty copies of one passage can erase every alternative hit.
    return this.db.prepare(`WITH hits AS MATERIALIZED (
      SELECT c.id,c.ref,c.offset,c.passage_id,r.at,bm25(words) relevance FROM words
      JOIN chunk_links c ON c.id=words.rowid JOIN passages p ON p.id=c.passage_id JOIN records r ON r.ref=c.ref
      WHERE words MATCH ? AND p.embedded=1 ${condition})
      SELECT id,ref,offset,MAX(at) FROM hits GROUP BY passage_id ORDER BY relevance,id LIMIT ?`).all(match, ...args, limit) as Chunk[];
  }
  private admitted(record: SourceRecord, scope: Partial<HistoryQuery>) {
    return !(scope.before && (!record.at || record.at > scope.before))
      && (!scope.session_id || record.session_id === scope.session_id)
      && (!scope.session_ids || Boolean(record.session_id && scope.session_ids.includes(record.session_id)))
      && (!scope.sync_id || record.sync_id === scope.sync_id)
      && (!scope.kind || (scope.kind === 'sources' ? record.session_id !== null : record.session_id === null));
  }
  private filter(query: Partial<HistoryQuery>) {
    const conditions: string[] = [], args: (string | number)[] = [];
    if (query.session_id) { conditions.push('r.session_id=?'); args.push(query.session_id); }
    if (query.session_ids) { conditions.push(`r.session_id IN (${query.session_ids.map(() => '?').join(',')})`); args.push(...query.session_ids); }
    if (query.kind) conditions.push(query.kind === 'sources' ? 'r.session_id IS NOT NULL' : 'r.session_id IS NULL');
    if (query.sync_id) { conditions.push('r.sync_id=?'); args.push(query.sync_id); }
    if (query.before) { conditions.push('r.at IS NOT NULL AND r.at<=?'); args.push(query.before); }
    return { sql: conditions.length ? ' AND ' + conditions.join(' AND ') : '', args };
  }
  async search(query: HistoryQuery, report?: ReportHistory, preparedOnly = false): Promise<HistoryResults> {
    if (preparedOnly) this.assertPrepared(query, report);
    else await this.prepare(query, report);
    report?.(historyUpdate('searching'));
    const filter = this.filter(query);
    const any = this.db.prepare(`SELECT 1 FROM chunks c JOIN records r ON r.ref=c.ref WHERE 1=1 ${filter.sql} LIMIT 1`).get(...filter.args);
    if (!any) return { mode: 'hybrid', results: [], limitations: LIMITATIONS };
    if (preparedOnly && !this.model.ready()) throw new Error('Prepare the local search model before calling.');
    await this.ensureModel(report, !preparedOnly);
    const searches = [query.question, ...(query.topics || []).slice(0, 2)];
    const embeddings: Float32Array[] = [];
    for (const question of searches) embeddings.push(await this.model.embed(cleanText(question, 2000), true));
    // Prune exclusions/edits again after inference without admitting unembedded
    // arrivals. All returned candidates have both lexical and semantic coverage.
    if (preparedOnly) this.assertPrepared(query, report);
    else this.refresh(false);
    const scoresByQuery: Map<string, { score: number; chunk: Chunk }>[] = [], termSets: string[][] = [];
    for (const [search, embedding] of searches.map((text, i) => [text, embeddings[i]] as const)) {
    const scores = new Map<string, { score: number; chunk: Chunk }>(); scoresByQuery.push(scores);
    const add = (rows: Chunk[], weight = 1) => {
      const distinct = new Set<string>();
      for (const row of rows) {
        if (!this.current.has(row.ref)) continue; // Excluded/removed records cannot be served from stale vectors.
        const identity = this.record(row.ref).identity;
        if (distinct.has(identity)) continue; distinct.add(identity);
        const old = scores.get(identity), score = weight / (60 + distinct.size);
        scores.set(identity, { score: (old?.score || 0) + score, chunk: weight > 1 ? row : old?.chunk || row });
      }
    };
    const stop = new Set('the a an and or of to in on is it we i you our my what why how did do does was were have has had this that with for from about remember recall previous earlier history please are those here exactly mean meant can could check hello still agent trying moment question call'.split(' '));
    const terms = [...new Set(search.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])].filter(term => !stop.has(term)).slice(0, 32);
    const stems = [...new Set(terms.map(term => query.kind === 'sources' && term.length >= 5 ? term.slice(0, 4) : term))];
    termSets.push(stems);
    const lexical = stems.map(term => `"${term}"${query.kind === 'sources' ? '*' : ''}`);
    if (terms.length) add(this.keywords(lexical.join(' OR '), filter.sql, filter.args));
    add(this.db.prepare(`SELECT c.id,c.ref,c.offset,MAX(r.at) FROM passage_vectors v JOIN chunk_links c ON c.passage_id=v.rowid JOIN records r ON r.ref=c.ref
      WHERE v.embedding MATCH ? AND k=80 AND v.rowid IN (SELECT c.passage_id FROM chunk_links c JOIN passages p ON p.id=c.passage_id JOIN records r ON r.ref=c.ref WHERE p.embedded=1 ${filter.sql})
      AND v.distance<=0.25 ${filter.sql} GROUP BY c.passage_id ORDER BY v.distance,c.id LIMIT 80`).all(Buffer.from(embedding.buffer), ...filter.args, ...filter.args) as Chunk[]);
    if (query.kind === 'sources') {
      // Agent explanations are a separate retrieval lane, not buried under the
      // many near-identical tool reads/edits in a coding session. Existing vectors
      // and original record identities are reused; no new corpus work in calls.
      const narratives = [...this.current.values()].filter(record => this.admitted(record, query) && record.kind === 'session'
        && record.role === 'assistant' && record.text.length >= 40 && !/^Tool requested:/.test(record.text))
        .sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 1024).map(record => record.ref);
      if (narratives.length) {
        const selected = narratives.map(() => '?').join(',');
        if (terms.length) add(this.keywords(lexical.join(' OR '), `AND c.offset=0 AND c.ref IN (${selected})`, narratives), 2);
        add(this.db.prepare(`SELECT c.id,c.ref,c.offset,MAX(r.at) FROM passage_vectors v JOIN chunk_links c ON c.passage_id=v.rowid JOIN records r ON r.ref=c.ref
          WHERE v.embedding MATCH ? AND k=80 AND v.rowid IN (SELECT passage_id FROM chunk_links WHERE offset=0 AND ref IN (${selected}))
          AND v.distance<=0.25 AND c.offset=0 AND c.ref IN (${selected}) GROUP BY c.passage_id ORDER BY v.distance,c.id LIMIT 80`)
          .all(Buffer.from(embedding.buffer), ...narratives, ...narratives) as Chunk[], 2);
      }
    }
    if (query.kind === 'sources' && terms.length >= 2 && terms.length <= 5) add(this.keywords(lexical.join(' AND '), filter.sql, filter.args, 40), 5);
    }
    const rank = (value: { score: number; chunk: Chunk }, terms: string[]) => {
      if (query.kind !== 'sources') return value.score;
      const record = this.record(value.chunk.ref);
      const age = Math.max(0, (Date.parse(query.before || new Date().toISOString()) - Date.parse(record.at || '')) / 86400000);
      const role = record.role === 'user' ? 0.25 : /^Tool requested:/.test(record.text) ? 0.5 : 1;
      const detail = record.role === 'assistant' && /\n(?:[-*] |### |\|)/.test(record.text) ? 1.5 : 1;
      return value.score * role * detail * (query.recent ? 1 + 2 * Math.exp(-age / 0.5) : 1 + 0.4 * Math.exp(-age / 3))
        * proximity(record.text.slice(value.chunk.offset, value.chunk.offset + 800), terms);
    };
    const rankings = scoresByQuery.map((scores, i) => [...scores.values()].sort((a, b) => rank(b, termSets[i]) - rank(a, termSets[i]) || a.chunk.id - b.chunk.id));
    const ranked = rankings.flat(), topicLeaders = [0, 1].flatMap(i => rankings.slice(1).flatMap(rows => rows[i] ? [rows[i]] : []));
    const recent: { score: number; chunk: Chunk }[] = [];
    if (query.recent && (query.session_id || query.session_ids)) {
      const latest = [...this.current.values()].filter(record => this.admitted(record, query) && record.kind === 'session'
        && record.role === 'assistant' && record.text.length >= 40 && !/^Tool requested:/.test(record.text))
        .sort((a, b) => (b.at || '').localeCompare(a.at || '') || b.position - a.position).slice(0, 1);
      for (const record of latest) {
        const chunk = this.db.prepare('SELECT id,ref,offset FROM chunks WHERE ref=? AND embedded=1 ORDER BY offset LIMIT 1').get(record.ref) as Chunk | undefined;
        if (chunk) recent.push({ score: 1, chunk });
      }
    }
    const explicit = query.kind === 'sources' ? [...new Set(query.question.match(/\bH[a-f0-9]{24}\b/g) || [])].slice(0, 3).map(ref => {
      const record = this.record(ref);
      if (!this.admitted(record, query)) throw new Error('Historical reference is outside this lookup scope or cutoff.');
      const chunk = this.db.prepare('SELECT id,ref,offset FROM chunks WHERE ref=? AND embedded=1 ORDER BY offset LIMIT 1').get(ref) as Chunk | undefined;
      if (!chunk) throw new Error('Historical reference has not been prepared.');
      return { score: 1, chunk };
    }) : [];
    const selected = [...explicit, ...recent, ...topicLeaders, ...ranked].filter((value, i, all) => all.findIndex(other => this.record(other.chunk.ref).identity === this.record(value.chunk.ref).identity) === i);
    const results = selected.slice(0, 8).map(({ chunk, score }) => {
      const record = this.record(chunk.ref);
      return { ...record, sequence: record.position, text: record.text.slice(chunk.offset, chunk.offset + (query.kind === 'sources' ? 1600 : 800)), offset: chunk.offset, score, ...(query.kind === 'sources' && chunk.offset > 0 ? { lead: record.text.slice(0, 400) } : {}) };
    });
    return { mode: 'hybrid', ...reconcileHistory([...this.current.values()].filter(record => this.admitted(record, query)), results, query), limitations: LIMITATIONS + ' Records arriving or changing during this lookup are considered by the next lookup.' };
  }
  private record(ref: string): SourceRecord {
    const record = this.current.get(ref);
    if (!record) throw new Error('This historical record is no longer admitted or its text changed. Search again.');
    return record;
  }
  read(ref: string, offset = 0, preparedBefore?: string): HistoryPage {
    if (preparedBefore) {
      const cached = this.db.prepare('SELECT session_id FROM records WHERE ref=?').get(ref) as { session_id: string | null } | undefined;
      if (!cached) throw new Error('Historical source is unavailable.');
      this.assertPrepared({ before: preparedBefore, ...(cached.session_id ? { session_id: cached.session_id } : { kind: 'conversation' as const }) });
    }
    else this.refresh();
    const item = this.record(ref);
    const rows = this.db.prepare(`SELECT ref FROM records WHERE group_id=? ORDER BY COALESCE(at,''),position,ref`).all(item.group) as { ref: string }[];
    const records = rows.filter(row => this.current.has(row.ref)).map(row => this.record(row.ref)), at = records.findIndex(row => row.ref === ref);
    const before = records.slice(0, at).reverse().find(row => row.identity !== item.identity);
    const after = records.slice(at + 1).find(row => row.identity !== item.identity && row.identity !== before?.identity);
    const neighbors = [before, after].filter((row): row is SourceRecord => Boolean(row)).map(row => ({ ...row, text: row.text.slice(0, 600) }));
    return { record: { ...item, text: item.text.slice(offset, offset + 4000) }, offset, total: item.text.length, neighbors };
  }
}
