const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { getDb, closeDb, initSchema } = require('../dist/db/schema');
const { scanSessions } = require('../dist/sync/collector');
const { EntryReader } = require('../dist/sync/source-files');
const { fileRecords } = require('../dist/sync/jsonl');
const { normalizeEntry, digest } = require('../dist/sync/normalize');
const { EvidenceReader } = require('../dist/db/evidence');
const { migratePointers } = require('../dist/db/pointer-migration');
const { historySources } = require('../dist/memory/sources');
const { HistoryIndex } = require('../dist/memory/index');
const store = require('../dist/sync/store');
const { legacyEntries, legacyIndex } = require('./fixtures/legacy-storage.cjs');
let root, db, caches;
const at = '2020-01-01T00:00:00.000Z';
const event = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp: at, message: { role: 'assistant', content: text } });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-storage-test-')); fs.mkdirSync(path.join(root, 'sessions'));
  Object.assign(process.env, { DRAKEN_DATA_DIR: path.join(root, 'state'), DRAKEN_PI_SESSIONS_DIR: path.join(root, 'sessions') });
  db = getDb(); caches = [];
});
afterEach(() => { for (const cache of caches) cache.close(); closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
function source(records, id = 'demo') {
  const file = path.join(root, 'sessions', id + '.jsonl'), header = { type: 'session', version: 3, id, cwd: '/demo', timestamp: at };
  fs.writeFileSync(file, [header, ...records].map(JSON.stringify).join('\n') + '\n'); return { file, header };
}
function read(id) { const reader = new EntryReader(db); try { return reader.effective(id); } finally { reader.close(); } }
function model() { return { fingerprint: 'synthetic-pointer-v1', calls: 0, ready: () => true, setup: async () => {}, async embed() { this.calls++; const v = new Float32Array(384); v[0] = 1; return v; } }; }
function cache() { const value = new Database(':memory:'); caches.push(value); return value; }
function thaw(value) { const reader = new EvidenceReader(db); try { return reader.read(value); } finally { reader.close(); } }
function downgrade() {
  const rows = db.prepare('SELECT * FROM agent_entries ORDER BY id').all();
  const values = rows.map(row => {
    const session = db.prepare('SELECT path FROM agent_sessions WHERE id=?').get(row.session_id), fd = fs.openSync(session.path, 'r');
    let normalized;
    try { for (const record of fileRecords(fd, fs.fstatSync(fd).size)) if (record.value?.id === row.entry_id) normalized = normalizeEntry(record.value, row.normalization || 2); }
    finally { fs.closeSync(fd); }
    return { ...row, text: normalized.text, replacement: normalized.replacement, effective_text: read(row.id) };
  });
  for (const row of db.prepare('SELECT * FROM sync_items').all()) db.prepare('UPDATE sync_items SET evidence_json=? WHERE sync_id=? AND event_key=?').run(JSON.stringify(thaw(row.evidence_json)), row.sync_id, row.event_key);
  for (const row of db.prepare('SELECT id,context_json FROM syncs').all()) db.prepare('UPDATE syncs SET context_json=? WHERE id=?').run(JSON.stringify(JSON.parse(row.context_json).map(thaw)), row.id);
  legacyEntries(db);
  for (const row of values) db.prepare(`INSERT INTO agent_entries(id,session_id,entry_id,parent_id,timestamp,type,role,text,effective_text,event_key,is_activity,active,present,target_id,replacement)
    VALUES(@id,@session_id,@entry_id,@parent_id,@timestamp,@type,@role,@text,@effective_text,@event_key,@is_activity,@active,@present,@target_id,@replacement)`).run(row);
  db.exec('DELETE FROM retained_text'); return values;
}

test('live entries and frozen evidence contain only verified pointers; unavailable sources are explicit', async () => {
  const s = source([event('one', null, 'Unicode 🐉: deployment NOT checked.')]); await scanSessions();
  const row = db.prepare('SELECT * FROM agent_entries').get(), bytes = fs.readFileSync(s.file);
  assert.equal(row.text, undefined); assert.equal(row.effective_text, undefined); assert.equal(row.replacement, undefined);
  assert.equal(row.record_hash, digest(bytes.subarray(row.record_offset, row.record_offset + row.record_bytes)));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='retained_text'").get().n, 0);
  const first = store.startSync(), frozen = first.items;
  store.discardSync(first.id); const second = store.startSync();
  assert.deepEqual(second.items, frozen);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='retained_text'").get().n, 0, 'repeat snapshots do not store any pi bodies');
  assert.ok(db.prepare('SELECT evidence_json FROM sync_items').all().every(row => !('text' in JSON.parse(row.evidence_json))));
  fs.unlinkSync(s.file);
  assert.ok(store.getSync(first.id).items[0].unavailable); assert.equal(store.getSync(second.id).items[0].text, '');
  assert.throws(() => read(row.id), /unavailable/);
  assert.throws(() => store.completeSync(second.id, '', '', true), /Original session evidence/);
  store.saveNotes(second.id, 'Explicit note still editable', ''); assert.equal(store.getSync(second.id).decisions, 'Explicit note still editable');
  assert.equal(require('../dist/sync/normalize').sourceKey(store.getSync(second.id).items[0]), require('../dist/sync/normalize').sourceKey(frozen[0]));
  fs.writeFileSync(s.file, bytes); assert.deepEqual(store.getSync(first.id).items, frozen);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});

test('rewritten/truncated/replaced pointers fail closed; a middle rewrite plus append is recovered by scanning', async () => {
  const records = Array.from({ length: 8 }, (_, i) => event(String(i), i ? String(i - 1) : null, `${i}: ` + 'x'.repeat(600)));
  const s = source(records); await scanSessions(); const first = store.startSync(), row = db.prepare("SELECT id FROM agent_entries WHERE entry_id='3'").get();
  records[3] = event('3', '2', '3: ' + 'y'.repeat(600)); records.push(event('8', '7', 'New tail'));
  fs.writeFileSync(s.file, [s.header, ...records].map(JSON.stringify).join('\n') + '\n');
  assert.throws(() => read(row.id), /unavailable/);
  assert.ok(store.getSync(first.id).items[3].unavailable);
  await scanSessions(); assert.match(read(row.id), /yyy/);
  const bytes = fs.readFileSync(s.file), replacement = s.file + '.new'; fs.writeFileSync(replacement, bytes); fs.renameSync(replacement, s.file);
  assert.throws(() => read(row.id), /unavailable/, 'matching content in a replacement inode still needs a scan');
  await scanSessions(); assert.match(read(row.id), /yyy/);
  fs.truncateSync(s.file, 20); assert.throws(() => read(row.id), /unavailable/);
  assert.equal(store.getSync(first.id).items.length, 8); assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});

test('source resolution refuses outside-root paths and changed headers, and handles a moved file after scanning', async () => {
  const s = source([event('one', null, 'Original evidence')]); await scanSessions(); const row = db.prepare('SELECT id FROM agent_entries').get();
  const moved = path.join(root, 'sessions', 'moved.jsonl'); fs.renameSync(s.file, moved);
  assert.throws(() => read(row.id), /unavailable/); await scanSessions(); assert.equal(read(row.id), 'Original evidence');
  const bytes = fs.readFileSync(moved), outside = path.join(root, 'outside.jsonl'); fs.writeFileSync(outside, bytes);
  const stat = fs.statSync(outside); db.prepare('UPDATE agent_sessions SET path=?,file_identity=?').run(outside, `${stat.dev}:${stat.ino}`);
  assert.throws(() => read(row.id), /unavailable/);
  const originalStat = fs.statSync(moved); db.prepare('UPDATE agent_sessions SET path=?,file_identity=?').run(moved, `${originalStat.dev}:${originalStat.ino}`);
  fs.writeFileSync(moved, bytes.toString().replace('"id":"demo"', '"id":"evil"'));
  const reader = new EntryReader(db);
  try { assert.throws(() => reader.effective(row.id), /unavailable/); assert.throws(() => reader.effective(row.id), /unavailable/); } finally { reader.close(); }
});

test('canonical migration preserves projections, immutable evidence, notes, coverage, references and sequences; rerun is inert', async () => {
  const s = source([event('one', null, 'Original task'), event('two', 'one', 'Original claim'),
    { type: 'context_edit', id: 'edit', parentId: 'two', targetId: 'two', replacement: 'Correction: NOT tested.', timestamp: at }]);
  await scanSessions(); const first = store.startSync(); store.saveNotes(first.id, 'Explicit decision', 'Still unresolved');
  const before = store.getSync(first.id), history = [...historySources(db)], bytes = fs.readFileSync(s.file);
  const old = downgrade(); db.prepare("UPDATE sqlite_sequence SET seq=101 WHERE name='agent_entries'").run();
  initSchema(db);
  assert.deepEqual(store.getSync(first.id), before); assert.deepEqual([...historySources(db)], history);
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='agent_entries'").get().seq, 101);
  for (const row of old) assert.equal(read(row.id), row.effective_text);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_entries WHERE record_hash IS NOT NULL').get().n, old.length);
  assert.deepEqual(fs.readFileSync(s.file), bytes);
  const state = JSON.stringify(['agent_entries', 'syncs', 'sync_items', 'sync_coverage', 'sync_settings'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  initSchema(db); assert.equal(JSON.stringify(['agent_entries', 'syncs', 'sync_items', 'sync_coverage', 'sync_settings'].map(table => db.prepare(`SELECT * FROM ${table}`).all())), state);
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});

test('missing or changed legacy originals stop conversion without deleting their existing evidence', async () => {
  const a = source([event('a', null, 'Keep missing-source text')], 'alpha');
  const b = source([event('b', null, 'Keep pre-rewrite text')], 'beta'); await scanSessions(); const old = downgrade();
  fs.unlinkSync(a.file); fs.writeFileSync(b.file, fs.readFileSync(b.file, 'utf8').replace('pre-rewrite', 'new-rewrite'));
  assert.throws(() => initSchema(db), /Pointer migration stopped/);
  for (const row of old) assert.equal(db.prepare('SELECT effective_text FROM agent_entries WHERE id=?').get(row.id).effective_text, row.effective_text);
  assert.ok(db.pragma('table_info(agent_entries)').some(column => column.name === 'text'));
});

test('a failed canonical conversion rolls back the schema and all representation writes', async () => {
  source([event('one', null, 'Keep evidence')]); await scanSessions(); const first = store.startSync(); downgrade();
  db.prepare('UPDATE syncs SET context_json=? WHERE id=?').run('[{"ref":"broken"}]', first.id);
  const before = JSON.stringify(['agent_entries', 'retained_text', 'sync_items', 'syncs', 'sync_settings'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  assert.throws(() => initSchema(db), /content reference/);
  assert.equal(JSON.stringify(['agent_entries', 'retained_text', 'sync_items', 'syncs', 'sync_settings'].map(table => db.prepare(`SELECT * FROM ${table}`).all())), before);
  assert.ok(db.pragma('table_info(agent_entries)').some(row => row.name === 'text'));
  db.prepare('UPDATE syncs SET context_json=? WHERE id=?').run('[]', first.id); initSchema(db); assert.equal(store.getSync(first.id).items[0].text, 'Keep evidence');
});

test('search migration keeps every compatible vector byte and FTS occurrence, without inference; shared vectors retain scopes', async () => {
  source([event('one', null, 'Deployment was NOT checked.')], 'alpha'); source([event('one', null, 'Deployment was NOT checked.')], 'beta'); await scanSessions();
  const s = store.startSync(), modern = cache(), embedder = model(), index = new HistoryIndex(modern, db, embedder); await index.prepare();
  const records = [...historySources(db)], chunks = modern.prepare('SELECT * FROM chunks').all(), embeddings = modern.prepare('SELECT * FROM embedding_cache').all();
  assert.ok(chunks.length > embeddings.length);
  const old = cache(); legacyIndex(old, records, chunks, embeddings, embedder.fingerprint);
  old.prepare("INSERT INTO meta VALUES('covered-tails-removed','1')").run();
  old.prepare('INSERT INTO embedding_cache VALUES(?,?)').run('cache-only-retained', embeddings[0].embedding);
  const before = old.prepare('SELECT hash,hex(embedding) bytes FROM embedding_cache ORDER BY hash').all();
  const words = old.prepare("SELECT rowid,bm25(words) score FROM words WHERE words MATCH 'checked' ORDER BY rowid").all();
  const canonical = JSON.stringify(['agent_entries', 'syncs', 'sync_items', 'sync_coverage'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  const calls = embedder.calls, restored = new HistoryIndex(old, db, embedder);
  assert.equal(embedder.calls, calls); assert.deepEqual(old.prepare('SELECT hash,hex(embedding) bytes FROM embedding_cache ORDER BY hash').all(), before);
  assert.deepEqual(old.prepare("SELECT rowid,bm25(words) score FROM words WHERE words MATCH 'checked' ORDER BY rowid").all(), words);
  assert.equal(old.prepare("SELECT type FROM sqlite_schema WHERE name='embedding_cache'").get().type, 'view');
  assert.equal(old.prepare('SELECT COUNT(*) n FROM passage_vectors').get().n, before.length);
  assert.ok(old.prepare('SELECT json FROM records').all().every(row => !('text' in JSON.parse(row.json))));
  old.prepare("INSERT INTO words(words,rank) VALUES('integrity-check',1)").run();
  for (const scope of [{ session_id: 'alpha' }, { session_id: 'beta' }, { sync_id: s.id }]) {
    const result = await restored.search({ question: 'checked', ...scope }); assert.ok(result.results.length);
    for (const row of result.results) for (const [key, value] of Object.entries(scope)) assert.equal(row[key], value);
  }
  assert.equal(embedder.calls, calls + 3, 'only three query vectors, no passage re-embedding');
  assert.equal(JSON.stringify(['agent_entries', 'syncs', 'sync_items', 'sync_coverage'].map(table => db.prepare(`SELECT * FROM ${table}`).all())), canonical);
  assert.deepEqual(old.pragma('foreign_key_check'), []);
});

test('frozen historical search windows survive migration, ordinary preparation and prepared-only lookup without re-embedding', async () => {
  const { fingerprint, records: frozenRecords, chunks: frozenChunks } = require('./fixtures/search-cache.cjs');
  const { sourceEntry } = require('./fixtures/source-entry.cjs');
  for (const chunk of frozenChunks) {
    assert.match(chunk.hash, /^[a-f0-9]{64}$/);
    assert.equal(Buffer.from(chunk.bytes, 'hex').length, 1536);
  }
  for (const record of frozenRecords) sourceEntry(db, process.env.DRAKEN_PI_SESSIONS_DIR, record.text,
    { session: record.session, name: record.title, role: record.role, timestamp: at });
  // Only attribution comes from canonical sources. No live index supplies any
  // historical offset, body, hash or vector in this fixture.
  const records = [...historySources(db)];
  assert.equal(records.length, 2);
  for (const record of records) {
    const expected = frozenRecords.find(item => item.session === record.session_id);
    assert.equal(record.title, expected.title); assert.equal(record.role, expected.role); assert.equal(record.text, expected.text);
  }
  const old = cache(), embeddings = frozenChunks.map(chunk => ({ hash: chunk.hash, embedding: Buffer.from(chunk.bytes, 'hex') }));
  const chunks = frozenChunks.map((chunk, i) => ({ ...chunk, id: i + 1, embedded: 1,
    ref: records.find(record => record.session_id === chunk.session).ref }));
  legacyIndex(old, records, chunks, embeddings, fingerprint);
  const bytes = () => old.prepare('SELECT hash,lower(hex(embedding)) bytes FROM embedding_cache ORDER BY hash').all();
  const expectedBytes = frozenChunks.map(({ hash, bytes }) => ({ hash, bytes })).sort((a, b) => a.hash.localeCompare(b.hash));
  const links = () => old.prepare('SELECT ref,offset,hash,embedded FROM chunks ORDER BY ref,offset').all();
  const expectedLinks = sources => sources.flatMap(record => frozenChunks
    .filter(chunk => chunk.keep && chunk.session === record.session_id)
    .map(chunk => ({ ref: record.ref, offset: chunk.offset, hash: chunk.hash, embedded: 1 })))
    .sort((a, b) => a.ref.localeCompare(b.ref) || a.offset - b.offset);
  let queries = 0;
  const embedder = { fingerprint, ready: () => true, setup: async () => {},
    async embed(_body, query) {
      assert.equal(query, true, 'Historical passage vectors must be reused, never re-embedded');
      queries++; const vector = new Float32Array(384); vector[0] = 1; return vector;
    } };
  const restored = new HistoryIndex(old, db, embedder);
  assert.equal(queries, 0);
  assert.deepEqual(bytes(), expectedBytes, 'including the now-unlinked covered-tail vector');
  assert.deepEqual(links(), expectedLinks(records));
  assert.deepEqual(old.prepare('SELECT id FROM chunks ORDER BY id').all().map(row => row.id), [1, 2, 4, 5]);
  assert.equal(old.prepare("SELECT COUNT(*) n FROM words WHERE words MATCH 'Frozen'").get().n, 4);
  await restored.prepare(); assert.equal(queries, 0);
  assert.deepEqual(links(), expectedLinks(records));

  // Newly frozen aliases force the ordinary live recipe to look up these old
  // hashes, rather than merely accepting already-embedded legacy occurrences.
  const snapshot = store.startSync(), aliases = [...historySources(db)];
  assert.equal(aliases.length, 4);
  await restored.prepare(); assert.equal(queries, 0);
  assert.deepEqual(links(), expectedLinks(aliases)); assert.deepEqual(bytes(), expectedBytes);
  assert.ok((await restored.search({ question: 'Frozen', session_id: 'frozen-multi' })).results.length);
  assert.equal(queries, 1, 'ordinary search embeds only its question');

  const cutoff = '2021-01-01T00:00:00.000Z';
  const cold = new HistoryIndex(old, db, { ...embedder, setup: async (_report, allowDownload) => assert.equal(allowDownload, false) });
  const writes = old.prepare('SELECT total_changes() n').get().n;
  const canonical = JSON.stringify(['agent_entries', 'syncs', 'sync_items', 'sync_coverage'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  for (const scope of [{ session_id: 'frozen-multi' }, { session_id: 'frozen-unicode' }, { sync_id: snapshot.id }]) {
    const found = await cold.search({ question: 'Frozen', before: cutoff, ...scope }, undefined, true);
    assert.ok(found.results.length);
    for (const result of found.results) {
      assert.ok(aliases.some(record => record.ref === result.ref));
      for (const [key, value] of Object.entries(scope)) assert.equal(result[key], value);
    }
  }
  assert.equal(queries, 4, 'three prepared queries, no passage inference');
  for (const record of records) {
    const page = cold.read(record.ref, 700, cutoff);
    assert.equal(page.record.ref, record.ref); assert.equal(page.offset, 700);
    assert.equal(page.record.text, record.text.slice(700)); assert.equal(page.total, record.text.length);
  }
  assert.equal(old.prepare('SELECT total_changes() n').get().n, writes, 'prepared lookups and source reads do not rewrite the cache');
  assert.deepEqual(bytes(), expectedBytes); assert.deepEqual(links(), expectedLinks(aliases));
  assert.equal(JSON.stringify(['agent_entries', 'syncs', 'sync_items', 'sync_coverage'].map(table => db.prepare(`SELECT * FROM ${table}`).all())), canonical);

  const file = db.prepare("SELECT path FROM agent_sessions WHERE id='frozen-multi'").get().path;
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('a'.repeat(699), 'z'.repeat(699)));
  await assert.rejects(cold.search({ question: 'Frozen', session_id: 'frozen-multi', before: cutoff }, undefined, true), /unavailable/);
  assert.equal(queries, 4, 'source verification precedes query inference');
  assert.deepEqual(bytes(), expectedBytes);
  fs.writeFileSync(file, original);
  db.prepare("UPDATE agent_sessions SET included=0 WHERE id='frozen-multi'").run();
  assert.deepEqual((await cold.search({ question: 'Frozen', session_id: 'frozen-multi', before: cutoff }, undefined, true)).results, []);
  assert.throws(() => cold.read(records.find(record => record.session_id === 'frozen-multi').ref, 0, cutoff), /no longer admitted/);
  old.prepare("INSERT INTO words(words,rank) VALUES('integrity-check',1)").run();
  assert.deepEqual(old.pragma('foreign_key_check'), []);
});

test('conflicting existing vectors abort atomically rather than silently replacing cached embeddings', async () => {
  source([event('one', null, 'Synthetic claim')]); await scanSessions();
  const modern = cache(), embedder = model(), index = new HistoryIndex(modern, db, embedder); await index.prepare();
  const old = cache(), records = [...historySources(db)], chunks = modern.prepare('SELECT * FROM chunks').all(), embeddings = modern.prepare('SELECT * FROM embedding_cache').all();
  legacyIndex(old, records, chunks, embeddings, embedder.fingerprint);
  const wrong = new Float32Array(384); wrong[1] = 1; old.prepare('UPDATE embedding_cache SET embedding=?').run(Buffer.from(wrong.buffer));
  assert.throws(() => new HistoryIndex(old, db, embedder), /embeddings disagree/);
  assert.equal(old.prepare("SELECT value FROM meta WHERE key='schema'").get().value, 'history-index-v1');
  assert.equal(old.prepare("SELECT type FROM sqlite_schema WHERE name='chunks'").get().type, 'table');
  assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='passages'").get().n, 0);
  old.prepare('UPDATE embedding_cache SET embedding=?').run(embeddings[0].embedding);
  new HistoryIndex(old, db, embedder); assert.equal(old.prepare('SELECT COUNT(*) n FROM passage_vectors').get().n, 1);
});

test('context-edit pointers verify both the target attribution and replacement record', async () => {
  const s = source([event('one', null, 'Original attribution'), { type: 'context_edit', id: 'edit', parentId: 'one', targetId: 'one', replacement: 'Corrected statement', timestamp: at }]);
  await scanSessions(); const row = db.prepare("SELECT id FROM agent_entries WHERE entry_id='one'").get(), bytes = fs.readFileSync(s.file, 'utf8');
  assert.equal(read(row.id), 'Corrected statement');
  fs.writeFileSync(s.file, bytes.replace('Original attribution', 'Modified attribution')); assert.throws(() => read(row.id), /unavailable/);
  fs.writeFileSync(s.file, bytes.replace('Corrected statement', 'Different statement')); assert.throws(() => read(row.id), /unavailable/);
  fs.writeFileSync(s.file, bytes); assert.equal(read(row.id), 'Corrected statement');
  downgrade(); initSchema(db); assert.ok(db.prepare("SELECT effective_id FROM agent_entries WHERE entry_id='one'").get().effective_id);
  assert.ok(!db.pragma('table_info(agent_entries)').some(column => column.name === 'effective_legacy_ref'));
});

test('unknown storage versions fail closed and legacy empty replacements are retained distinctly from null', async () => {
  const s = source([event('one', null, 'Original'), { type: 'context_edit', id: 'edit', parentId: 'one', targetId: 'one', replacement: '', timestamp: at }]);
  await scanSessions(); downgrade(); fs.unlinkSync(s.file); migratePointers(db);
  const edit = db.prepare("SELECT legacy_replacement_ref FROM agent_entries WHERE entry_id='edit'").get();
  assert.ok(edit.legacy_replacement_ref); assert.equal(require('../dist/db/retained-text').retainedText(db, edit.legacy_replacement_ref), '');
  assert.throws(() => initSchema(db), /Pointer migration stopped/);
  db.prepare("UPDATE sync_settings SET value='future-unknown' WHERE key='storage_schema'").run(); assert.throws(() => initSchema(db), /Unknown canonical storage/);
  const derived = cache(); derived.exec('CREATE TABLE records(ref TEXT)'); assert.throws(() => new HistoryIndex(derived, db, model()), /Unknown history storage/);
  assert.equal(derived.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='passages'").get().n, 0);
});

test('frozen pointers pin edits and excerpts, survive appends/branch changes, and follow verified moved files', async () => {
  const initial=event('one',null,'Original claim'),edit={type:'context_edit',id:'edit-a',parentId:'one',targetId:'one',replacement:'First correction; NOT verified.',timestamp:at};
  const s=source([initial,edit]);await scanSessions();const first=store.startSync();
  const encoded=db.prepare('SELECT evidence_json FROM sync_items WHERE sync_id=?').get(first.id).evidence_json;
  assert.equal(JSON.parse(encoded).source_pointer.edit.entry_id,'edit-a');
  fs.appendFileSync(s.file,JSON.stringify({...edit,id:'edit-b',parentId:'edit-a',replacement:'Later correction; verified.'})+'\n');await scanSessions();
  assert.equal(read(db.prepare("SELECT id FROM agent_entries WHERE entry_id='one'").get().id),'Later correction; verified.');
  assert.equal(store.getSync(first.id).items[0].text,'First correction; NOT verified.');
  fs.appendFileSync(s.file,JSON.stringify(event('other','one','Different branch'))+'\n');await scanSessions();
  assert.equal(read(db.prepare("SELECT id FROM agent_entries WHERE entry_id='one'").get().id),'Original claim');
  assert.deepEqual(store.getSync(first.id).items,first.items);
  const moved=path.join(root,'sessions','renamed.jsonl');fs.renameSync(s.file,moved);await scanSessions();assert.deepEqual(store.getSync(first.id).items,first.items);
  assert.equal(db.prepare('SELECT evidence_json FROM sync_items WHERE sync_id=?').get(first.id).evidence_json,encoded);
});

test('background clipping and legacy normalization are pinned without retaining text bodies', async () => {
  const s=source([event('old',null,'Long 🐉 '+ 'detail '.repeat(600)),{...event('new','old','Current progress'),timestamp:'2021-01-01T00:00:00.000Z'}]);
  await scanSessions();const first=store.startSync('2021-01-01T00:00:00.000Z');assert.equal(first.context.length,1);assert.match(first.context[0].text,/excerpt truncated/);
  assert.equal(JSON.parse(db.prepare('SELECT context_json FROM syncs WHERE id=?').get(first.id).context_json)[0].source_pointer.clip.limit,2000);
  fs.appendFileSync(s.file,JSON.stringify(event('tail','new','Another arrival'))+'\n');await scanSessions();assert.deepEqual(store.getSync(first.id).context,first.context);
  store.discardSync(first.id);db.prepare("UPDATE sync_settings SET value='' WHERE key='history_since'").run();
  require('./fixtures/source-entry.cjs').sourceEntry(db,process.env.DRAKEN_PI_SESSIONS_DIR,'**Password:** `synthetic-legacy-only`',{session:'legacy',normalization:1});
  const second=store.startSync(),before=store.getSync(second.id);downgrade();initSchema(db);assert.deepEqual(store.getSync(second.id),before);
  assert.equal(db.prepare("SELECT normalization FROM agent_entries WHERE session_id='legacy'").get().normalization,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='retained_text'").get().n,0);
  const e=store.getSync(second.id).items.find(item=>item.session_id==='legacy');assert.match(e.text,/synthetic-legacy-only/);
  assert.doesNotMatch(require('../dist/sync/normalize').cleanText(e.text),/synthetic-legacy-only/,'current model-facing redaction is unchanged');
});

test('legacy snapshots with indistinguishable edit candidates refuse migration instead of inventing a selection', async () => {
  const original=event('one',null,'Original'),edit={type:'context_edit',id:'edit-a',parentId:'one',targetId:'one',replacement:'Same corrected text',timestamp:at};
  const s=source([original,edit]);await scanSessions();const first=store.startSync();
  fs.appendFileSync(s.file,JSON.stringify({...edit,id:'edit-b',parentId:'edit-a'})+'\n');await scanSessions();
  assert.deepEqual(store.getSync(first.id).items,first.items,'new pointers already know the exact selection');
  downgrade();const before=db.prepare('SELECT evidence_json FROM sync_items WHERE sync_id=?').get(first.id).evidence_json;
  assert.throws(()=>initSchema(db),/Pointer migration stopped/);
  assert.equal(db.prepare('SELECT evidence_json FROM sync_items WHERE sync_id=?').get(first.id).evidence_json,before);
  assert.ok(db.pragma('table_info(agent_entries)').some(column=>column.name==='text'));
});

test('missing source blocks generation, calls and review, not conversations or explicit notes', async () => {
  const s=source([event('one',null,'Original result')]);await scanSessions();const first=store.startSync();
  db.prepare('INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES(?,?,?,?)').run(first.id,'user','Retain this discussion',at);
  fs.unlinkSync(s.file);
  const unavailable=store.getSync(first.id);assert.ok(unavailable.items[0].unavailable);assert.equal(unavailable.messages[0].content,'Retain this discussion');
  const manager=require('../dist/sync/manager');assert.throws(()=>manager.launchReply(first.id,'Explain'),/Original session evidence/);
  await assert.rejects(manager.generateReply(first.id,'Explain'),/Original session evidence/);
  await assert.rejects(require('../dist/voice/live').createLiveCall(first.id,new AbortController().signal),/Original session evidence/);
  assert.throws(()=>store.completeSync(first.id,'','',true),/Original session evidence/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_runs').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM live_calls').get().n,0);
  store.saveNotes(first.id,'Explicit saved note','Unresolved');assert.equal(store.getSync(first.id).decisions,'Explicit saved note');
  await scanSessions();const sources=[...historySources(db)];assert.ok(sources.some(item=>item.kind==='discussion'));assert.ok(!sources.some(item=>item.kind==='snapshot'));
  store.discardSync(first.id);assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_coverage').get().n,0);
});

test('contentless search preserves embeddings and keywords but stores no source bodies; exclusion deletes postings safely', async () => {
  const s=source([event('one',null,'Unique archival phrase: deployment NOT verified.')]);await scanSessions();const first=store.startSync();
  const derived=cache(),index=new HistoryIndex(derived,db,model());const result=await index.search({question:'archival'});assert.ok(result.results.length);
  assert.ok(!derived.pragma('table_info(passages)').some(column=>column.name==='body'));
  assert.equal(derived.prepare('SELECT COUNT(*) n FROM words WHERE body IS NOT NULL').get().n,0);
  assert.equal(derived.prepare("SELECT COUNT(*) n FROM words WHERE words MATCH 'archival'").get().n,2);
  fs.unlinkSync(s.file);await scanSessions();assert.deepEqual((await index.search({question:'archival'})).results,[]);
  assert.equal(derived.prepare("SELECT COUNT(*) n FROM words WHERE words MATCH 'archival'").get().n,0);
  assert.ok(store.getSync(first.id).items[0].unavailable);
  derived.prepare("INSERT INTO words(words) VALUES('integrity-check')").run();
});

test('normalization reuse always re-verifies source bytes and cannot hide rewrites or unavailable originals', async () => {
  const s=source([event('one',null,'Original result')]);await scanSessions();store.startSync();
  const {NormalizationCache}=require('../dist/sync/jsonl'),cache=new NormalizationCache(),normalize=require('../dist/sync/normalize'),original=normalize.normalizeEntry;
  let calls=0;normalize.normalizeEntry=(...args)=>{calls++;return original(...args);};
  try {
    const before=[...historySources(db,process.env.DRAKEN_PI_SESSIONS_DIR,cache)];assert.equal(calls,1,'snapshot and live projection share normalization after separate verification');
    assert.deepEqual([...historySources(db,process.env.DRAKEN_PI_SESSIONS_DIR,cache)],before);assert.equal(calls,1);
    const stat=fs.statSync(s.file),bytes=fs.readFileSync(s.file);fs.writeFileSync(s.file,bytes.toString().replace('Original result','Modified result'));fs.utimesSync(s.file,stat.atime,stat.mtime);
    assert.throws(()=>[...historySources(db,process.env.DRAKEN_PI_SESSIONS_DIR,cache)],/unavailable/);
    fs.writeFileSync(s.file,bytes);assert.deepEqual([...historySources(db,process.env.DRAKEN_PI_SESSIONS_DIR,cache)],before);assert.equal(calls,1);
    fs.unlinkSync(s.file);assert.throws(()=>[...historySources(db,process.env.DRAKEN_PI_SESSIONS_DIR,cache)],/unavailable/);
  }finally{normalize.normalizeEntry=original;}
});

test('search never serves stale derived text after a source changes; frozen pages and cached vectors survive the failure', async () => {
  const s = source([event('one', null, 'Original reported result')]); await scanSessions(); const frozen = store.startSync();
  const derived = cache(), index = new HistoryIndex(derived, db, model()); const result = await index.search({ question: 'result' });
  const vectors = derived.prepare('SELECT hash,hex(embedding) bytes FROM embedding_cache ORDER BY hash').all();
  fs.writeFileSync(s.file, fs.readFileSync(s.file, 'utf8').replace('Original', 'Modified'));
  assert.throws(() => index.read(result.results[0].ref), /unavailable/);
  await assert.rejects(index.search({ question: 'result' }), /unavailable/);
  assert.deepEqual(derived.prepare('SELECT hash,hex(embedding) bytes FROM embedding_cache ORDER BY hash').all(), vectors);
  assert.ok(store.getSync(frozen.id).items[0].unavailable); assert.equal(store.getSync(frozen.id).items[0].ref, frozen.items[0].ref);
});
