import type Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { cleanText } from '../sync/normalize';
import { getSourceRoots, type RootInput } from '../sources/registry';
import { NormalizationCache } from '../sync/jsonl';
import { initHistoryStorage } from './storage';
import { digest, historySources, type SourceRecord } from './sources';
import { historyUpdate, type Embedder, type HistoryPage, type HistoryQuery, type HistoryResults, type ReportHistory } from './types';

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
    initHistoryStorage(db, model.fingerprint);
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
  async prepare(scope: Partial<HistoryQuery> = {}, report?: ReportHistory) {
    report?.(historyUpdate('scanning')); this.refresh();
    const filter = this.filter(scope);
    const groups = this.db.prepare(`SELECT DISTINCT p.id FROM passages p JOIN chunk_links c ON c.passage_id=p.id JOIN records r ON r.ref=c.ref
      WHERE p.embedded=0 ${filter.sql} ORDER BY p.id`).all(...filter.args) as { id: number }[];
    const reused = (this.db.prepare(`SELECT COUNT(DISTINCT p.id) n FROM passages p JOIN chunk_links c ON c.passage_id=p.id JOIN records r ON r.ref=c.ref
      WHERE p.embedded=1 ${filter.sql}`).get(...filter.args) as { n: number }).n;
    const total = groups.length;
    let completed = 0, computed = 0, meanMs = 0, measured = 0;
    const notify = (stage: 'loading' | 'indexing') => report?.(historyUpdate(stage, { total, completed, reused, parallelism: this.model.parallelism,
      remaining_seconds: completed === total ? 0 : measured >= 8 ? Math.ceil((total - completed) * meanMs / 1000) : null }));
    if (!total) { notify('indexing'); return; }
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
  }
  private async ensureModel(report?: ReportHistory) {
    if (!this.modelPrepared || !this.model.ready()) { await this.model.setup(report); this.modelPrepared = true; }
  }
  private filter(query: Partial<HistoryQuery>) {
    const conditions: string[] = [], args: (string | number)[] = [];
    if (query.session_id) { conditions.push('r.session_id=?'); args.push(query.session_id); }
    if (query.sync_id) { conditions.push('r.sync_id=?'); args.push(query.sync_id); }
    if (query.before) { conditions.push('r.at IS NOT NULL AND r.at<=?'); args.push(query.before); }
    return { sql: conditions.length ? ' AND ' + conditions.join(' AND ') : '', args };
  }
  async search(query: HistoryQuery, report?: ReportHistory): Promise<HistoryResults> {
    await this.prepare(query, report);
    report?.(historyUpdate('searching'));
    const filter = this.filter(query);
    const any = this.db.prepare(`SELECT 1 FROM chunks c JOIN records r ON r.ref=c.ref WHERE 1=1 ${filter.sql} LIMIT 1`).get(...filter.args);
    if (!any) return { mode: 'hybrid', results: [], limitations: LIMITATIONS };
    await this.ensureModel(report);
    const embedding = await this.model.embed(cleanText(query.question, 2000), true);
    // Prune exclusions/edits again after inference without admitting unembedded
    // arrivals. All returned candidates have both lexical and semantic coverage.
    this.refresh(false);
    const scores = new Map<string, { score: number; chunk: Chunk }>();
    const add = (rows: Chunk[]) => {
      const distinct = new Set<string>();
      for (const row of rows) {
        const identity = this.record(row.ref).identity;
        if (distinct.has(identity)) continue; distinct.add(identity);
        const old = scores.get(identity), score = 1 / (60 + distinct.size);
        scores.set(identity, { score: (old?.score || 0) + score, chunk: old?.chunk || row });
      }
    };
    const stop = new Set('the a an and or of to in on is it we i you our my what why how did do does was were have has had this that with for from about remember recall previous earlier history please'.split(' '));
    const terms = [...new Set(query.question.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])].filter(term => !stop.has(term)).slice(0, 32);
    if (terms.length) add(this.db.prepare(`SELECT c.id,c.ref,c.offset FROM words JOIN chunks c ON c.id=words.rowid JOIN records r ON r.ref=c.ref
      WHERE words MATCH ? AND c.embedded=1 ${filter.sql} ORDER BY bm25(words),c.id LIMIT 80`).all(terms.map(term => `"${term}"`).join(' OR '), ...filter.args) as Chunk[]);
    add(this.db.prepare(`SELECT c.id,c.ref,c.offset FROM passage_vectors v JOIN chunk_links c ON c.passage_id=v.rowid JOIN records r ON r.ref=c.ref
      WHERE v.embedding MATCH ? AND k=80 AND v.rowid IN (SELECT c.passage_id FROM chunk_links c JOIN passages p ON p.id=c.passage_id JOIN records r ON r.ref=c.ref WHERE p.embedded=1 ${filter.sql})
      AND v.distance<=0.25 ${filter.sql} ORDER BY v.distance,c.id LIMIT 80`).all(Buffer.from(embedding.buffer), ...filter.args, ...filter.args) as Chunk[]);
    const results = [...scores.values()].sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id).slice(0, 8).map(({ chunk, score }) => {
      const record = this.record(chunk.ref);
      return { ...record, text: record.text.slice(chunk.offset, chunk.offset + 800), offset: chunk.offset, score };
    });
    return { mode: 'hybrid', results, limitations: LIMITATIONS + ' Records arriving or changing during this lookup are considered by the next lookup.' };
  }
  private record(ref: string): SourceRecord {
    const record = this.current.get(ref);
    if (!record) throw new Error('This historical record is no longer admitted or its text changed. Search again.');
    return record;
  }
  read(ref: string, offset = 0): HistoryPage {
    this.refresh(); const item = this.record(ref);
    const rows = this.db.prepare(`SELECT ref FROM records WHERE group_id=? ORDER BY COALESCE(at,''),position,ref`).all(item.group) as { ref: string }[];
    const records = rows.map(row => this.record(row.ref)), at = records.findIndex(row => row.ref === ref);
    const before = records.slice(0, at).reverse().find(row => row.identity !== item.identity);
    const after = records.slice(at + 1).find(row => row.identity !== item.identity && row.identity !== before?.identity);
    const neighbors = [before, after].filter((row): row is SourceRecord => Boolean(row)).map(row => ({ ...row, text: row.text.slice(0, 600) }));
    return { record: { ...item, text: item.text.slice(offset, offset + 4000) }, offset, total: item.text.length, neighbors };
  }
}
