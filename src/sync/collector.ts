import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDataDir, getDb } from '../db/schema';
import { ScanResult } from '../types';
import { cleanText, digest, normalizeEntry, NormalizedEntry } from './normalize';

export function getSessionRoot(): string {
  return path.resolve(process.env.DRAKEN_PI_SESSIONS_DIR || path.join(os.homedir(), '.pi/agent/sessions'));
}

interface Source {
  id: string; path: string; cwd: string; name: string; byte_offset: number;
  file_identity: string; boundary_hash: string; prefix_hash: string;
  modified_at: string; leaf_id: string | null;
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function discover(root: string, warnings: string[]): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || inside(directory, getDataDir())) return;
    let children: fs.Dirent[];
    try { children = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch { warnings.push(`Cannot read session directory: ${directory}`); return; }
    for (const child of children) {
      const target = path.join(directory, child.name);
      // Do not walk symlinks into unrelated directories.
      if (child.isDirectory()) await visit(target, depth + 1);
      else if (child.isFile() && child.name.endsWith('.jsonl')) files.push(target);
    }
  };
  await visit(root, 0);
  return files.sort();
}

async function hashRegion(file: fs.promises.FileHandle, start: number, length: number): Promise<string> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, start);
  return digest(buffer.subarray(0, bytesRead));
}

/** Read only complete LF-terminated records. Never mutate a pi session file. */
async function readRecords(file: string, offset: number, size: number, warnings: string[]) {
  const records: any[] = [];
  let pending = Buffer.alloc(0);
  let consumed = offset;
  const end = Math.min(size, offset + 32 * 1024 * 1024);
  if (end <= offset) return { records, offset };
  for await (const chunk of fs.createReadStream(file, { start: offset, end: end - 1 })) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, newline).toString('utf8').trim();
      consumed += newline + 1;
      pending = pending.subarray(newline + 1);
      if (!line) continue;
      try { records.push(JSON.parse(line)); }
      catch { warnings.push(`Skipped malformed JSON in ${file} near byte ${consumed}.`); }
    }
    if (pending.length > 8 * 1024 * 1024) {
      warnings.push(`Paused ${file}: a record exceeds the 8 MiB safety limit.`);
      break;
    }
  }
  if (end < size) warnings.push(`Large session ${file}: scan again to index the remaining records.`);
  return { records, offset: consumed };
}

function updateProjection(sessionId: string, leaf: string | null): void {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM pi_entries WHERE session_id = ? AND present = 1 ORDER BY id').all(sessionId) as any[];
  const byId = new Map(rows.map(row => [row.entry_id, row]));
  const branch: any[] = [];
  const visited = new Set<string>();
  let cursor = leaf;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    branch.push(entry);
    cursor = entry.parent_id;
  }
  branch.reverse();
  db.prepare('UPDATE pi_entries SET active = 0, effective_text = text WHERE session_id = ?').run(sessionId);
  const activate = db.prepare('UPDATE pi_entries SET active = 1 WHERE id = ?');
  for (const row of branch) activate.run(row.id);
  // Context edits are branch-relative. Null replacements omit the target.
  const edit = db.prepare('UPDATE pi_entries SET effective_text = ? WHERE session_id = ? AND entry_id = ? AND active = 1');
  for (const row of branch) {
    if (row.type === 'context_edit' && row.target_id) edit.run(row.replacement || '', sessionId, row.target_id);
  }
}

