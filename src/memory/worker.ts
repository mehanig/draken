import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { HistoryIndex } from './index';
import { EmbeddingPool } from './embedding-pool';
import { historyUpdate, type ReportHistory } from './types';
import { sourceRoots } from '../sources/registry';

// A private IPC child, not an HTTP service or tool runner. Native SQLite/vector
// work and embedding WASM cannot block the dashboard or audio event loop.
process.umask(0o077);
const directory = process.argv[2];
if (!process.send || !directory || !path.isAbsolute(directory) || !process.argv[3]) process.exit(1);
const roots = sourceRoots(JSON.parse(process.argv[3]));
const folder = path.join(directory, 'memory');
fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const source = new Database(path.join(directory, 'draken.db'), { readonly: true, fileMustExist: true });
source.pragma('query_only = ON'); source.pragma('busy_timeout = 5000');
const file = path.join(folder, 'index.sqlite'), db = new Database(file);
fs.chmodSync(file, 0o600);
const model = new EmbeddingPool(path.join(folder, 'model'));
const index = new HistoryIndex(db, source, model, roots);
let busy = false;
process.on('message', async (message: any) => {
  if (busy || !message || !Number.isSafeInteger(message.id)) return;
  busy = true;
  try {
    let lastSent = 0, stage = '';
    const report: ReportHistory = progress => {
      const now = Date.now();
      if (progress.stage !== stage || now - lastSent >= 250 || (progress.total > 0 && progress.completed === progress.total)) {
        stage = progress.stage; lastSent = now;
        process.send?.({ id: message.id, progress });
      }
    };
    let value;
    if (message.method === 'prepare') { await index.prepare({ before: message.before }, report); value = null; }
    else if (message.method === 'search') value = await index.search(message.query, report);
    else if (message.method === 'read') { report(historyUpdate('reading')); value = index.read(message.ref, message.offset); }
    else throw new Error('Unknown history operation');
    process.send?.({ id: message.id, value });
  } catch {
    // Never emit private source text, a model input, filesystem error or rejected
    // request diagnostics. The parent provides action-specific recovery wording.
    process.send?.({ id: message.id, error: true });
  } finally { busy = false; }
});
async function close() {
  // Let SQLite finish its normal checkpoint on orderly retirement. Abrupt exit
  // still leaves committed WAL work recoverable; no VACUUM or history pruning.
  try { await model.close(); db.close(); source.close(); } finally { process.exit(0); }
}
process.once('SIGTERM', close);
process.once('disconnect', close);
