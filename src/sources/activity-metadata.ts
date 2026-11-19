import type { FileHandle } from 'node:fs/promises';
import type { SourceHeader } from './adapters';
import { normalizeSource } from './adapters';
import { fileRecords, RECORD_BYTES, type PointerRecord } from '../sync/jsonl';

function message(source: SourceHeader, record: PointerRecord) {
  const entry = normalizeSource(source, record);
  if (!entry?.is_activity) return null;
  const time = Date.parse(entry.timestamp);
  if (!Number.isFinite(time)) throw new Error('Message activity time is missing or invalid');
  return { at: new Date(time).toISOString(), preview: entry.text.replace(/\s+/g, ' ').slice(0, 240) };
}

/** Inspect the edges, not every transcript body. Ignore an unfinished final line. */
export async function activityMetadata(file: FileHandle, size: number, source: SourceHeader, signal?: AbortSignal) {
  let first: ReturnType<typeof message> = null, last: ReturnType<typeof message> = null;
  for (const record of fileRecords(file.fd, size)) {
    signal?.throwIfAborted(); first = message(source, record); if (first) break;
  }
  let end = size, pending = Buffer.alloc(0), discardPartial = true;
  while (end > 0 && !last) {
    signal?.throwIfAborted();
    const start = Math.max(0, end - 65536), chunk = Buffer.alloc(end - start);
    const read = await file.read(chunk, 0, chunk.length, start);
    if (read.bytesRead !== chunk.length) throw new Error('Session changed while reading activity');
    pending = Buffer.concat([chunk, pending]); end = start;
    let newline: number;
    while ((newline = pending.lastIndexOf(10)) >= 0) {
      const line = pending.subarray(newline + 1); pending = pending.subarray(0, newline);
      if (discardPartial) { discardPartial = false; continue; }
      if (line.length > RECORD_BYTES) throw new Error('Session activity record exceeds 8 MiB');
      if (!line.toString('utf8').trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line.toString('utf8')); } catch { throw new Error('Session activity contains malformed JSON'); }
      last = message(source, { value, record_offset: start + newline + 1, record_bytes: line.length + 1, record_hash: '' });
      if (last) break;
    }
    if (pending.length > RECORD_BYTES) throw new Error('Session activity record exceeds 8 MiB');
  }
  return { first_message_at: first?.at ?? null, last_message_at: last?.at ?? first?.at ?? null, last_message_preview: last?.preview ?? first?.preview ?? '' };
}
