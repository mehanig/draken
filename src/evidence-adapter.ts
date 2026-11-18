// Application wiring, deliberately outside the isolated evidence module.
import type { EvidenceDependencies } from './evidence';
import { readHistory, searchPreparedHistory } from './memory/service';
import { cleanText } from './sync/normalize';

export const evidenceDependencies: EvidenceDependencies = {
  search: (query, signal) => searchPreparedHistory(query, signal),
  read: (ref, offset, signal, before) => readHistory(ref, offset, signal, before),
  cleanText,
};
