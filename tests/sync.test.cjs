require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { getDb, closeDb, initSchema } = require('../dist/db/schema');
const { scanSessions } = require('../dist/sync/collector');
const { cleanText } = require('../dist/sync/normalize');
const store = require('../dist/sync/store');
const { generateReply } = require('../dist/sync/manager');
const { createApp, startServer } = require('../dist/server');
const { isNoAuthMode, getAuthConfig } = require('../dist/auth/middleware');

let temp;
let root;
let servers = [];
beforeEach(() => {
  closeDb();
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-test-'));
  root = path.join(temp, 'sessions');
  fs.mkdirSync(root);
  process.env.DRAKEN_DATA_DIR = path.join(temp, 'state');
  process.env.DRAKEN_PI_SESSIONS_DIR = root;
  process.env.DRAKEN_NO_AUTH = 'true';
  for (const key of ['DRAKEN_HOST', 'DRAKEN_USERNAME', 'DRAKEN_PASSWORD', 'DRAKEN_JWT_SECRET']) delete process.env[key];
  delete process.env.DRAKEN_PI_TIMEOUT_MS;
  delete process.env.DRAKEN_PI_MODEL;
  delete process.env.DRAKEN_FAKE_CONTROL;
  delete process.env.DRAKEN_TEST_CALL_LOG;
  process.env.DRAKEN_PI_SUMMARY_MODEL = 'test/cheap';
  process.env.DRAKEN_PI_FINAL_MODEL = 'test/strong';
});
afterEach(async () => {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  servers = [];
  closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

function event(id, parentId, text, role = 'assistant', extra = {}) {
  return { type: 'message', id, parentId, timestamp: '2026-01-01T12:00:00.000Z', message: { role, content: [{ type: 'text', text }], ...extra } };
}
function session(entries, options = {}) {
  const id = options.id || randomUUID();
  const file = path.join(root, `${id}.jsonl`);
  const header = { type: 'session', version: 3, id, cwd: options.cwd || '/project/example', timestamp: '2026-01-01T00:00:00Z' };
  fs.writeFileSync(file, [header, ...entries].map(JSON.stringify).join('\n') + '\n');
  return { id, file, header };
}
function append(file, entry) { fs.appendFileSync(file, JSON.stringify(entry) + '\n'); }
function largeSession() {
  const value=session([]);let parent=null;
  for(let i=0;i<5;i++){const id=`bulk-${i}`;append(value.file,event(id,parent,'Earlier checkpoint.', 'assistant',{padding:'x'.repeat(7*1024*1024)}));parent=id;}
  append(value.file,event('latest',parent,'Current work: Profile-first journal navigation and scoped dismissal.'));
  return value;
}
test('one scan drains more than 32 MiB before freezing a snapshot, while incomplete JSONL tails are deferred',async()=>{
  const value=largeSession(),size=fs.statSync(value.file).size;assert.ok(size>32*1024*1024);
  fs.appendFileSync(value.file,'{"type":"message","id":"unfinished');
  const result=await scanSessions();assert.deepEqual(result.warnings,[]);
  const row=getDb().prepare('SELECT byte_offset,scanned_bytes FROM agent_sessions WHERE id=?').get(value.id);
  assert.equal(row.byte_offset,size);assert.equal(row.scanned_bytes,fs.statSync(value.file).size);
  const snapshot=store.startSync();assert.equal(snapshot.items.length,6);assert.match(snapshot.items.at(-1).text,/Profile-first journal navigation/);
});
test('cancelling a large scan retains its cursor without certifying a partial import and retry reaches the captured tail',async()=>{
  const value=largeSession(),controller=new AbortController();
  const timer=setInterval(()=>{const row=getDb().prepare('SELECT byte_offset,scanned_bytes FROM agent_sessions WHERE id=?').get(value.id);if(row?.byte_offset>0&&!row.scanned_bytes)controller.abort();},1);
  try{await assert.rejects(scanSessions(controller.signal),/abort/i);}finally{clearInterval(timer);}
  const partial=getDb().prepare('SELECT byte_offset,scanned_bytes FROM agent_sessions WHERE id=?').get(value.id);
  assert.ok(partial.byte_offset>0&&partial.byte_offset<fs.statSync(value.file).size);assert.equal(partial.scanned_bytes,0);
  const completed=await scanSessions();assert.deepEqual(completed.warnings,[]);
  assert.equal(getDb().prepare('SELECT scanned_bytes FROM agent_sessions WHERE id=?').get(value.id).scanned_bytes,fs.statSync(value.file).size);
});
test('legacy EOF cursors and repeated retries cannot certify a previously skipped malformed record',async()=>{
  const value=session([event('good',null,'A valid original record.')]);await scanSessions();
  const originalSize=fs.statSync(value.file).size,entryId=getDb().prepare('SELECT id FROM agent_entries WHERE entry_id=?').get('good').id;
  fs.appendFileSync(value.file,'malformed-json\n');
  getDb().prepare('UPDATE agent_sessions SET byte_offset=?,scanned_bytes=-1 WHERE id=?').run(fs.statSync(value.file).size,value.id);
  for(let i=0;i<2;i++){
    const result=await scanSessions();assert.ok(result.warnings.some(warning=>/malformed JSON/.test(warning)));
    assert.equal(getDb().prepare('SELECT scanned_bytes FROM agent_sessions WHERE id=?').get(value.id).scanned_bytes,0);
    assert.equal(getDb().prepare("SELECT value FROM sync_settings WHERE key='source-scan-complete-v1'").get().value,'0');
  }
  fs.truncateSync(value.file,originalSize);assert.deepEqual((await scanSessions()).warnings,[]);
  assert.equal(getDb().prepare('SELECT id FROM agent_entries WHERE entry_id=?').get('good').id,entryId,'full legacy revalidation preserves stable entry IDs');
  assert.equal(getDb().prepare("SELECT value FROM sync_settings WHERE key='source-scan-complete-v1'").get().value,'1');
});
test('scan errors block snapshot routes rather than hiding warnings behind a recent snapshot timestamp',async()=>{
  session([event('good',null,'A valid retained record.')]);
  fs.writeFileSync(path.join(root,'broken.jsonl'),'not a supported session\n');
  const request=await serve(),response=await request('/syncs','POST',{});
  assert.equal(response.status,409);assert.match(response.data.error,/import could not finish/);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM syncs').get().n,0);
});
function fakePi() {
  const executable = path.join(temp, 'fake-pi');
  fs.copyFileSync(path.join(__dirname, 'fixtures/fake-pi.cjs'), executable);
  fs.chmodSync(executable, 0o700);
  process.env.DRAKEN_PI_BIN = executable;
}
async function serve() {
  const server = createApp().listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return async (url, method = 'GET', body, headers = {}) => {
    // fetch normalizes Host; use raw HTTP for the DNS-rebinding regression.
    if (headers.Host) return new Promise((resolve, reject) => {
      const req = http.request(base + url, { method, headers }, response => {
        let content = '';
        response.on('data', chunk => content += chunk);
        response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(content) }));
      });
      req.on('error', reject);
      req.end();
    });
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
}

