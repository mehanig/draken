import type Database from 'better-sqlite3';
import type { Evidence, NodeSummary } from '../types';
import { EvidenceReader, withEvidenceRef } from '../db/evidence';
import { NormalizationCache } from './jsonl';
import { digest, sourceKey } from './normalize';
import { EvidenceScope, evidenceIdentities } from './evidence-scope';
import { EntryReader } from './source-files';
import { cleanText } from './normalize';
import { admittedAgent } from '../sources/registry';

export interface LeafInput {
  session: string;
  workspace: string;
  chronological_chunk?: number;
  frozen_text?: true; // Deployed pre-multi-agent v1/v2 transport used the frozen projection verbatim.
  evidence: Evidence[];
  background: Evidence[];
}
export interface LeafReceipt {
  key: string;
  model: string;
  recipe: string;
  batch: number;
  input_json: string;
  output_hash: string;
}

/** One verified-original reader per planning pass. Receipts contain pointers,
 * never transcript copies; every dependency (including uncited background) is
 * checked before a leaf can be admitted. This module has no store/tree imports. */
export class ReusableLeaves {
  private reader: EvidenceReader;
  private reads = new Map<string, Evidence | null>();
  private historicalReads = new Map<string, Evidence | null>();
  private readonly normalization = new NormalizationCache();
  private readonly scope: EvidenceScope;
  constructor(private db: Database.Database, frozenScope: Iterable<Evidence> = [], known: Iterable<Evidence> = frozenScope) {
    this.reader = new EvidenceReader(db, undefined, this.normalization);
    this.scope = new EvidenceScope(db, [...frozenScope].map(item => JSON.parse(this.reader.freeze(item))));
    // The snapshot already read these append-only records. Reuse those objects
    // when loading saved batch receipts instead of reading the same files again.
    for (const item of known) this.reads.set(evidenceIdentities(JSON.parse(this.reader.freeze(item)))[0], item);
  }
  /** Cached records are append-only; only current source consent can revoke
   * their use between awaits. Do not reread every original at each tree node. */
  verify(items: Iterable<Evidence>) {
    const included = new Set((this.db.prepare(`SELECT s.id FROM agent_sessions s
      WHERE s.included=1 AND s.missing=0 AND ${admittedAgent('s')}`).all() as { id: string }[]).map(row => row.id));
    for (const item of items) if (!included.has(item.session_id)) throw new Error('Original source is excluded or unavailable.');
  }
  close() { this.reader.close(); }
  read(value: string | Record<string, unknown>): Evidence | undefined {
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    const metadata = JSON.parse(encoded), key = evidenceIdentities(metadata)[0];
    if (!this.reads.has(key)) {
      try { this.scope.assert(metadata); this.reads.set(key, this.reader.read(metadata)); }
      catch { this.reads.set(key, null); }
    }
    const item = this.reads.get(key);
    return item ? withEvidenceRef(item, metadata.ref) : undefined;
  }
  decode(value: string): LeafInput | undefined {
    try {
      const data = JSON.parse(value);
      const evidence = data.evidence.map((item: Record<string, unknown>) => this.read(item));
      const background = data.background.map((item: Record<string, unknown>) => this.read(item));
      if (!evidence.length || [...evidence, ...background].some(item => !item)) return;
      return { ...data, evidence, background };
    } catch { return; }
  }
  encode(input: LeafInput, historicalBoundary = false): string {
    const freeze = (item: Evidence) => {
      const value = this.reader.freeze(item);
      if (!historicalBoundary && !this.read(value)) throw new Error('Original leaf evidence is unavailable, changed or excluded; no paid replacement was requested.');
      return JSON.parse(value);
    };
    return JSON.stringify({ ...input, evidence: input.evidence.map(freeze), background: input.background.map(freeze) });
  }
  save(key: string, model: string, recipe: string, batch: boolean, input: string, output: string) {
    this.db.prepare(`INSERT OR REPLACE INTO summary_leaf_inputs(key,model,recipe,batch,input_json,output_hash)
      VALUES (?,?,?,?,?,?)`).run(key, model, recipe, Number(batch), input, digest(output));
  }
  frozenContext(items: Evidence[]): string { return JSON.stringify(items.map(item => JSON.parse(this.reader.freeze(item)))); }
  /** Retain the selected pointer's identity, not merely its canonical citation ID. */
  identities(item: Evidence): [string, string] { return evidenceIdentities(JSON.parse(this.reader.freeze(item))); }

