import type Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';

interface Result {
  counts: { cached: number; needs_processing: number; total: number };
  checkedAt: number;
}

/** Resolve only after real worker exit, not a message or cancellation request.
 * Worker termination also closes unmanaged source file descriptors. */
async function runPreviewWorker(directory: string, signal: AbortSignal, environment: NodeJS.ProcessEnv): Promise<Result> {
  signal.throwIfAborted();
  const worker = new Worker(path.join(__dirname, 'preview-worker.js'), {
    env: { ...environment, DRAKEN_DATA_DIR: directory },
    stdout: true, stderr: true,
  });
  // Discard any accidental dependency logging; it must not expose source data.
  worker.stdout.resume(); worker.stderr.resume();
  let termination: Promise<number> | undefined;
  const abort = () => { termination ||= worker.terminate(); };
  try {
    return await new Promise<Result>((resolve, reject) => {
      let result: Result | undefined, failed = false;
      worker.on('message', (value: Result) => {
        const c = value?.counts;
        if (result || !c || ![c.cached, c.needs_processing, c.total].every(n => Number.isSafeInteger(n) && n >= 0) ||
          c.cached + c.needs_processing !== c.total || !Number.isSafeInteger(value.checkedAt)) {
          failed = true; abort(); return;
        }
        result = value;
      });
      worker.on('error', () => { failed = true; });
      worker.once('exit', code => {
        if (code !== 0 || failed || !result || signal.aborted) reject(new Error('Local preview worker did not complete'));
        else resolve(result);
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally {
    signal.removeEventListener('abort', abort);
    await termination;
  }
}

/** Lease owner calls this AFTER draining indexing/native retirement. Backup
 * transfers at most 64 pages per event-loop turn; cancellation is checked at
 * each step, and backup.close() runs before its promise rejects. */
export async function withPreviewClone<T>(db: Database.Database, signal: AbortSignal,
  use: (file: string, result: Result) => T): Promise<T> {
  signal.throwIfAborted();
  // Capture roots/model environment in the parent's guarded generation BEFORE
  // any await, not after backup (even a change-and-restore must not alter which
  // configuration the worker actually planned).
  const environment = { ...process.env };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'draken-preview-'));
  try {
    await fs.chmod(directory, 0o700);
    const file = path.join(directory, 'draken.db');
    await fs.writeFile(file, '', { mode: 0o600, flag: 'wx' });
    signal.throwIfAborted();
    await db.backup(file, { progress: () => { signal.throwIfAborted(); return 64; } });
    signal.throwIfAborted();
    const result = await runPreviewWorker(directory, signal, environment);
    signal.throwIfAborted();
    return use(file, result);
  } finally {
    // Keep ownership through cleanup, even on a transient filesystem failure.
    // A permanently unavailable filesystem must not admit a replacement owner
    // while private resources remain. No errors containing private paths leak.
    for (;;) {
      try { await fs.rm(directory, { recursive: true, force: true }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  }
}
