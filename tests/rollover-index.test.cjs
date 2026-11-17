// Run directly: node --test tests/rollover-index.test.cjs
// Transpile into this test process only: never build, replace, or depend on dist.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module'), ts = require('typescript');
const Database = require('better-sqlite3');
const project = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename, extension = require.extensions['.ts'];
let schema, store, conversation, HistoryIndex, historySources, passages, indexReadiness, sourceEntry, editEntry;
try {
  require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename,
  }).outputText, filename);
  Module._resolveFilename = function(request, parent, ...rest) {
    if (request.startsWith('.') || path.isAbsolute(request)) {
      let file = path.resolve(path.dirname(parent.filename), request);
      // The shared original-file fixture uses dist imports; resolve those to the
      // same source modules as this test, not a second schema singleton.
      if (file.startsWith(project + '/dist/')) file = project + '/src/' + file.slice((project + '/dist/').length);
      if (file.startsWith(project + '/src/') && fs.existsSync(file + '.ts')) request = file + '.ts';
    }
    return resolve.call(this, request, parent, ...rest);
  };
  schema = require('../src/db/schema');
  store = require('../src/sync/store');
  conversation = require('../src/sync/conversation');
  ({ HistoryIndex } = require('../src/memory/index'));
  ({ historySources } = require('../src/memory/sources'));
  ({ passages } = require('../src/memory/passages'));
  ({ indexReadiness } = require('../src/memory/readiness'));
  ({ sourceEntry, editEntry } = require('./fixtures/source-entry.cjs'));
} finally {
  Module._resolveFilename = resolve;
  if (extension) require.extensions['.ts'] = extension;
  else delete require.extensions['.ts'];
}

