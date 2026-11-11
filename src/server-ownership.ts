import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

/** Kernel-backed lifetime exclusion, independent of listener address and heartbeat.
 * A suspended owner retains its lock; process death releases it without PID trust
 * or a time-based takeover. This database never contains application records. */
export function ownServerDirectory(directory: string): () => void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, '.server-owner.sqlite');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Server ownership storage must not be a symlink.');
  const owner = new Database(file, { timeout: 0 });
  try {
    fs.chmodSync(file, 0o600);
    owner.exec('BEGIN EXCLUSIVE');
    owner.pragma('schema_version'); // Refuse corrupt/incompatible ownership storage.
  } catch (error) {
    owner.close();
    if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string }).code || '')) {
      throw new Error('Another server owns this data directory. Stop that server before retrying.');
    }
    throw new Error('Cannot establish exclusive server ownership. Check the private data directory and ownership file.');
  }
  return () => { if (owner.open) owner.close(); };
}
