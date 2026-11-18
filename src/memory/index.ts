import type Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { cleanText } from '../sync/normalize';
import { getSourceRoots, type RootInput } from '../sources/registry';
import { NormalizationCache } from '../sync/jsonl';
import { initHistoryStorage } from './storage';
import { validEmbedding } from './embedding-contract';
import { sourceStamps, saveSourceCheckpoint } from './stamps';
import { historyStamp, saveHistoryReadiness } from './readiness';
import { historySources, type SourceRecord } from './sources';
import { passage, passages } from './passages';
import { historyUpdate, HISTORY_PAGE_CHARACTERS, type Embedder, type HistoryPage, type HistoryQuery, type HistoryResults, type ReportHistory } from './types';

type Chunk = { id: number; ref: string; offset: number };
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
      const insertPassage = this.db.prepare('INSERT OR IGNORE INTO passages(hash) VALUES(?)');
      const find = this.db.prepare('SELECT id FROM passages WHERE hash=?');
      const words = this.db.prepare('INSERT INTO words(rowid,body) VALUES(?,?)');
      const chunk = this.db.prepare('INSERT INTO chunk_links(ref,offset,passage_id) VALUES(?,?,?)');
      for (const item of historySources(this.source, this.root, this.normalized)) {
        retained.add(item.ref);
        if (existing.has(item.ref)) { current.set(item.ref, item); continue; }
        if (!addNew) continue;
        current.set(item.ref, item);
        insert.run(item.ref, JSON.stringify({ ...item, text: undefined }), item.session_id, item.sync_id, item.at, item.group, item.position);
        for (const { offset, body, hash } of passages(item, this.model.fingerprint)) {
          insertPassage.run(hash); const row = find.get(hash) as { id: number };
          const link = chunk.run(item.ref, offset, row.id);
          words.run(link.lastInsertRowid, body);
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
        const { body, hash } = passage(record, chunk.offset, this.model.fingerprint);
        if (hash !== chunk.hash) throw new Error('Verified search passage changed');
        return body;
      });
      const start = Date.now(), vectors: Float32Array[] = [];
      if (this.model.embedMany) vectors.push(...await this.model.embedMany(bodies, total >= 32));
      else for (const body of bodies) vectors.push(await this.model.embed(body, false));
      if (vectors.length !== batch.length) throw new Error('Incomplete embedding batch');
      const embeddings = vectors.map(vector => {
        if (!validEmbedding(vector)) throw new Error('Invalid embedding');
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
  /** Resolve only selected prepared records. No corpus scan or index writes. */
  private loadPrepared(ref: string, scope: Partial<HistoryQuery>) {
    if (this.current.has(ref)) return true;
    const cached = this.db.prepare('SELECT json FROM records WHERE ref=?').get(ref) as { json: string } | undefined;
    if (!cached) return false;
    const metadata: SourceRecord = JSON.parse(cached.json);
    if (!this.admitted(metadata, scope)) return false;
    for (const record of historySources(this.source, this.root, this.normalized, scope, metadata)) {
      if (record.ref !== ref) continue;
      const rows = this.db.prepare('SELECT c.offset,p.hash,p.embedded FROM chunk_links c JOIN passages p ON p.id=c.passage_id WHERE c.ref=? ORDER BY c.offset').all(ref) as { offset: number; hash: string; embedded: number }[];
      const expected = [...passages(record, this.model.fingerprint)];
      if (rows.length !== expected.length || rows.some((row, i) => row.offset !== expected[i].offset || row.hash !== expected[i].hash || row.embedded !== 1)) return false;
      this.current.set(ref, record);
      return true;
    }
    return false;
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
    if (!preparedOnly) await this.prepare(query, report);
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
    if (preparedOnly) this.current.clear();
    else this.refresh(false);
    const metadata = new Map<string, SourceRecord>();
    const record = (ref: string): SourceRecord | undefined => {
      if (!preparedOnly) return this.current.get(ref);
      if (!metadata.has(ref)) {
        const row = this.db.prepare('SELECT json FROM records WHERE ref=?').get(ref) as { json: string } | undefined;
        if (row) metadata.set(ref, { ...JSON.parse(row.json), text: '' });
      }
      return metadata.get(ref);
    };
    const lists: Chunk[][] = [];
    for (const [i, search] of searches.entries()) {
      const stop = new Set('the a an and or of to in on is it we i you our my what why how did do does was were have has had this that with for from about please are can could'.split(' '));
      const terms = [...new Set(search.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])].filter(term => !stop.has(term)).slice(0, 32);
      if (terms.length) lists.push(this.keywords(terms.map(term => `"${term}"`).join(' OR '), filter.sql, filter.args));
      lists.push(this.db.prepare(`SELECT c.id,c.ref,c.offset FROM passage_vectors v JOIN chunk_links c ON c.passage_id=v.rowid JOIN records r ON r.ref=c.ref
        WHERE v.embedding MATCH ? AND k=80 AND v.rowid IN (SELECT c.passage_id FROM chunk_links c JOIN passages p ON p.id=c.passage_id JOIN records r ON r.ref=c.ref WHERE p.embedded=1 ${filter.sql})
        AND v.distance<=0.25 ${filter.sql} GROUP BY c.passage_id ORDER BY v.distance,c.id LIMIT 80`)
        .all(Buffer.from(embeddings[i].buffer), ...filter.args, ...filter.args) as Chunk[]);
    }
    const limit = query.limit ?? 8;
    const firstChunk = (ref: string) => this.db.prepare('SELECT id,ref,offset FROM chunks WHERE ref=? AND embedded=1 ORDER BY offset LIMIT 1').get(ref) as Chunk | undefined;
    if (query.recent) lists.push((this.db.prepare(`SELECT r.ref FROM records r WHERE 1=1 ${filter.sql}
      ORDER BY r.at DESC,r.position DESC LIMIT 80`).all(...filter.args) as { ref: string }[])
      .flatMap(row => { const chunk = firstChunk(row.ref); return chunk ? [chunk] : []; }));
    const results: HistoryResults['results'] = [], seen = new Set<string>();
    const add = (chunk: Chunk) => {
      const item = record(chunk.ref);
      if (!item || !this.admitted(item, query) || seen.has(item.identity) || results.length >= limit) return;
      if (preparedOnly && !this.loadPrepared(chunk.ref, query)) return;
      const original = this.record(chunk.ref);
      seen.add(item.identity);
      results.push({ ...original, sequence: original.position, text: original.text.slice(chunk.offset, chunk.offset + 1600),
        offset: chunk.offset, score: 1, ...(chunk.offset ? { lead: original.text.slice(0, 400) } : {}) });
    };
    for (const ref of [...new Set(query.question.match(/\bH[a-f0-9]{24}\b/g) || [])].slice(0, 3)) {
      const item = record(ref), chunk = firstChunk(ref);
      if (!item || !this.admitted(item, query) || !chunk) throw new Error('Historical reference is outside this lookup scope or is not prepared.');
      add(chunk);
    }
    // Alternate search lists instead of assigning role, age or keyword bonuses.
    while (results.length < limit && lists.some(list => list.length)) {
      for (const list of lists) {
        const count = results.length;
        while (list.length && results.length === count) add(list.shift()!);
        if (results.length >= limit) break;
      }
    }
    return { mode: 'hybrid', results, limitations: LIMITATIONS + ' Search returns a selection of original records, not the entire archive.' };
  }
  private record(ref: string): SourceRecord {
    const record = this.current.get(ref);
    if (!record) throw new Error('This historical record is no longer admitted or its text changed. Search again.');
    return record;
  }
  read(ref: string, offset = 0, preparedBefore?: string): HistoryPage {
    if (preparedBefore) {
      this.current.clear();
      if (!this.loadPrepared(ref, { before: preparedBefore })) throw new Error('Historical source is unavailable or no longer prepared.');
      const item = this.record(ref);
      for (const direction of ['<', '>']) {
        const neighbor = this.db.prepare(`SELECT ref FROM records WHERE group_id=? AND position${direction}? AND json_extract(json,'$.identity')!=?
          ORDER BY position ${direction === '<' ? 'DESC' : 'ASC'} LIMIT 1`).get(item.group, item.position, item.identity) as { ref: string } | undefined;
        if (neighbor) this.loadPrepared(neighbor.ref, { before: preparedBefore });
      }
    }
    else this.refresh();
    const item = this.record(ref);
    const rows = this.db.prepare(`SELECT ref FROM records WHERE group_id=? ORDER BY COALESCE(at,''),position,ref`).all(item.group) as { ref: string }[];
    const records = rows.filter(row => this.current.has(row.ref)).map(row => this.record(row.ref)), at = records.findIndex(row => row.ref === ref);
    const before = records.slice(0, at).reverse().find(row => row.identity !== item.identity);
    const after = records.slice(at + 1).find(row => row.identity !== item.identity && row.identity !== before?.identity);
    const neighbors = [before, after].filter((row): row is SourceRecord => Boolean(row)).map(row => ({ ...row, sequence: row.position, text: row.text.slice(0, 600) }));
    return { record: { ...item, sequence: item.position, text: item.text.slice(offset, offset + HISTORY_PAGE_CHARACTERS) }, offset, total: item.text.length, neighbors };
  }
}