let root, db, cache, index, model, env;
function synthetic(fingerprint = 'rollover-synthetic-v1') {
  const model = { fingerprint, calls: [], queries: [], beforeBatch: null, ready: () => true, setup: async () => {},
    embed: async (body, query) => {
      (query ? model.queries : model.calls).push(body);
      const vector = new Float32Array(384);
      // Distinct, deterministic unit vectors make byte preservation observable.
      const hash = require('node:crypto').createHash('sha256').update(fingerprint + body).digest();
      vector[hash.readUInt16LE(0) % 384] = 1;
      return vector;
    },
    embedMany: async bodies => {
      model.beforeBatch?.(bodies);
      return Promise.all(bodies.map(body => model.embed(body, false)));
    },
  };
  return model;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-rollover-index-'));
  env = { ...process.env };
  process.env.DRAKEN_DATA_DIR = root;
  process.env.DRAKEN_PI_SESSIONS_DIR = path.join(root, 'originals');
  // Explicit roots prevent even metadata checks against a user's other agents.
  for (const agent of ['CODEX', 'CLAUDE']) process.env[`DRAKEN_${agent}_SESSIONS_DIR`] = path.join(root, agent.toLowerCase());
  db = schema.getDb();
  db.prepare("INSERT OR REPLACE INTO sync_settings(key,value) VALUES('auto_index','false')").run();
  db.prepare("INSERT OR REPLACE INTO sync_settings(key,value) VALUES('auto_summary','false')").run();
  cache = new Database(path.join(root, 'index.sqlite'));
  model = synthetic();
  index = new HistoryIndex(cache, db, model);
});
afterEach(() => {
  cache?.close(); schema.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
});
function entry(text, session = 'session-a') {
  return sourceEntry(db, process.env.DRAKEN_PI_SESSIONS_DIR, text, { session, name: `Title ${session}`, cwd: '/synthetic/project' });
}
function entries(prefix, count, session = 'session-a') {
  return Array.from({ length: count }, (_, n) => entry(`${prefix} record ${n}: synthetic claim, not independently verified.`, session));
}
function expire(sync) {
  conversation.expireConversations(Date.parse(sync.conversation.expires_at));
  const row = db.prepare('SELECT status,completed_at,conversation_ended_at FROM syncs WHERE id=?').get(sync.id);
  assert.equal(row.status, 'open'); assert.equal(row.completed_at, null); assert.ok(row.conversation_ended_at);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0, 'expiry is not review');
}
function reopen(nextModel = model) {
  cache.close(); cache = new Database(path.join(root, 'index.sqlite'));
  index = new HistoryIndex(cache, db, nextModel);
}
function vectors() {
  return cache.prepare('SELECT p.id,p.hash,v.embedding FROM passages p JOIN passage_vectors v ON v.rowid=p.id ORDER BY p.id').all();
}
function links() {
  return cache.prepare('SELECT c.id,c.ref,c.offset,c.passage_id FROM chunk_links c ORDER BY c.id').all();
}
function retained(before) {
  const now = new Map(vectors().map(row => [row.id, row]));
  for (const row of before) assert.deepEqual(now.get(row.id), row, 'old physical vector ID, hash and bytes survive');
}
function retainedLinks(before) {
  const now = new Map(links().map(row => [row.id, row]));
  for (const row of before) assert.deepEqual(now.get(row.id), row, 'existing H references and occurrence IDs survive');
}
function records() { return [...historySources(db)]; }
function expectedMissing(fingerprint = model.fingerprint) {
  const cached = new Set(vectors().map(row => row.hash)), missing = new Map();
  for (const record of records()) for (const item of passages(record, fingerprint)) if (!cached.has(item.hash)) missing.set(item.hash, item.body);
  return [...missing.values()].sort();
}
function canonical() {
  return JSON.stringify(['agent_sessions', 'agent_entries', 'syncs', 'sync_items', 'sync_messages', 'sync_coverage', 'sync_runs', 'summary_cache', 'sync_settings']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}
async function prepareDelta(expected) {
  const before = model.calls.length, queries = model.queries.length, original = canonical();
  await index.prepare(); // Global coverage, not a source/sync-scoped shortcut.
  assert.deepEqual(model.calls.slice(before).sort(), [...expected].sort(), 'inference only for genuinely missing passage inputs');
  assert.equal(model.queries.length, queries, 'preparation must not embed queries');
  assert.equal(canonical(), original, 'index preparation cannot change review, membership or source metadata');
  assert.equal(indexReadiness(cache, db, false).ready, true);
}
function sameItems(sync, ids) {
  const keys = ids.map(id => db.prepare('SELECT event_key FROM agent_entries WHERE id=?').get(id).event_key).sort();
  assert.deepEqual(sync.items.map(item => item.event_key).sort(), keys, 'new snapshot includes ALL unreviewed old entries plus arrivals');
}

test('actual expired unreviewed syncs roll into a combined snapshot: only new passages embed, old vectors/Hrefs persist', async () => {
  const firstIds = entries('FIRST', 9);
  firstIds.push(entry('LONG first source. ' + 'A retained detail. '.repeat(110)));
  const first = store.startSync(); sameItems(first, firstIds);
  assert.equal(first.previously_included_count, 0);
  db.prepare("INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES(?,'user','Keep this old discussion, not a review.',?)")
    .run(first.id, '2020-01-03T00:00:00.000Z');
  await prepareDelta(expectedMissing());
  const firstVectors = vectors(), firstLinks = links();
  assert.ok(firstLinks.length > firstVectors.length, 'originals and old frozen aliases already share vectors');
  expire(first);
  const secondIds = [...firstIds, ...entries('SECOND', 4, 'session-b')];
  const second = store.startSync(); assert.notEqual(second.id, first.id); sameItems(second, secondIds);
  assert.equal(store.pendingCount(), secondIds.length);
  const secondDelta = expectedMissing(); assert.equal(secondDelta.length, 4);
  await prepareDelta(secondDelta); retained(firstVectors); retainedLinks(firstLinks);
  const oldVectors = vectors(), oldLinks = links(), oldBodies = new Set(model.calls);
  expire(second);
  const combinedIds = [...secondIds, ...entries('NEW', 3)];
  const combined = store.startSync(); sameItems(combined, combinedIds);
  assert.equal(combined.previously_included_count, secondIds.length, 'carried-forward count means prior inclusion, not review or completed inference');
  assert.notEqual(combined.id, second.id);
  assert.equal(store.pendingCount(), combinedIds.length);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
  const delta = expectedMissing(); assert.equal(delta.length, 3);
  assert.ok(delta.every(body => !oldBodies.has(body)));
  await prepareDelta(delta); retained(oldVectors); retainedLinks(oldLinks);
  // Every new frozen occurrence resolves to the already shared physical passage.
  const originals = new Map(records().filter(r => r.kind === 'session').map(r => [r.identity, r]));
  for (const alias of records().filter(r => r.sync_id === combined.id)) {
    const ids = ref => cache.prepare('SELECT offset,passage_id FROM chunk_links WHERE ref=? ORDER BY offset').all(ref);
    assert.deepEqual(ids(alias.ref), ids(originals.get(alias.identity).ref));
  }
  const stableVectors = vectors(), stableLinks = links(), changes = cache.prepare('SELECT total_changes() n').get().n;
  await prepareDelta([]);
  assert.equal(cache.prepare('SELECT total_changes() n').get().n, changes, 'repeat preparation is also metadata-idempotent');
  reopen(); await prepareDelta([]);
  assert.deepEqual(vectors(), stableVectors); assert.deepEqual(links(), stableLinks);
  for (const ref of new Set(oldLinks.map(row => row.ref))) assert.equal(index.read(ref).record.ref, ref);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_messages').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_runs').get().n, 0, 'no provider or background job was launched');
});

