import type { AutoIndexSettings } from '../types';

type UpdateStatus = Readonly<Pick<AutoIndexSettings, 'phase' | 'error' | 'pending_records'>>;
let current: { read: () => UpdateStatus } | undefined;

/** One metadata-only owner, without a conversation -> background import cycle.
 * A retiring owner's cleanup must not disconnect its replacement. */
export function registerUpdateStatus(read: () => UpdateStatus): () => void {
  const owner = { read };
  current = owner;
  return () => { if (current === owner) current = undefined; };
}

/** Unknown until background startup; never starts work or reads sources. */
export function backgroundUpdateStatus(): UpdateStatus | null {
  if (!current) return null;
  const { phase, error, pending_records } = current.read();
  return Object.freeze({ phase, error, pending_records });
}