test('incremental indexing is read-only, excludes system/thinking/images, and is idempotent', async () => {
  const source = session([
    event('s', null, 'SYSTEM SECRET', 'system'),
    event('u', 's', 'Fix the export', 'user'),
    { ...event('a', 'u', ''), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE REASONING' }, { type: 'image', data: 'BASE64IMAGE' }, { type: 'text', text: 'Implemented the fix' }] } },
    event('t', 'a', '3 tests passed', 'toolResult', { toolName: 'bash', isError: false }),
  ]);
  const original = fs.readFileSync(source.file);
  assert.equal(store.overview().sessions.length, 0);
  assert.equal((await scanSessions()).added, 4);
  assert.equal(store.pendingCount(), 3);
  assert.equal((await scanSessions()).added, 0);
  const snapshot = store.startSync();
  const text = JSON.stringify(snapshot);
  assert.match(text, /3 tests passed/);
  assert.doesNotMatch(text, /SYSTEM SECRET|PRIVATE REASONING|BASE64IMAGE/);
  assert.deepEqual(fs.readFileSync(source.file), original);
  assert.equal(store.pendingCount(), 3, 'indexing and opening do not advance coverage');
});

test('finish covers exactly the snapshot, survives restart, and keeps arrivals during the sync', async () => {
  const source = session([event('u', null, 'Fix exports', 'user'), event('a', 'u', 'Change implemented')]);
  await scanSessions();
  const first = store.startSync();
  assert.equal(store.startSync().id, first.id, 'only one open sync');
  append(source.file, event('new', 'a', 'New validation result'));
  await scanSessions();
  assert.equal(store.getSync(first.id).items.length, 2);
  assert.throws(() => store.completeSync(first.id, '', '', false), /Confirm/);
  store.completeSync(first.id, 'Prioritize export correctness', 'Check deployment later', true);
  closeDb();
  assert.equal(store.pendingCount(), 1);
  const second = store.startSync();
  assert.equal(second.items[0].entry_id, 'new');
  assert.equal(second.carry_forward, 'Check deployment later');
  assert.equal(second.memory[0].decisions, 'Prioritize export correctness');
  assert.ok(second.context.some(item => item.entry_id === 'u'));
  assert.throws(() => store.completeSync(first.id, '', '', true), /already closed/);
});

test('initial history window is explicit, preserves older context and never becomes a rolling cutoff', async () => {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const old = { ...event('old', null, 'Original task', 'user'), timestamp: new Date(Date.now() - 86400000).toISOString() };
  const recent = { ...event('recent', 'old', 'Recent progress'), timestamp: new Date().toISOString() };
  const source = session([old, recent]);
  await scanSessions();
  const first = store.startSync(cutoff);
  assert.deepEqual(first.items.map(item => item.entry_id), ['recent']);
  assert.ok(first.context.some(item => item.entry_id === 'old'));
  assert.equal(first.history_since, cutoff);
  store.completeSync(first.id, '', '', true);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM sync_coverage').get().n, 1, 'older entries are excluded, not marked reviewed');
  append(source.file, { ...event('late', 'recent', 'Late-discovered activity'), timestamp: new Date(Date.now() - 1800000).toISOString() });
  await scanSessions();
  closeDb();
  const second = store.startSync(new Date().toISOString());
  assert.equal(second.history_since, cutoff);
  assert.equal(second.items[0].entry_id, 'late');
  assert.equal(store.overview().history_initialized, true);
});

test('invalid history baseline rolls back without creating a sync or changing coverage', () => {
  assert.throws(() => store.startSync('not a date'), /valid date/);
  assert.equal(store.overview().history_initialized, false);
  assert.equal(store.overview().syncs.length, 0);
});

test('saved notes and discarded syncs never advance coverage', async () => {
  session([event('u', null, 'Investigate', 'user')]);
  await scanSessions();
  const first = store.startSync();
  store.saveNotes(first.id, 'Keep this', 'Unresolved');
  assert.equal(store.pendingCount(), 1);
  store.discardSync(first.id);
  assert.equal(store.pendingCount(), 1);
  const second = store.startSync();
  assert.notEqual(first.id, second.id);
  assert.equal(second.items.length, 1);
  assert.equal(second.memory.length, 0, 'discarded decisions are not accepted memory');
});

test('active branch selection excludes abandoned work and compaction is not new activity', async () => {
  session([
    event('root', null, 'Explore approaches', 'user'),
    event('abandoned', 'root', 'Approach A is complete'),
    { type: 'branch_summary', id: 'summary', parentId: 'root', fromId: 'abandoned', timestamp: '2026-01-01T12:00:00Z', summary: 'Tried A' },
    event('chosen', 'summary', 'Approach B is in progress'),
    { type: 'compaction', id: 'compact', parentId: 'chosen', timestamp: '2026-01-01T12:00:00Z', summary: 'Discussed approaches', firstKeptEntryId: 'chosen' },
  ]);
  await scanSessions();
  const snapshot = store.startSync();
  assert.deepEqual(snapshot.items.map(item => item.entry_id), ['root', 'chosen']);
  assert.equal(store.pendingCount(), 2);
});

test('context edits apply only on their branch and omitted text is not briefed', async () => {
  const source = session([
    event('root', null, 'Task', 'user'), event('answer', 'root', 'Original answer'),
    { type: 'context_edit', id: 'edit', parentId: 'answer', targetId: 'answer', replacement: null, timestamp: '2026-01-01T12:00:00Z' },
  ]);
  await scanSessions();
  assert.equal(store.pendingCount(), 1);
  append(source.file, event('other', 'answer', 'Different branch'));
  await scanSessions();
  assert.equal(store.pendingCount(), 3);
  append(source.file, { type: 'context_edit', id: 'replace', parentId: 'other', targetId: 'answer', replacement: 'Corrected answer', timestamp: '2026-01-01T12:00:01Z' });
  await scanSessions();
  const snapshot = store.startSync();
  assert.equal(snapshot.items.find(item => item.entry_id === 'answer').text, 'Corrected answer');
});

test('forked/copied history is deduplicated across sessions and completed syncs', async () => {
  const entries = [event('root', null, 'Fix bug', 'user'), event('answer', 'root', 'Fixed')];
  session(entries);
  session(entries, { cwd: '/project/fork' });
  await scanSessions();
  assert.equal(store.pendingCount(), 2);
  const first = store.startSync();
  assert.equal(first.items.length, 2);
  store.completeSync(first.id, '', '', true);
  session([...entries, event('new', 'answer', 'More work')], { cwd: '/project/new-fork' });
  await scanSessions();
  assert.equal(store.pendingCount(), 1);
});

test('partial UTF-8/JSON tails wait for a newline; malformed complete lines are reported', async () => {
  const source = session([event('first', null, 'First', 'user')]);
  const tail = Buffer.from(JSON.stringify(event('tail', 'first', 'Unicode \u2028 split 🐉')) + '\n');
  const split = tail.indexOf(Buffer.from('🐉')) + 1;
  fs.appendFileSync(source.file, tail.subarray(0, split));
  await scanSessions();
  assert.equal(store.pendingCount(), 1);
  fs.appendFileSync(source.file, tail.subarray(split));
  fs.appendFileSync(source.file, '{broken}\n');
  const scan = await scanSessions();
  assert.ok(scan.warnings.some(warning => warning.includes('malformed')));
  assert.equal(store.pendingCount(), 1, 'the last complete chunk is retained, but the malformed chunk cannot advance');
  assert.equal(store.overview().sessions[0].missing, 0, 'an incomplete import is not a disappeared file');
  fs.truncateSync(source.file, fs.statSync(source.file).size - Buffer.byteLength('{broken}\n'));
  assert.deepEqual((await scanSessions()).warnings, []);
  assert.equal(store.pendingCount(), 2);
  assert.match(store.startSync().items[1].text, /🐉/);
});

test('file replacement/truncation reindexes safely without resurrecting stale entries', async () => {
  const source = session([event('u', null, 'User', 'user'), event('old', 'u', 'Old tail')]);
  await scanSessions();
  const first = store.startSync();
  store.completeSync(first.id, '', '', true);
  fs.writeFileSync(source.file, [source.header, event('u', null, 'User', 'user'), event('n', 'u', 'New')].map(JSON.stringify).join('\n') + '\n');
  await scanSessions();
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.startSync().items[0].entry_id, 'n');
});

