// Invalidate local estimates immediately when source selection or foreground work changes.
// This is notification only: it never starts preparation or changes preferences.
let snapshot = { revision: 0, pending: 0 };
const listeners = new Set<() => void>();
export const previewInputs = () => snapshot;
export const subscribePreviewInputs = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function invalidatePreparationPreview(pendingDelta = 0) {
  snapshot = { revision: snapshot.revision + 1, pending: snapshot.pending + pendingDelta };
  listeners.forEach(listener => listener());
}
export async function changingPreviewInputs<T>(change: () => Promise<T>): Promise<T> {
  invalidatePreparationPreview(1);
  try { return await change(); }
  finally { invalidatePreparationPreview(-1); }
}
