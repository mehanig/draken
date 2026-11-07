import fs from 'fs';
import path from 'path';
import { getDataDir, getDb } from '../db/schema';
import { ScanResult, type AgentKind } from '../types';
import { cleanText, digest, NormalizedEntry } from './normalize';
import { fileRecords, RECORD_BYTES, type RecordPointer } from './source-files';
import { getSourceRoots } from '../sources/registry';
import { identifySource, normalizeSource } from '../sources/adapters';

interface Source {
  id: string; agent: AgentKind; external_id: string; path: string; cwd: string; name: string; byte_offset: number;
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
async function readRecords(handle: fs.promises.FileHandle, file: string, offset: number, size: number, warnings: string[]) {
  const records: (RecordPointer & { value: any })[] = [];
  let pending = Buffer.alloc(0);
  let consumed = offset;
  const end = Math.min(size, offset + 32 * 1024 * 1024);
  if (end <= offset) return { records, offset };
  for await (const chunk of fs.createReadStream(file, { fd: handle.fd, autoClose: false, start: offset, end: end - 1 })) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      const bytes = pending.subarray(0, newline + 1), start = consumed;
      if (bytes.length > RECORD_BYTES) { warnings.push(`Paused ${file}: a record exceeds the 8 MiB safety limit.`); return { records, offset: consumed }; }
      const line = bytes.toString('utf8').trim();
      consumed += bytes.length;
      pending = pending.subarray(newline + 1);
      if (!line) continue;
      try { records.push({ value: JSON.parse(line), record_offset: start, record_bytes: bytes.length, record_hash: digest(bytes) }); }
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

function updateProjection(sessionId: string, leaf: string | null, agent: AgentKind): void {
  const db = getDb();
  if (agent === 'codex') { db.prepare('UPDATE agent_entries SET active=present,effective_length=text_length,effective_id=NULL WHERE session_id=?').run(sessionId); return; }
  const rows = db.prepare('SELECT * FROM agent_entries WHERE session_id = ? AND present = 1 ORDER BY id').all(sessionId) as any[];
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
  db.prepare('UPDATE agent_entries SET active=0,effective_length=text_length,effective_id=NULL WHERE session_id=?').run(sessionId);
  const activate = db.prepare('UPDATE agent_entries SET active = 1 WHERE id = ?');
  for (const row of branch) activate.run(row.id);
  // Context edits are branch-relative. Null replacements omit the target.
  const edit = db.prepare('UPDATE agent_entries SET effective_id=?,effective_length=? WHERE session_id=? AND entry_id=? AND active=1');
  for (const row of branch) {
    if (row.type === 'context_edit' && row.target_id) edit.run(row.id, row.replacement_length, sessionId, row.target_id);
  }
}

async function pointersMatch(file: fs.promises.FileHandle, sessionId: string): Promise<boolean> {
  const pointers = getDb().prepare('SELECT record_offset,record_bytes,record_hash FROM agent_entries WHERE session_id=? AND present=1').all(sessionId) as RecordPointer[];
  for (const pointer of pointers) {
    if (!Number.isSafeInteger(pointer.record_offset) || pointer.record_offset < 0 || !Number.isSafeInteger(pointer.record_bytes) || pointer.record_bytes < 1 || pointer.record_bytes > RECORD_BYTES || !pointer.record_hash) return false;
    const bytes = Buffer.alloc(pointer.record_bytes);
    const read = await file.read(bytes, 0, bytes.length, pointer.record_offset);
    if (read.bytesRead !== bytes.length || digest(bytes) !== pointer.record_hash) return false;
  }
  return true;
}

async function indexFile(filePath: string, agent: AgentKind, root: string, warnings: string[]): Promise<{ id?: string; added: number }> {
  const db = getDb();
  const previous = db.prepare('SELECT * FROM agent_sessions WHERE path = ?').get(filePath) as Source | undefined;
  if (previous && previous.agent !== agent) throw new Error('Session path belongs to another agent');
  const real = fs.realpathSync(filePath), base = fs.realpathSync(root);
  if (real === base || !inside(real, base)) throw new Error('Session path is outside its source root');
  const before = fs.statSync(real), file = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Session file identity changed');
    const header = identifySource(agent, fileRecords(file.fd, Math.min(stat.size, RECORD_BYTES)));
    if (inside(path.resolve(header.cwd), getDataDir())) return { added: 0 };
    const identity = `${stat.dev}:${stat.ino}`;
    const modified = stat.mtime.toISOString();
    let reset = !previous || previous.id !== header.id || previous.file_identity !== identity || stat.size < previous.byte_offset;
    if (previous && !reset) {
      const boundary = await hashRegion(file, Math.max(0, previous.byte_offset - 256), Math.min(256, previous.byte_offset));
      const prefix = await hashRegion(file, 0, Math.min(512, previous.byte_offset));
      reset = boundary !== previous.boundary_hash || prefix !== previous.prefix_hash ||
        (stat.size === previous.byte_offset && modified !== previous.modified_at);
      // A middle rewrite followed by an append can leave both prefix and old
      // tail unchanged. Verify old pointers before treating it as append-only.
      if (!reset && modified !== previous.modified_at) reset = !await pointersMatch(file, previous.id);
      if (!reset && stat.size === previous.byte_offset && modified === previous.modified_at) {
        return { id: previous.id, added: 0 };
      }
    }
    const warningStart = warnings.length;
    const result = await readRecords(file, filePath, reset ? 0 : previous!.byte_offset, stat.size, warnings);
    if (agent !== 'pi' && warnings.slice(warningStart).some(warning => warning.startsWith('Skipped malformed JSON'))) throw new Error('Malformed agent transcript; no partial record set was admitted');
    const duplicate = db.prepare('SELECT path,agent FROM agent_sessions WHERE id = ?').get(header.id) as { path: string; agent: AgentKind } | undefined;
    if (duplicate && duplicate.agent !== agent) throw new Error('Agent session ID collision');
    if (duplicate && duplicate.path !== filePath && fs.existsSync(duplicate.path)) {
      warnings.push(`Ignored duplicate session ${header.id} at ${filePath}.`);
      return { id: header.id, added: 0 };
    }
    const entries: (NormalizedEntry & RecordPointer)[] = [];
    let name = reset ? '' : previous!.name;
    let leaf = reset ? null : previous!.leaf_id;
    const identities = new Map<string, string>(agent === 'claude' && previous && !reset
      ? (db.prepare('SELECT entry_id,event_key FROM agent_entries WHERE session_id=? AND present=1').all(previous.id) as {entry_id:string;event_key:string}[]).map(row => [row.entry_id, row.event_key]) : []);
    for (const { value: record, ...pointer } of result.records) {
      if (agent === 'pi' && record?.type === 'session') continue;
      if (agent === 'pi' && record?.type === 'session_info' && typeof record.name === 'string') name = cleanText(record.name, 200);
      if (agent === 'claude' && record?.type === 'custom-title' && typeof record.customTitle === 'string') name = cleanText(record.customTitle, 200);
      const entry = normalizeSource(header, { ...pointer, value: record });
      if (entry) {
        if (agent === 'claude' && identities.has(entry.entry_id) && identities.get(entry.entry_id) !== entry.event_key) throw new Error('Conflicting Claude message UUID; no earlier content was overwritten');
        identities.set(entry.entry_id, entry.event_key);
        entries.push({ ...entry, ...pointer });
        // Claude progress/request metadata can carry UUIDs without selecting a
        // new conversation branch. Keep them as structural links only.
        if (agent !== 'claude' || ['user', 'assistant'].includes(record.type) || (record.type === 'system' && record.subtype === 'compact_boundary')) leaf = entry.entry_id;
        if (!name && entry.role === 'user' && entry.text) name = cleanText(entry.text.replace(/\s+/g, ' '), 100);
      }
    }
    if (agent === 'codex' && !entries.some(entry => entry.is_activity) && (!previous || reset) && result.records.some(record => record.value?.type === 'event_msg' && ['user_message', 'agent_message'].includes(record.value?.payload?.type))) {
      throw new Error('Codex event-only transcript layout is unsupported or not yet complete; response_item evidence is required');
    }
    const boundary = await hashRegion(file, Math.max(0, result.offset - 256), Math.min(256, result.offset));
    const prefix = await hashRegion(file, 0, Math.min(512, result.offset));
    return db.transaction(() => {
      // A replacement file may represent a different session; retain its old evidence/history.
      if (previous && previous.id !== header.id) {
        db.prepare('UPDATE agent_sessions SET path = ?, missing = 1 WHERE id = ?').run(`${filePath}#replaced:${previous.id}`, previous.id);
      }
      db.prepare(`INSERT INTO agent_sessions(id, path, cwd, name, modified_at, file_identity, byte_offset, boundary_hash, prefix_hash, leaf_id, agent, external_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET path=excluded.path, cwd=excluded.cwd, name=excluded.name,
        modified_at=excluded.modified_at, file_identity=excluded.file_identity, byte_offset=excluded.byte_offset,
        boundary_hash=excluded.boundary_hash, prefix_hash=excluded.prefix_hash, leaf_id=excluded.leaf_id, missing=0`).run(
        header.id, filePath, header.cwd, name, modified, identity, result.offset, boundary, prefix, leaf, agent, header.external_id,
      );
      if (reset) db.prepare('UPDATE agent_entries SET present = 0, active = 0 WHERE session_id = ?').run(header.id);
      const upsert = db.prepare(`INSERT INTO agent_entries
        (session_id,entry_id,parent_id,timestamp,type,role,event_key,is_activity,target_id,record_offset,record_bytes,record_hash,text_length,replacement_length,effective_length)
        VALUES (@session_id,@entry_id,@parent_id,@timestamp,@type,@role,@event_key,@is_activity,@target_id,@record_offset,@record_bytes,@record_hash,@text_length,@replacement_length,@text_length)
        ON CONFLICT(session_id,entry_id) DO UPDATE SET parent_id=excluded.parent_id,timestamp=excluded.timestamp,
        type=excluded.type,role=excluded.role,event_key=excluded.event_key,is_activity=excluded.is_activity,target_id=excluded.target_id,
        record_offset=excluded.record_offset,record_bytes=excluded.record_bytes,record_hash=excluded.record_hash,
        text_length=excluded.text_length,replacement_length=excluded.replacement_length,effective_length=excluded.text_length,
        effective_id=NULL,normalization=2,present=1`);
      let added = 0;
      const exists = db.prepare('SELECT 1 FROM agent_entries WHERE session_id = ? AND entry_id = ?');
      for (const entry of entries) {
        if (!exists.get(header.id, entry.entry_id)) added++;
        upsert.run({ ...entry, session_id: header.id, text_length: entry.text.length, replacement_length: entry.replacement?.length || 0 });
      }
      updateProjection(header.id, leaf, agent);
      return { id: header.id as string, added };
    })();
  } finally { await file.close(); }
}

let scanning: Promise<ScanResult> | null = null;
export function scanSessions(): Promise<ScanResult> {
  if (scanning) return scanning;
  scanning = (async () => {
    const warnings: string[] = [];
    const db = getDb(), roots = getSourceRoots(), seen = new Set<string>();
    const agents = db.prepare('SELECT id FROM agent_sources WHERE enabled=1').all() as { id: AgentKind }[];
    let added = 0, files = 0;
    for (const { id: agent } of agents) {
      let foundRoot = false;
      for (const root of roots[agent]) {
        if (!fs.existsSync(root)) continue;
        foundRoot = true;
        for (const file of await discover(root, warnings)) {
          if (!(db.prepare('SELECT enabled FROM agent_sources WHERE id=?').get(agent) as any)?.enabled) break;
          if (agent === 'claude' && /\.orphaned-[^/]+\.jsonl$/.test(file)) continue;
          files++;
          try {
            const result = await indexFile(file, agent, root, warnings);
            if (result.id) seen.add(result.id);
            added += result.added;
          } catch (error) { warnings.push(`Could not index ${agent} session ${file}: ${error instanceof Error ? error.message : 'unknown error'}`); }
        }
      }
      if (!foundRoot) warnings.push(`Session directory not found for ${agent}: ${roots[agent].join(', ')}`);
    }
    db.transaction(() => {
      for (const { id } of agents) db.prepare('UPDATE agent_sessions SET missing=1 WHERE agent=? AND agent IN (SELECT id FROM agent_sources WHERE enabled=1)').run(id);
      const mark = db.prepare('UPDATE agent_sessions SET missing = 0 WHERE id = ?');
      for (const id of seen) mark.run(id);
    })();
    return { files, added, warnings: warnings.slice(0, 100) };
  })().finally(() => { scanning = null; });
  return scanning;
}