test('sources can be excluded, missing sources are not new activity, symlinks are not followed', async () => {
  const source = session([event('u', null, 'Task', 'user')]);
  fs.symlinkSync(source.file, path.join(root, 'linked.jsonl'));
  assert.equal((await scanSessions()).files, 1);
  store.setIncluded(source.id, false);
  assert.equal(store.pendingCount(), 0);
  store.setIncluded(source.id, true);
  assert.equal(store.pendingCount(), 1);
  fs.unlinkSync(source.file);
  await scanSessions();
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.overview().sessions[0].missing, 1);
});

test('unsupported session formats and Draken-owned conversations are not ingested', async () => {
  const legacy = session([event('u', null, 'Legacy', 'user')]);
  fs.writeFileSync(legacy.file, JSON.stringify({ ...legacy.header, version: 2 }) + '\n');
  session([event('self', null, 'Do not summarize yourself', 'user')], { cwd: path.join(process.env.DRAKEN_DATA_DIR, 'manager') });
  const result = await scanSessions();
  assert.ok(result.warnings.some(warning => warning.includes('Unsupported')));
  assert.equal(store.pendingCount(), 0);
});

test('full snapshots include all eligible evidence across sessions, with no count or character cutoff', async () => {
  for (let project = 0; project < 3; project++) {
    const entries = [];
    for (let i = 0; i < 60; i++) entries.push(event(`p${project}e${i}`, i ? `p${project}e${i - 1}` : null, `Project ${project}: ` + 'x'.repeat(1800)));
    session(entries, { cwd: `/project/${project}` });
  }
  await scanSessions();
  const first = store.startSync();
  assert.equal(first.items.length, 180);
  assert.equal(new Set(first.items.map(item => item.session_id)).size, 3);
  assert.equal(first.remaining_count, 0);
  assert.equal(first.snapshot_version, 2);
  store.completeSync(first.id, '', '', true);
  assert.equal(store.pendingCount(), 0);
});