  /** Reconstruct the deployed preview's bounded context from verified indexed
   * originals. Exact historical cache keys, not this reconstruction, prove reuse. */
  backgroundContext(items: Evidence[]): Evidence[] {
    const first = new Map<string, number>();
    for (const item of items) first.set(item.session_id, Math.min(first.get(item.session_id) ?? Infinity, item.sequence ?? Infinity));
    const reader = new EntryReader(this.db), context: Evidence[] = [], seen = new Set(items.map(sourceKey));
    let chars = 0;
    try {
      for (const [session, sequence] of first) {
        const rows = this.db.prepare(`SELECT s.agent,e.id AS source_id,e.event_key,e.session_id,s.name AS session_name,s.path AS source_path,
          s.cwd,e.entry_id,e.timestamp,e.role FROM agent_entries e JOIN agent_sessions s ON s.id=e.session_id
          WHERE e.session_id=? AND e.active=1 AND e.present=1 AND e.id<? AND e.effective_length>0 ORDER BY e.id DESC LIMIT 6`).all(session, sequence) as any[];
        for (const { source_id, ...metadata } of rows.reverse()) {
          const item = { ...metadata, ref: `C${context.length + 1}`, text: cleanText(reader.effective(source_id), 2000) } as Evidence;
          if (seen.has(sourceKey(item))) continue;
          const cost = JSON.stringify(item).length;
          if (chars + cost > 24000) break;
          chars += cost; context.push(item); seen.add(sourceKey(item));
        }
      }
      return context;
    } finally { reader.close(); }
  }

  receipts(model: string): LeafReceipt[] {
    return this.db.prepare('SELECT * FROM summary_leaf_inputs WHERE model=? ORDER BY rowid').all(model) as LeafReceipt[];
  }
  /** Historical projections are ONLY for exact-key boundary reconstruction.
   * Admission still goes through encode/read, including every background input. */
  private historical(value: string | Record<string, unknown>): Evidence | undefined {
    const metadata = typeof value === 'string' ? JSON.parse(value) : value;
    const { ref: _ref, ...identity } = metadata;
    const key = JSON.stringify(identity);
    if (!this.historicalReads.has(key)) {
      try { this.historicalReads.set(key, this.reader.read(metadata)); }
      catch { this.historicalReads.set(key, null); }
    }
    return this.historicalReads.get(key) || undefined;
  }
  async yield(signal: AbortSignal) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (signal.aborted) throw new Error('Generation cancelled');
  }
  /** Read only frozen inputs, never getSync (which also performs unrelated
   * presentation/accounting work). Unavailable sessions need not poison others. */
  async snapshots(relevant: Set<string>, signal: AbortSignal, ids?: Set<number>): Promise<{ id: number; items: Evidence[]; context: Evidence[] }[]> {
    const contexts = new Map((this.db.prepare('SELECT id,context_json FROM syncs ORDER BY id').all() as { id: number; context_json: string }[])
      .map(row => [row.id, row.context_json]));
    const groups = new Map<number, Map<string, Evidence[]>>();
    const invalid = new Map<number, Set<string>>();
    let count = 0;
    for (const row of this.db.prepare('SELECT sync_id,evidence_json FROM sync_items ORDER BY sync_id,rowid').iterate() as Iterable<{ sync_id: number; evidence_json: string }>) {
      if (++count % 128 === 0) await this.yield(signal);
      if (ids && !ids.has(row.sync_id)) continue;
      let metadata;
      try { metadata = JSON.parse(row.evidence_json); } catch { continue; }
      if (!relevant.has(metadata.session_id)) continue;
      if (!groups.has(row.sync_id)) groups.set(row.sync_id, new Map());
      const group = groups.get(row.sync_id)!;
      const item = this.historical(row.evidence_json);
      if (!item) {
        if (!invalid.has(row.sync_id)) invalid.set(row.sync_id, new Set());
        invalid.get(row.sync_id)!.add(metadata.session_id);
      } else {
        if (!group.has(item.session_id)) group.set(item.session_id, []);
        group.get(item.session_id)!.push(item);
      }
    }
    const result = [];
    for (const [id, sessions] of groups) {
      const context: Evidence[] = [];
      try {
        for (const value of JSON.parse(contexts.get(id) || '[]')) {
          if (!relevant.has(value.session_id)) continue;
          const item = this.historical(value);
          if (item) context.push(item);
          else {
            if (!invalid.has(id)) invalid.set(id, new Set());
            invalid.get(id)!.add(value.session_id);
          }
        }
      } catch { continue; }
      result.push({ id, items: [...sessions].filter(([session]) => !invalid.get(id)?.has(session)).flatMap(([, items]) => items), context });
    }
    return result;
  }
}

/** Bounded replay of deployed packing recipes. This layer discovers keys only;
 * the caller must validate output and every current dependency before admission. */
