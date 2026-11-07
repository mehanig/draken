import fs from 'fs';
import path from 'path';
import { digest, type NormalizedEntry, type NormalizationVersion } from './normalize';
import { identifySource, normalizeSource } from '../sources/adapters';
import { getSourceRoots, sourceRoots, type RootInput, type SourceIdentity } from '../sources/registry';

export const RECORD_BYTES = 8 * 1024 * 1024 + 1;
export function getSessionRoot(): string {
  return getSourceRoots().pi[0];
}
export interface RecordPointer { record_offset: number; record_bytes: number; record_hash: string }
export interface PointerRecord extends RecordPointer { value: any }
export function* fileRecords(fd: number, end: number, offset = 0): Generator<PointerRecord> {
  let pending = Buffer.alloc(0), position = offset, consumed = offset;
  while (position < end) {
    const buffer = Buffer.alloc(Math.min(65536, end - position));
    const read = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (!read) break;
    position += read; pending = Buffer.concat([pending, buffer.subarray(0, read)]);
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      const bytes = pending.subarray(0, newline + 1), start = consumed;
      consumed += bytes.length; pending = pending.subarray(newline + 1);
      if (bytes.length > RECORD_BYTES) throw new Error('Session record exceeds the 8 MiB safety limit');
      let value: unknown;
      try { value = JSON.parse(bytes.toString('utf8').trim()); } catch { value = undefined; }
      yield { value, record_offset: start, record_bytes: bytes.length, record_hash: digest(bytes) };
    }
    if (pending.length >= RECORD_BYTES) throw new Error('Session record exceeds the 8 MiB safety limit');
  }
}
export function verifySessionHeader(fd: number, id: string): void {
  verifySourceHeader(fd, { agent: 'pi', external_id: id, parser_version: 1 });
}
function verifySourceHeader(fd: number, source: SourceIdentity): void {
  const header = identifySource(source.agent, fileRecords(fd, Math.min(fs.fstatSync(fd).size, RECORD_BYTES)));
  if (header.external_id !== source.external_id || source.parser_version !== 1) throw new Error('Session header changed');
}
export function openSessionFile(file: string, root: string, identity?: string): number {
  const base = fs.realpathSync(root), real = fs.realpathSync(file), relative = path.relative(base, real);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !real.endsWith('.jsonl')) throw new Error('Session path is outside the configured source root');
  const before = fs.statSync(real), fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || (identity && identity !== `${stat.dev}:${stat.ino}`)) throw new Error('Session file identity changed');
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

/** Bounded, process-local normalization reuse. Never an evidence fallback: a
 * caller must verify fresh source bytes before consulting this cache. */
export class NormalizationCache {
  private entries = new Map<string, { value: NormalizedEntry; bytes: number }>();
  private bytes = 0;
  get(key: string): NormalizedEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.entries.set(key, entry); }
    return entry?.value;
  }
  put(key: string, value: NormalizedEntry) {
    if (this.entries.has(key)) return;
    const bytes = 512 + key.length * 2 + Object.values(value).reduce((sum, item) => sum + (typeof item === 'string' ? item.length * 2 : 8), 0);
    if (bytes > 32 * 1024 ** 2) return;
    while (this.bytes + bytes > 32 * 1024 ** 2 && this.entries.size) {
      const [old, entry] = this.entries.entries().next().value!; this.entries.delete(old); this.bytes -= entry.bytes;
    }
    // Detach short slices from potentially large parsed JSON strings. Structured
    // cloning preserves UTF-16 exactly, including historical clipping recipes.
    this.entries.set(key, { value: structuredClone(value), bytes }); this.bytes += bytes;
  }
}

/** One read batch; bounded descriptors, no writes/discovery or stale-text fallback. */
export class RecordReader {
  private files = new Map<string, number>();
  private entries = new Map<string, NormalizedEntry>();
  private roots;
  constructor(root: RootInput = getSourceRoots(), private cache?: NormalizationCache) { this.roots = sourceRoots(root); }
  read(session: string, file: string, pointer: RecordPointer, entryId: string, eventKey: string, version: NormalizationVersion = 2, identity?: string,
    source: SourceIdentity = { agent: 'pi', external_id: session, parser_version: 1 }): NormalizedEntry {
    if (!Number.isSafeInteger(pointer.record_offset) || pointer.record_offset < 0 || !Number.isSafeInteger(pointer.record_bytes) || pointer.record_bytes < 1 || pointer.record_bytes > RECORD_BYTES || !/^[a-f0-9]{64}$/.test(pointer.record_hash)) throw new Error('Invalid source pointer');
    const fileKey = JSON.stringify([session, file, identity, source]), key = JSON.stringify([fileKey, pointer.record_offset, pointer.record_bytes, pointer.record_hash, entryId, eventKey, version]);
    const prior = this.entries.get(key); if (prior) return prior;
    let fd = this.files.get(fileKey);
    if (fd === undefined) {
      if (this.files.size >= 32) { const [old, handle] = this.files.entries().next().value!; fs.closeSync(handle); this.files.delete(old); }
      for (const root of this.roots[source.agent] || []) { try { fd = openSessionFile(file, root, identity); break; } catch { /* Try only configured roots for this agent. */ } }
      if (fd === undefined) throw new Error('Session path is outside the configured source roots or unavailable');
      try { verifySourceHeader(fd, source); } catch (error) { fs.closeSync(fd); throw error; }
      this.files.set(fileKey, fd);
    }
    const bytes = Buffer.alloc(pointer.record_bytes);
    if (fs.readSync(fd, bytes, 0, bytes.length, pointer.record_offset) !== bytes.length || bytes.at(-1) !== 10 || digest(bytes) !== pointer.record_hash) throw new Error('Source record changed');
    const cacheKey = JSON.stringify([source.agent, source.parser_version, source.agent === 'pi' ? '' : source.external_id, source.agent === 'codex' ? pointer.record_offset : '', version, pointer.record_hash]);
    const entry = this.cache?.get(cacheKey) || normalizeSource(source, { ...pointer, value: JSON.parse(bytes.toString('utf8').trim()) }, version);
    if (!entry || entry.entry_id !== entryId || entry.event_key !== eventKey) throw new Error('Source entry changed');
    this.cache?.put(cacheKey, entry);
    this.entries.set(key, entry); return entry;
  }
  close() { for (const fd of this.files.values()) fs.closeSync(fd); this.files.clear(); this.entries.clear(); }
}