test('schema migration preserves legacy project and task data', () => {
  const Database = require('better-sqlite3');
  const database = new Database(':memory:');
  database.exec("CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE tasks(id INTEGER PRIMARY KEY, prompt TEXT); INSERT INTO tasks VALUES (1, 'legacy task');");
  initSchema(database);
  initSchema(database);
  assert.equal(database.prepare('SELECT prompt FROM tasks WHERE id = 1').get().prompt, 'legacy task');
  database.close();
});

test('redaction removes common token patterns but keeps evidence and indicates truncation', () => {
  const text = cleanText('api_key=abcdef12345 ghp_' + 'a'.repeat(30) + ' Bearer abcd.efgh.ijkl');
  assert.doesNotMatch(text, /abcdef12345|ghp_|abcd\.efgh/);
  assert.match(cleanText('a'.repeat(100), 10), /truncated/);
  assert.doesNotMatch(cleanText('Authorization: Bearer opaque-token-12345\nOPENAI_API_KEY=nonstandard-provider-key'), /opaque-token|nonstandard-provider-key/);
});

test('manager uses tool-free pi, persists replies and memory, and does not advance coverage', async () => {
  fakePi();
  session([event('u', null, 'Fix bug', 'user')]);
  await scanSessions();
  const first = store.startSync();
  const pending = generateReply(first.id);
  await assert.rejects(() => generateReply(first.id), /still being generated/);
  assert.throws(() => store.completeSync(first.id, '', '', true), /still being generated/);
  const briefed = await pending;
  assert.match(briefed.briefing, /\[E1\]/);
  assert.equal(store.pendingCount(), 1);
  assert.equal((await generateReply(first.id, 'Explain')).messages.length, 2);
  store.completeSync(first.id, 'Prefer correctness', 'Revisit migration', true);
  const next = store.startSync();
  const response = await generateReply(next.id, 'SHOW MEMORY');
  assert.match(response.messages[1].content, /Prefer correctness/);
});