test('cancelled rollover preparation retains its committed delta vectors across close/reopen and retry', async () => {
  const oldIds = entries('OLD', 5), first = store.startSync();
  await prepareDelta(expectedMissing()); const oldVectors = vectors(), oldLinks = links();
  expire(first);
  const combined = store.startSync(); sameItems(combined, oldIds);
  // Expire again so the arrivals really belong to a new full store snapshot.
  expire(combined);
  const ids = [...oldIds, ...entries('CANCEL DELTA', 72)];
  const next = store.startSync(); sameItems(next, ids);
  model.calls.length = 0;
  model.beforeBatch = () => { if (model.calls.length >= 64) throw new DOMException('Synthetic preparation cancelled', 'AbortError'); };
  await assert.rejects(index.prepare(), error => error.name === 'AbortError');
  assert.equal(model.calls.length, 64);
  assert.equal(vectors().length, oldVectors.length + 64, 'completed commit is durable, not rolled back with cancellation');
  retained(oldVectors); retainedLinks(oldLinks);
  assert.equal(indexReadiness(cache, db).ready, false, 'partial work cannot grant global readiness');
  const committed = vectors(), committedBodies = new Set(model.calls);
  model.beforeBatch = null; reopen();
  const delta = expectedMissing(); assert.equal(delta.length, 8);
  assert.ok(delta.every(body => !committedBodies.has(body)));
  await prepareDelta(delta); retained(committed); retainedLinks(oldLinks);
  reopen(); await prepareDelta([]);
});

test('changed source projection invalidates only new passage inputs; frozen old evidence and unrelated vectors remain', async () => {
  const ids = [...entries('ORIGINAL', 3), ...entries('UNRELATED', 2, 'session-b')];
  const first = store.startSync(); await prepareDelta(expectedMissing());
  const oldVectors = vectors(), oldRecords = records(); expire(first);
  const obsolete = oldRecords.find(r => r.kind === 'session' && r.position === ids[0]);
  editEntry(db, process.env.DRAKEN_PI_SESSIONS_DIR, ids[0], 'CORRECTED source projection, not the earlier claim.');
  const combined = store.startSync(); sameItems(combined, ids);
  const delta = expectedMissing(); assert.equal(delta.length, 1); assert.match(delta[0], /CORRECTED/);
  await prepareDelta(delta); retained(oldVectors);
  for (const record of oldRecords.filter(row => row.ref !== obsolete.ref)) {
    assert.equal(index.read(record.ref).record.text, record.text);
  }
  assert.throws(() => index.read(obsolete.ref), /no longer admitted/);
  reopen(); await prepareDelta([]);
});

test('metadata-only alias replacement keeps unchanged passage bytes; title is intentionally part of the persisted embedding input', async () => {
  entries('METADATA', 3); entries('UNAFFECTED', 2, 'session-b');
  await prepareDelta(expectedMissing());
  const originalOnly = vectors();
  // Exercise replacement even without an old frozen alias keeping the physical
  // passage alive: add the new metadata link before collecting orphaned input.
  db.prepare("UPDATE agent_sessions SET cwd='/synthetic/first-move' WHERE id='session-a'").run();
  await prepareDelta([]); retained(originalOnly);
  const first = store.startSync(); await prepareDelta([]); expire(first);
  const oldVectors = vectors();
  const frozenRefs = records().filter(row => row.kind === 'snapshot').map(row => row.ref);
  // Workspace changes H metadata but, with a nonempty title, not the input body.
  db.prepare("UPDATE agent_sessions SET cwd='/synthetic/moved' WHERE id='session-a'").run();
  const second = store.startSync();
  await prepareDelta([]); retained(oldVectors);
  for (const ref of frozenRefs) assert.equal(index.read(ref).record.ref, ref);
  expire(second);
  db.prepare("UPDATE agent_sessions SET name='Renamed title' WHERE id='session-a'").run();
  store.startSync();
  const delta = expectedMissing(); assert.equal(delta.length, 3);
  assert.ok(delta.every(body => body.startsWith('Renamed title\n')));
  await prepareDelta(delta); retained(oldVectors); // Earlier snapshots still use the old title.
  reopen(); await prepareDelta([]);
});