export class HistoricalLeafReplay<S extends { key: string }, I extends { items: Evidence[]; context: Evidence[] }> {
  private replayed = new Map<string, { legacy: S[]; masks: Set<string> }>();
  private sessions = new WeakMap<Evidence[], Map<string, Evidence[]>>();
  constructor(private options: {
    db: Database.Database; primary: Set<string>; batch: boolean; version: string; recipe: string;
    caches: Map<string, { prompt_version: string; output_json: string }>;
    needsRecovery(key: string): boolean;
    yield(): Promise<void>;
    identity(input: I): string;
    legacy(input: I, frozenText?: boolean): S[];
    batches(input: I, keys: Set<string>, midpoint: boolean): Promise<S[]>;
    valid(spec: S, before?: string): boolean;
    discover(spec: S): void;
  }) {}
  private possible(input: I, targets: Set<string>): boolean {
    const { caches, version, needsRecovery } = this.options;
    const allowed = new Set([...input.items, ...input.context].map(sourceKey));
    return [...targets].some(key => {
      const row = caches.get(key);
      if (!row || row.prompt_version !== version || !needsRecovery(key)) return false;
      // Citation membership only prunes impossible requests. It NEVER proves
      // primary membership, boundaries, or successful cached coverage.
      try { return (JSON.parse(row.output_json) as NodeSummary).observations.every(item => item.evidence.every(ref => allowed.has(ref))); }
      catch { return false; }
    });
  }
  private async session(input: I, times: string[], targets: Set<string>) {
    const o = this.options;
    await o.yield();
    const identity = o.identity(input);
    if (!this.replayed.has(identity)) {
      const legacy = o.legacy(input);
      legacy.forEach(spec => o.discover(spec));
      if ([...input.items, ...input.context].some(item => item.text !== cleanText(item.text, Number.MAX_SAFE_INTEGER))) {
        o.legacy(input, true).forEach(spec => o.discover(spec));
      }
      this.replayed.set(identity, { legacy, masks: new Set() });
    }
    const { legacy, masks } = this.replayed.get(identity)!;
    if (!o.batch || !this.possible(input, targets)) return;
    // Before a run's own leaves existed, legacy-cache islands could differ.
    // Explore observed run-time masks and the empty mask, never arbitrary subsets.
    for (const before of [undefined, '', ...times]) {
      if (!this.possible(input, targets)) break;
      const mask = legacy.map(spec => before === '' ? false : o.valid(spec, before));
      const signature = JSON.stringify(mask);
      const unresolvedBefore = [...targets].filter(o.needsRecovery).sort();
      const attempt = digest(JSON.stringify(['historical-replay-v2-frozen-text-midpoint', identity, signature,
        o.recipe, unresolvedBefore.map(key => [key, digest(o.caches.get(key)!.output_json)])]));
      if (o.db.prepare('SELECT 1 FROM summary_replay_attempts WHERE identity=?').get(attempt)) continue;
      const keys = new Set(legacy.filter((_, index) => mask[index]).map(spec => spec.key));
      if (!masks.has(signature)) {
        masks.add(signature);
        (await o.batches(input, keys, false)).forEach(spec => o.discover(spec));
      }
      // Pre-stable-prefix v3 split oversized wire requests at recursive midpoints.
      if (this.possible(input, targets) && !masks.has(`${signature}:midpoint`)) {
        masks.add(`${signature}:midpoint`);
        (await o.batches(input, keys, true)).forEach(spec => o.discover(spec));
      }
      // Persist only exhausted attempts, not successes whose receipts could be
      // evicted. Identity includes actual inputs, recipes, masks and target hashes.
      if (unresolvedBefore.every(o.needsRecovery)) o.db.prepare('INSERT OR IGNORE INTO summary_replay_attempts(identity) VALUES (?)').run(attempt);
    }
  }
  async replay(input: I, times: string[], targets: Set<string>): Promise<void> {
    let sessions = this.sessions.get(input.items);
    if (!sessions) {
      sessions = new Map<string, Evidence[]>();
      for (const item of input.items) {
        if (!sessions.has(item.session_id)) sessions.set(item.session_id, []);
        sessions.get(item.session_id)!.push(item);
      }
      this.sessions.set(input.items, sessions);
    }
    for (const [session, items] of sessions) {
      if (!items.some(item => this.options.primary.has(sourceKey(item)))) continue;
      await this.session({ ...input, items, context: input.context.filter(item => item.session_id === session).slice(-6) }, times, targets);
    }
  }
}

export const checkpointIdentity = (item: Evidence) => digest(JSON.stringify([item.agent || 'pi', item.session_id, item.entry_id]));
export const checkpointContent = (item: Evidence) => digest(JSON.stringify([sourceKey(item), item.agent, item.session_id, item.cwd, item.timestamp, item.role]));