test('model failure and timeout keep the sync open and do not save incomplete exchanges', async () => {
  fakePi();
  session([event('u', null, 'Task', 'user')]);
  await scanSessions();
  const first = store.startSync();
  await assert.rejects(() => generateReply(first.id, 'FAIL'), /provider unavailable/);
  process.env.DRAKEN_PI_TIMEOUT_MS = '1000';
  await assert.rejects(() => generateReply(first.id, 'TIMEOUT'), /timed out/);
  assert.equal(store.getSync(first.id).messages.length, 0);
  assert.equal(store.getSync(first.id).busy, false);
  assert.equal(store.getSync(first.id).status, 'open');
  assert.equal(store.pendingCount(), 1);
});

test('HTTP model actions work directly while preserving input validation, review and removed execution routes', async () => {
  fakePi();
  session([event('u', null, 'Task', 'user')]);
  const request = await serve();
  assert.equal((await request('/overview')).data.pending, 0);
  assert.equal((await request('/scan', 'POST')).status, 200);
  const started = await request('/syncs', 'POST');
  const id = started.data.sync.id;
  assert.equal((await request(`/syncs/${id}/briefing`, 'POST')).status, 202);
  for (let tries = 0; (await request(`/syncs/${id}/progress`)).data.busy; tries++) {
    assert.ok(tries < 100, 'generation should settle');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await request(`/syncs/${id}/progress`)).data.run.status, 'completed');
  assert.equal((await request(`/syncs/${id}/messages`, 'POST', { message: '' })).status, 400);
  assert.equal((await request(`/syncs/${id}/messages`, 'POST', { message: 'Explain' })).status, 202);
  for (let tries = 0; (await request(`/syncs/${id}/progress`)).data.busy; tries++) {
    assert.ok(tries < 100, 'discussion should settle');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await request(`/syncs/${id}`)).data.messages.length, 2);
  assert.equal((await request(`/syncs/${id}/notes`, 'PATCH', { decisions: 42, carry_forward: '' })).status, 400);
  assert.equal((await request(`/syncs/${id}/complete`, 'POST', { decisions: '', carry_forward: '' })).status, 400);
  assert.equal((await request(`/syncs/${id}/complete`, 'POST', { decisions: 'Done', carry_forward: '', reviewed: true })).status, 200);
  assert.equal((await request('/overview')).data.pending, 0);
  assert.equal((await request('/tasks/project/1', 'POST', { prompt: 'run something' })).status, 404);
  assert.equal((await request('/git/1/commit', 'POST', { message: 'no' })).status, 404);
  assert.equal((await request('/syncs/nope')).status, 400);
});

