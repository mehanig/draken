require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { getDb, closeDb, initSchema } = require('../dist/db/schema');
const { scanSessions } = require('../dist/sync/collector');
const store = require('../dist/sync/store');
const { historySources } = require('../dist/memory/sources');
const { HistoryIndex } = require('../dist/memory/index');
const { EvidenceReader } = require('../dist/db/evidence');
const { codexLog, claudeLog, at } = require('./fixtures/agent-logs.cjs');
let root, db;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-agents-test-'));
  for (const agent of ['pi', 'codex', 'claude']) fs.mkdirSync(path.join(root, agent));
  Object.assign(process.env, { DRAKEN_DATA_DIR: path.join(root, 'state'), DRAKEN_PI_SESSIONS_DIR: path.join(root, 'pi'), DRAKEN_CODEX_SESSIONS_DIR: path.join(root, 'codex'), DRAKEN_CLAUDE_SESSIONS_DIR: path.join(root, 'claude') });
  db = getDb();
});
afterEach(() => { closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
const write = (agent, name, records) => { const file = path.join(root, agent, name + '.jsonl'); fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n'); return file; };
const pi = () => write('pi', 'pi', [{ type: 'session', version: 3, id: 'shared', cwd: '/synthetic/pi' }, { type: 'message', id: 'u1', parentId: null, timestamp: at, message: { role: 'user', content: 'Please check the parser.' } }]);
const allEnabled = () => { store.setAgentEnabled('codex', true); store.setAgentEnabled('claude', true); };
const body = () => [...historySources(db)].filter(item => item.kind === 'session').map(item => item.text).join('\n');
function model() { return { fingerprint: 'synthetic-multi-agent-v1', calls: 0, ready: () => true, setup: async () => {}, async embed() { this.calls++; const v = new Float32Array(384); v[0] = 1; return v; } }; }

test('new agents require explicit opt-in; namespaces separate equal native IDs and preserve pi event identity', async () => {
  pi(); const a = write('codex', 'rollout', codexLog()), b = write('claude', 'transcript', claudeLog()), originals = [a, b].map(file => fs.readFileSync(file));
  const overview = store.overview(); assert.deepEqual(overview.agents.map(agent => [agent.id, agent.enabled]), [['pi', true], ['codex', false], ['claude', false]]);
  assert.ok(overview.agents.every(agent => agent.roots[0].status === 'present')); assert.equal(overview.sessions.length, 0);
  await scanSessions(); assert.equal(store.overview().sessions.length, 1); const event = db.prepare('SELECT event_key FROM agent_entries').get().event_key;
  allEnabled(); assert.equal(store.overview().sessions.length, 1, 'enabling does not scan');
  const scan = await scanSessions(); assert.deepEqual(scan.warnings, []);
  assert.deepEqual(store.overview().sessions.map(row => row.id).sort(), ['claude:shared', 'codex:shared', 'shared']);
  assert.equal(db.prepare("SELECT event_key FROM agent_entries WHERE session_id='shared'").get().event_key, event);
  const sync = store.startSync(); assert.deepEqual(new Set(sync.items.map(item => item.agent)), new Set(['pi', 'codex', 'claude']));
  assert.equal(sync.items.filter(item => item.text === 'Please check the parser.').length, 3);
  assert.equal(new Set(sync.items.map(item => item.event_key)).size, sync.items.length);
  assert.ok(sync.items.every(item => !item.text.includes('Background compression')));
  assert.doesNotMatch(body(), /PRIVATE_|Background compression/); assert.match(body(), /Tool requested/); assert.match(body(), /NOT checked/); assert.match(body(), /; error/);
  for (const [i, file] of [a, b].entries()) assert.deepEqual(fs.readFileSync(file), originals[i]);
  const encoded = db.prepare('SELECT evidence_json FROM sync_items').all().map(row => JSON.parse(row.evidence_json));
  assert.ok(encoded.every(row => !('text' in row))); assert.ok(encoded.filter(row => row.agent !== 'pi').every(row => row.source_pointer.version === 2 && row.source_pointer.source.parser_version === 1));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});

test('foreign pointers survive appends and verified moves, but reject rewritten originals and changed agent identity', async () => {
  allEnabled(); const records = codexLog(), file = write('codex', 'rollout', records); await scanSessions(); const sync = store.startSync();
  fs.appendFileSync(file, JSON.stringify({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Later claim' }] } }) + '\n');
  await scanSessions(); assert.deepEqual(store.getSync(sync.id).items, sync.items);
  const moved = path.join(root, 'codex', 'moved.jsonl'); fs.renameSync(file, moved); await scanSessions(); assert.deepEqual(store.getSync(sync.id).items, sync.items);
  const original = fs.readFileSync(moved, 'utf8'); fs.writeFileSync(moved, original.replace('Please check the parser.', 'Please alter the parser.'));
  assert.ok(store.getSync(sync.id).items.some(item => item.unavailable)); assert.throws(() => store.completeSync(sync.id, '', '', true), /Original session evidence/);
  fs.writeFileSync(moved, original); assert.deepEqual(store.getSync(sync.id).items, sync.items);
  const frozen = JSON.parse(db.prepare('SELECT evidence_json FROM sync_items LIMIT 1').get().evidence_json); frozen.source_pointer.source.agent = 'claude';
  const reader = new EvidenceReader(db); try { assert.throws(() => reader.read(frozen), /identity changed/); } finally { reader.close(); }
  store.saveNotes(sync.id, 'Preserved explicit decision', ''); fs.unlinkSync(moved); assert.equal(store.getSync(sync.id).decisions, 'Preserved explicit decision');
});

test('Claude branches, linked compaction and subagents are distinct; frozen earlier branches are not rewritten', async () => {
  allEnabled(); const records = claudeLog(), file = write('claude', 'main', records);
  write('claude', 'subagent', claudeLog('shared', '/synthetic/claude', { isSidechain: true, agentId: 'helper' }).map(row => ({ ...row, ...(row.uuid ? { uuid: 'sub-' + row.uuid } : {}), ...(row.parentUuid ? { parentUuid: 'sub-' + row.parentUuid } : {}), ...(row.logicalParentUuid ? { logicalParentUuid: 'sub-' + row.logicalParentUuid } : {}) })));
  await scanSessions(); assert.equal(store.overview().sessions.length, 2);
  const sync = store.startSync(); assert.ok(sync.items.some(item => item.session_id === 'claude:shared:helper'));
  fs.appendFileSync(file, JSON.stringify({ ...records[1], uuid: 'branch', parentUuid: 'u1', message: { role: 'user', content: 'Alternative branch; old claim superseded.' } }) + '\n');
  await scanSessions(); const current = [...historySources(db)].filter(item => item.kind === 'session' && item.session_id === 'claude:shared');
  assert.deepEqual(current.map(item => item.text), ['Please check the parser.', 'Alternative branch; old claim superseded.']);
  assert.deepEqual(store.getSync(sync.id).items, sync.items);
});

test('disabling an agent removes retrieval admission, not frozen evidence; existing vectors remain byte-identical', async () => {
  pi(); await scanSessions(); const derived = new Database(':memory:'), embedder = model(), index = new HistoryIndex(derived, db, embedder);
  try {
    await index.prepare(); const before = derived.prepare('SELECT hash,hex(embedding) bytes FROM embedding_cache').all();
    allEnabled(); write('codex', 'rollout', codexLog()); write('claude', 'transcript', claudeLog()); await scanSessions(); const sync = store.startSync(); await index.prepare();
    for (const row of before) assert.equal(derived.prepare('SELECT hex(embedding) bytes FROM embedding_cache WHERE hash=?').get(row.hash).bytes, row.bytes);
    const calls = embedder.calls; await index.prepare(); assert.equal(embedder.calls, calls);
    store.setAgentEnabled('codex', false); assert.ok([...historySources(db)].every(row => row.session_id !== 'codex:shared')); assert.deepEqual(store.getSync(sync.id).items, sync.items);
    const rows = db.prepare("SELECT included FROM agent_sessions WHERE agent='codex'").all(); assert.ok(rows.every(row => row.included === 1));
    store.setAgentEnabled('codex', true); assert.ok([...historySources(db)].some(row => row.session_id === 'codex:shared'));
  } finally { derived.close(); }
});

test('ambiguous or unsupported foreign histories fail visibly rather than losing earlier content or crossing roots', async () => {
  allEnabled();
  const broken = codexLog(); broken[0].payload.history_base = { thread_id: 'elsewhere', ordinal: 2 }; write('codex', 'external-base', broken);
  write('codex', 'rollback', [...codexLog('rollback'), { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }]);
  const duplicate = claudeLog('duplicate'); write('claude', 'duplicate', [...duplicate, { ...duplicate[1], message: { role: 'user', content: 'Different body under the same UUID' } }]);
  const compact = claudeLog('compact'); delete compact[5].logicalParentUuid; write('claude', 'compact', compact);
  const outside = path.join(root, 'outside.jsonl'); fs.writeFileSync(outside, codexLog('outside').map(JSON.stringify).join('\n') + '\n'); fs.symlinkSync(outside, path.join(root, 'codex', 'link.jsonl'));
  const eventOnly = codexLog('event-only').filter(row => row.type === 'session_meta' || row.type === 'event_msg'); write('codex', 'event-only', eventOnly);
  const wrongRole = claudeLog('wrong-role'); wrongRole[1].message.role = 'system'; write('claude', 'wrong-role', wrongRole);
  const result = await scanSessions(); assert.equal(result.warnings.length, 6); assert.equal(store.overview().sessions.length, 0);
  assert.match(result.warnings.join('\n'), /external history-base/); assert.match(result.warnings.join('\n'), /rollback/); assert.match(result.warnings.join('\n'), /Conflicting Claude/); assert.match(result.warnings.join('\n'), /compaction boundary/);
});

function oldPiSchema() {
  db.exec(`DROP INDEX agent_sessions_identity; ALTER TABLE agent_sessions DROP COLUMN external_id; ALTER TABLE agent_sessions DROP COLUMN agent;
    ALTER TABLE agent_entries DROP COLUMN parser_version; DROP TABLE agent_sources; DELETE FROM sync_settings WHERE key='source_schema';
    ALTER TABLE agent_sessions RENAME TO pi_sessions; ALTER TABLE agent_entries RENAME TO pi_entries;
    DROP INDEX agent_entries_pending; DROP INDEX agent_entries_event; CREATE INDEX pi_entries_pending ON pi_entries(active,is_activity,present); CREATE INDEX pi_entries_event ON pi_entries(event_key);`);
}

test('pi-to-agent schema migration preserves IDs, coverage, snapshots, preferences, H references and cached vector bytes; rerun is inert', async () => {
  pi(); await scanSessions(); const sync = store.startSync(); store.saveNotes(sync.id, 'Explicit decision', 'Carry forward');
  // Simulate the deployed v1 pointers, whose metadata predates the optional agent field.
  for (const row of db.prepare('SELECT rowid,evidence_json FROM sync_items').all()) { const value = JSON.parse(row.evidence_json); delete value.agent; db.prepare('UPDATE sync_items SET evidence_json=? WHERE rowid=?').run(JSON.stringify(value), row.rowid); }
  db.exec("DELETE FROM sync_settings WHERE key='auto_prepare_conversations'; UPDATE sync_settings SET value='false' WHERE key='auto_index'");
  db.prepare('INSERT INTO sync_coverage VALUES(?,?)').run(sync.items[0].event_key, sync.id);
  db.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='agent_entries'").run();
  const frozen = db.prepare('SELECT * FROM sync_items').all(), before = store.getSync(sync.id), history = [...historySources(db)], derived = new Database(':memory:'), embedder = model();
  try {
    const index = new HistoryIndex(derived, db, embedder); await index.prepare(); const vectors = derived.prepare('SELECT hash,hex(embedding) bytes FROM embedding_cache ORDER BY hash').all(), calls = embedder.calls;
    oldPiSchema(); const old = db.prepare('SELECT * FROM pi_entries').all(); initSchema(db);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name IN ('pi_sessions','pi_entries')").get().n, 0);
    assert.deepEqual(db.prepare('SELECT * FROM agent_entries').all().map(({ parser_version, ...row }) => row), old);
    assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='agent_entries'").get().seq, 999);
    assert.deepEqual(db.prepare('SELECT * FROM sync_items').all(), frozen); assert.deepEqual(store.getSync(sync.id), before); assert.deepEqual([...historySources(db)], history);
    assert.equal(db.prepare('SELECT count(*) n FROM sync_coverage').get().n, 1); assert.deepEqual(store.overview().agents.map(row => row.enabled), [true, false, false]);
    await index.prepare(); assert.equal(embedder.calls, calls); assert.deepEqual(derived.prepare('SELECT hash,hex(embedding) bytes FROM embedding_cache ORDER BY hash').all(), vectors);
    const changes = db.prepare('SELECT total_changes() n').get().n; initSchema(db); assert.deepEqual(store.getSync(sync.id), before); assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.prepare('SELECT total_changes() n').get().n, changes, 'rerun makes no representation writes');
  } finally { derived.close(); }
});

test('failed agent-schema conversion rolls back table renames and leaves legacy data usable', async () => {
  pi(); await scanSessions(); oldPiSchema(); db.prepare("INSERT INTO sync_settings VALUES('source_schema','future')").run();
  const before = db.prepare('SELECT * FROM pi_entries').all(); assert.throws(() => initSchema(db), /Unknown agent source schema/);
  assert.deepEqual(db.prepare('SELECT * FROM pi_entries').all(), before); assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='agent_entries'").get().n, 0);
});

test('agent settings validate exact requests, honor origin protection, and never scan on GET or enable', async () => {
  write('codex', 'ready', codexLog());
  const server = require('../dist/server').createApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  try {
    assert.equal((await fetch(url + '/overview')).status, 200);
    for (const body of [{}, { enabled: 1 }, { enabled: true, root: '/outside' }, []]) assert.equal((await fetch(url + '/agents/codex', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
    assert.equal((await fetch(url + '/agents/unknown', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' })).status, 404);
    assert.equal((await fetch(url + '/agents/codex', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{"enabled":true}' })).status, 403);
    const result = await fetch(url + '/agents/codex', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' }); assert.equal(result.status, 200); assert.equal((await result.json()).agents.find(row => row.id === 'codex').enabled, true);
    for (const table of ['agent_sessions', 'agent_entries', 'syncs', 'sync_coverage', 'sync_runs', 'live_calls']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    assert.equal(fs.existsSync(path.join(root, 'state/memory')), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('mixed-agent complete-snapshot summaries still invoke only the isolated pi runner and do not advance review', async () => {
  pi(); allEnabled(); write('codex', 'rollout', codexLog()); write('claude', 'transcript', claudeLog()); await scanSessions();
  const runner = path.join(root, 'summary-pi'), log = path.join(root, 'pi-calls.jsonl'); fs.copyFileSync(path.join(__dirname, 'fixtures/fake-pi.cjs'), runner); fs.chmodSync(runner, 0o700);
  Object.assign(process.env, { DRAKEN_PI_BIN: runner, DRAKEN_PI_SUMMARY_MODEL: 'test/cheap', DRAKEN_PI_FINAL_MODEL: 'test/strong', DRAKEN_TEST_CALL_LOG: log }); delete process.env.DRAKEN_FAKE_CONTROL;
  const sync = store.startSync(); await require('../dist/sync/manager').generateReply(sync.id);
  const ready = store.getSync(sync.id); assert.equal(ready.tree.complete, true); assert.equal(ready.tree.run.processed_entries, sync.items.length); assert.ok(ready.briefing);
  assert.deepEqual(new Set(ready.items.map(item => item.agent)), new Set(['pi', 'codex', 'claude']));
  assert.ok(fs.readFileSync(log, 'utf8').trim().split('\n').length >= 2); assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /PRIVATE_THINKING|PRIVATE_WRITE_BODY|PRIVATE_SYSTEM/);
  assert.equal(db.prepare('SELECT count(*) n FROM sync_coverage').get().n, 0);
});
