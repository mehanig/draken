import { parentPort } from 'worker_threads';
import { openPreviewDb, closeDb } from '../db/schema';
import { previewSummaryInput } from './store';
import { SummaryTree } from './tree';
import { guardPreviewWrites } from './preview-metadata';

// This entrypoint has no scan, run creation, memory/native, or provider work.
// Originals are read at their actual paths; the only writable DB is the backup
// in this worker's private DRAKEN_DATA_DIR. The tree's provider-forbidden guard
// remains before build/call boundaries, independent of provider implementations.
async function main() {
  const db = openPreviewDb();
  try {
    guardPreviewWrites(db);
    const tree = SummaryTree.forPreview(previewSummaryInput(), new AbortController().signal);
    const counts = await tree.previewCounts();
    tree.verifyFinal();
    const checkedAt = Date.now();
    closeDb();
    parentPort!.postMessage({ counts, checkedAt });
  } finally { closeDb(); }
}
// No private paths, original contents, or provider errors in IPC/log output.
void main().catch(() => { process.exitCode = 1; }).finally(() => parentPort?.close());