test('plain loopback launch needs no login or auth environment configuration', async () => {
  delete process.env.DRAKEN_NO_AUTH;
  assert.equal(isNoAuthMode(), true);
  assert.equal(getAuthConfig(), null);
  const request = await serve();
  assert.equal((await request('/auth/status')).data.enabled, false);
  assert.equal((await request('/overview')).status, 200);
  assert.equal((await request('/overview', 'GET', undefined, { Host: 'attacker.example' })).status, 403);
  assert.equal((await request('/scan', 'POST', {}, { Origin: 'https://attacker.example' })).status, 403);
});

test('LAN bindings and explicitly configured credentials do not silently become anonymous', () => {
  delete process.env.DRAKEN_NO_AUTH;
  for (const host of ['0.0.0.0', '192.168.3.112', '::']) {
    process.env.DRAKEN_HOST = host;
    assert.equal(isNoAuthMode(), false);
    assert.throws(() => getAuthConfig(), /Authentication is required/);
  }
  process.env.DRAKEN_NO_AUTH = 'true';
  assert.throws(() => startServer(), /only bind to loopback/);
  delete process.env.DRAKEN_HOST;
  delete process.env.DRAKEN_NO_AUTH;
  process.env.DRAKEN_USERNAME = 'test';
  assert.equal(isNoAuthMode(), false, 'configured authentication remains enabled on loopback');
  assert.throws(() => getAuthConfig(), /DRAKEN_PASSWORD/);
  process.env.DRAKEN_NO_AUTH = 'typo';
  assert.throws(() => isNoAuthMode(), /must be true or false/);
});

test('private session APIs reject unauthenticated, cross-origin and rebinding-style requests', async () => {
  const request = await serve();
  assert.equal((await request('/scan', 'POST', {}, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('/overview', 'GET', undefined, { Host: 'attacker.example' })).status, 403);
  process.env.DRAKEN_NO_AUTH = 'false';
  process.env.DRAKEN_USERNAME = 'test';
  process.env.DRAKEN_PASSWORD = 'test-password';
  process.env.DRAKEN_JWT_SECRET = 'test-secret-not-for-production';
  assert.equal((await request('/overview')).status, 401);
  const login = await request('/auth/login', 'POST', { username: 'test', password: 'test-password' });
  assert.equal(login.status, 200);
  assert.equal((await request('/overview', 'GET', undefined, { Authorization: `Bearer ${login.data.token}` })).status, 200);
  assert.equal((await request(`/overview?token=${login.data.token}`)).status, 401, 'no legacy URL-token authentication');
});