async function indexFile(filePath: string, warnings: string[]): Promise<{ id?: string; added: number }> {
  const db = getDb();
  const previous = db.prepare('SELECT * FROM pi_sessions WHERE path = ?').get(filePath) as Source | undefined;
  const file = await fs.promises.open(filePath, 'r');
  try {
    const stat = await file.stat();
    const identity = `${stat.dev}:${stat.ino}`;
    const modified = stat.mtime.toISOString();
    let reset = !previous || previous.file_identity !== identity || stat.size < previous.byte_offset;
    if (previous && !reset) {
      const boundary = await hashRegion(file, Math.max(0, previous.byte_offset - 256), Math.min(256, previous.byte_offset));
      const prefix = await hashRegion(file, 0, Math.min(512, previous.byte_offset));
      reset = boundary !== previous.boundary_hash || prefix !== previous.prefix_hash ||
        (stat.size === previous.byte_offset && modified !== previous.modified_at);
      if (!reset && stat.size === previous.byte_offset && modified === previous.modified_at) {
        return { id: previous.id, added: 0 };
      }
    }
    const result = await readRecords(filePath, reset ? 0 : previous!.byte_offset, stat.size, warnings);
    let header = reset ? result.records.find(row => row?.type === 'session') : undefined;
    if (!reset) header = { id: previous!.id, cwd: previous!.cwd, version: 3 };
    if (!header || typeof header.id !== 'string' || typeof header.cwd !== 'string') {
      warnings.push(`No complete pi session header in ${filePath}.`);
      return { added: 0 };
    }
    if (header.version !== 3) {
      warnings.push(`Unsupported session version in ${filePath}; this prototype reads pi v3 JSONL.`);
      return { added: 0 };
    }
    if (inside(path.resolve(header.cwd), getDataDir())) return { added: 0 };
    const duplicate = db.prepare('SELECT path FROM pi_sessions WHERE id = ?').get(header.id) as { path: string } | undefined;
    if (duplicate && duplicate.path !== filePath && fs.existsSync(duplicate.path)) {
      warnings.push(`Ignored duplicate session ${header.id} at ${filePath}.`);
      return { id: header.id, added: 0 };
    }
    const entries: NormalizedEntry[] = [];
    let name = reset ? '' : previous!.name;
    let leaf = reset ? null : previous!.leaf_id;
    for (const record of result.records) {
      if (record?.type === 'session') continue;
      if (record?.type === 'session_info' && typeof record.name === 'string') name = cleanText(record.name, 200);
      const entry = normalizeEntry(record);
      if (entry) {
        entries.push(entry);
        leaf = entry.entry_id;
        if (!name && entry.role === 'user' && entry.text) name = cleanText(entry.text.replace(/\s+/g, ' '), 100);
      }
    }
    const boundary = await hashRegion(file, Math.max(0, result.offset - 256), Math.min(256, result.offset));
    const prefix = await hashRegion(file, 0, Math.min(512, result.offset));
    return db.transaction(() => {
      // A replacement file may represent a different session; retain its old evidence/history.
      if (previous && previous.id !== header.id) {
        db.prepare('UPDATE pi_sessions SET path = ?, missing = 1 WHERE id = ?').run(`${filePath}#replaced:${previous.id}`, previous.id);
      }
      db.prepare(`INSERT INTO pi_sessions(id, path, cwd, name, modified_at, file_identity, byte_offset, boundary_hash, prefix_hash, leaf_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET path=excluded.path, cwd=excluded.cwd, name=excluded.name,
        modified_at=excluded.modified_at, file_identity=excluded.file_identity, byte_offset=excluded.byte_offset,
        boundary_hash=excluded.boundary_hash, prefix_hash=excluded.prefix_hash, leaf_id=excluded.leaf_id, missing=0`).run(
        header.id, filePath, header.cwd, name, modified, identity, result.offset, boundary, prefix, leaf,
      );
      if (reset) db.prepare('UPDATE pi_entries SET present = 0, active = 0 WHERE session_id = ?').run(header.id);
      const upsert = db.prepare(`INSERT INTO pi_entries
        (session_id, entry_id, parent_id, timestamp, type, role, text, effective_text, event_key, is_activity, target_id, replacement)
        VALUES (@session_id, @entry_id, @parent_id, @timestamp, @type, @role, @text, @text, @event_key, @is_activity, @target_id, @replacement)
        ON CONFLICT(session_id, entry_id) DO UPDATE SET parent_id=excluded.parent_id, timestamp=excluded.timestamp,
        type=excluded.type, role=excluded.role, text=excluded.text, effective_text=excluded.text, event_key=excluded.event_key,
        is_activity=excluded.is_activity, target_id=excluded.target_id, replacement=excluded.replacement, present=1`);
      let added = 0;
      const exists = db.prepare('SELECT 1 FROM pi_entries WHERE session_id = ? AND entry_id = ?');
      for (const entry of entries) {
        if (!exists.get(header.id, entry.entry_id)) added++;
        upsert.run({ ...entry, session_id: header.id });
      }
      updateProjection(header.id, leaf);
      return { id: header.id as string, added };
    })();
  } finally { await file.close(); }
}

let scanning: Promise<ScanResult> | null = null;
export function scanSessions(): Promise<ScanResult> {
  if (scanning) return scanning;
  scanning = (async () => {
    const warnings: string[] = [];
    const root = getSessionRoot();
    if (!fs.existsSync(root)) {
      getDb().prepare('UPDATE pi_sessions SET missing = 1').run();
      return { files: 0, added: 0, warnings: [`Session directory not found: ${root}`] };
    }
    const files = await discover(root, warnings);
    const seen = new Set<string>();
    let added = 0;
    for (const file of files) {
      try {
        const result = await indexFile(file, warnings);
        if (result.id) seen.add(result.id);
        added += result.added;
      } catch (error) {
        warnings.push(`Could not index ${file}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    const db = getDb();
    db.transaction(() => {
      db.prepare('UPDATE pi_sessions SET missing = 1').run();
      const mark = db.prepare('UPDATE pi_sessions SET missing = 0 WHERE id = ?');
      for (const id of seen) mark.run(id);
    })();
    return { files: files.length, added, warnings: warnings.slice(0, 100) };
  })().finally(() => { scanning = null; });
  return scanning;
}