test('model fingerprint change invalidates all distinct model-dependent inputs, not one vector per frozen alias', async () => {
  entries('MODEL', 5); const first = store.startSync();
  await prepareDelta(expectedMissing()); expire(first); store.startSync(); await prepareDelta([]);
  const refs = records().map(row => row.ref).sort(), oldVectors = vectors();
  model = synthetic('rollover-synthetic-v2'); reopen(model);
  assert.equal(vectors().length, 0, 'a different model may not reuse old model vectors');
  const delta = expectedMissing(); assert.equal(delta.length, oldVectors.length);
  await prepareDelta(delta);
  assert.deepEqual(records().map(row => row.ref).sort(), refs, 'model changes do not change source H identity');
  assert.ok(vectors().every(row => !oldVectors.some(old => old.hash === row.hash)));
  reopen(); await prepareDelta([]);
});

test('rollover reuse never bypasses original verification, exclusions or missing-source admission', async () => {
  entries('VERIFY', 3); entries('SAFE', 2, 'session-b');
  const first = store.startSync(); await prepareDelta(expectedMissing()); expire(first);
  const combined = store.startSync(); await prepareDelta([]);
  const refs = records().filter(row => row.session_id === 'session-a').map(row => row.ref);
  const safeVectors = vectors().filter(row => cache.prepare("SELECT 1 FROM chunk_links c JOIN records r ON r.ref=c.ref WHERE c.passage_id=? AND r.session_id='session-b'").get(row.id));
  const file = db.prepare("SELECT path FROM agent_sessions WHERE id='session-a'").get().path;
  const original = fs.readFileSync(file), calls = model.calls.length;
  fs.renameSync(file, file + '.missing');
  await assert.rejects(index.prepare(), /ENOENT|unavailable|changed/);
  await assert.rejects(index.prepare({ sync_id: combined.id }), /unavailable|changed/, 'scoped preparation must verify original bytes too');
  assert.throws(() => index.read(refs[0]), /unavailable|changed/);
  await assert.rejects(index.search({ question: 'VERIFY', sync_id: combined.id }, undefined, true), /unavailable|changed/);
  assert.equal(model.calls.length, calls); assert.equal(model.queries.length, 1, 'query inference selects candidates before original validation');
  fs.renameSync(file + '.missing', file); await prepareDelta([]);
  fs.writeFileSync(file, original.toString().replace('VERIFY', 'BROKEN'));
  // Scoped preparation bypasses receipt-file metadata checks, not authoritative
  // original record hashing. Even warm normalization/vector caches must fail.
  await assert.rejects(index.prepare({ sync_id: combined.id }), /unavailable|changed/);
  assert.throws(() => index.read(refs[0]), /unavailable|changed/);
  assert.equal(model.calls.length, calls);
  fs.writeFileSync(file, original);
  db.prepare("UPDATE agent_sessions SET modified_at=? WHERE id='session-a'").run(fs.statSync(file).mtime.toISOString());
  await prepareDelta([]);
  for (const flag of ['included=0', 'missing=1']) {
    db.prepare(`UPDATE agent_sessions SET ${flag} WHERE id='session-a'`).run();
    await prepareDelta([]); retained(safeVectors);
    assert.equal(cache.prepare("SELECT COUNT(*) n FROM records WHERE session_id='session-a'").get().n, 0);
    for (const ref of refs) assert.throws(() => index.read(ref), /no longer admitted/);
    assert.deepEqual((await index.search({ question: 'VERIFY', session_id: 'session-a' }, undefined, true)).results, []);
    assert.equal(model.queries.length, 1, 'an empty admitted scope adds no query inference');
    db.prepare("UPDATE agent_sessions SET included=1,missing=0 WHERE id='session-a'").run();
    // Pruned excluded passages may legitimately need rebuilding after readmission.
    const delta = expectedMissing(); assert.equal(delta.length, 3);
    await prepareDelta(delta); retained(safeVectors);
  }
});
