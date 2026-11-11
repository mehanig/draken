import { digest } from '../sync/normalize';
import type { HistoryRecord } from './types';

// Persisted passage offsets/hashes depend on this recipe. A format change needs
// an index migration, not just a new display excerpt length.
export const PASSAGE_CHARACTERS = 800;
const STRIDE = 700;
type PassageSource = Pick<HistoryRecord, 'title' | 'role' | 'text'>;

export function passage(record: PassageSource, offset: number, fingerprint: string) {
  const body = `${record.title}\n${record.role}\n${record.text.slice(offset, offset + PASSAGE_CHARACTERS)}`;
  return { offset, body, hash: digest(fingerprint + '\0' + body) };
}

export function* passages(record: PassageSource, fingerprint: string) {
  for (let offset = 0; offset < record.text.length; offset += STRIDE) {
    yield passage(record, offset, fingerprint);
    if (offset + PASSAGE_CHARACTERS >= record.text.length) break;
  }
}
