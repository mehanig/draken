const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { getDb, closeDb } = require('../dist/db/schema');
const { EvidenceReader } = require('../dist/db/evidence');
const { EntryReader } = require('../dist/sync/source-files');
const { sourceKey } = require('../dist/sync/normalize');
const { sourceEntry, editEntry, frozenEvidence } = require('./fixtures/source-entry.cjs');
const store = require('../dist/sync/store');
const manager = require('../dist/sync/manager');
const pi = require('../dist/sync/pi');
const live = require('../dist/voice/live');
const at = '2026-01-01T00:00:00.000Z';
let root, directory, db, environment, invokePi, providerCalls;
beforeEach(() => {
  closeDb(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-evidence-boundary-'));
  directory = path.join(root, 'sessions');
  const settings = { DRAKEN_DATA_DIR: root, DRAKEN_PI_SESSIONS_DIR: directory, DRAKEN_VOICE_MODE: 'native',
    DRAKEN_CODEX_HOME: path.join(root, 'unused-account'), DRAKEN_CODEX_BIN: path.join(root, 'unused-helper') };
  environment = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  db = getDb(); providerCalls = 0; invokePi = pi.invokePi;
  pi.invokePi = async () => { providerCalls++; throw Error('No provider may run in an evidence-boundary test'); };
});
afterEach(() => {
  pi.invokePi = invokePi; closeDb(); fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
function snapshot() {
  return Number(db.prepare('INSERT INTO syncs(created_at,snapshot_at,snapshot_version,briefing,compression_complete) VALUES (?,?,2,?,1)')
    .run(at, at, 'Historical briefing remains accessible.').lastInsertRowid);
}
function insert(syncId, encoded) {
  db.prepare('INSERT INTO sync_items(sync_id,event_key,evidence_json) VALUES (?,?,?)').run(syncId, encoded.event_key, JSON.stringify(encoded));
}

for (const location of ['items', 'context']) {
  test(`inline-only current-schema ${location} are unavailable, not migration input`, async () => {
    assert.equal(db.prepare("SELECT value FROM sync_settings WHERE key='storage_schema'").get().value, 'pointer-v2');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='retained_text'").get().n, 0);
    const syncId = snapshot(), text = 'Synthetic original result; deployment remains unverified.';
    const frozen = frozenEvidence(db, directory, text, { ref: location === 'items' ? 'E1' : 'C1', timestamp: at });
    const { source_pointer, ...metadata } = frozen;
    assert.ok(source_pointer);
    // Even matching inline text with an existing original is not a live pointer.
    const inline = { ...metadata, text }, encoded = JSON.stringify(inline);
    const reader = new EvidenceReader(db);
    try {
      assert.equal(reader.read(frozen).text, text);
      for (const value of [inline, encoded]) {
        assert.throws(() => reader.read(value), /Original session evidence is unavailable/);
        const unavailable = reader.read(value, true);
        assert.equal(unavailable.text, '');
        assert.match(unavailable.unavailable, /Original session evidence is unavailable/);
        assert.equal(unavailable.ref, frozen.ref); assert.equal(unavailable.session_id, frozen.session_id);
        assert.equal(unavailable.role, frozen.role); assert.equal(unavailable.sequence, frozen.sequence);
        assert.equal(sourceKey(unavailable), frozen.source_key);
      }
    } finally { reader.close(); }
    assert.equal(JSON.stringify(inline), encoded, 'reading must not rewrite persisted input');
    if (location === 'items') insert(syncId, inline);
    else {
      insert(syncId, frozenEvidence(db, directory, 'Verified primary evidence.', { ref: 'E1', timestamp: at }));
      db.prepare('UPDATE syncs SET context_json=? WHERE id=?').run(JSON.stringify([inline]), syncId);
    }
    db.prepare('INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES (?,?,?,?)').run(syncId, 'user', 'Retain this conversation.', at);
    const sync = store.getSync(syncId);
    assert.equal(sync[location][0].text, ''); assert.ok(sync[location][0].unavailable);
    assert.equal(sync.messages[0].content, 'Retain this conversation.');
    assert.equal(sync.briefing, 'Historical briefing remains accessible.');
    assert.throws(() => store.assertEvidenceAvailable(sync), /Original session evidence/);
    assert.throws(() => manager.launchReply(syncId, 'Explain'), /Original session evidence/);
    await assert.rejects(manager.generateReply(syncId, 'Explain'), /Original session evidence/);
    await assert.rejects(live.createLiveCall(syncId, new AbortController().signal), /Original session evidence/);
    assert.throws(() => store.completeSync(syncId, 'Do not save this', '', true), /Original session evidence/);
    assert.equal(providerCalls, 0);
    for (const table of ['sync_runs', 'live_calls', 'summary_cache', 'sync_coverage']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
    }
    assert.equal(store.getSync(syncId).status, 'open'); assert.equal(store.getSync(syncId).busy, false);
    assert.equal(store.getSync(syncId).decisions, '');
    const saved = store.saveNotes(syncId, 'Explicit note remains editable.', 'Still unresolved.');
    assert.equal(saved.decisions, 'Explicit note remains editable.'); assert.equal(saved.messages[0].content, 'Retain this conversation.');
    const persisted = location === 'items'
      ? db.prepare('SELECT evidence_json value FROM sync_items WHERE sync_id=?').get(syncId).value
      : JSON.stringify(JSON.parse(db.prepare('SELECT context_json FROM syncs WHERE id=?').get(syncId).context_json)[0]);
    assert.equal(persisted, encoded, 'guards and notes do not silently migrate invalid current evidence');
  });
}

test('a verified edit cannot substitute for a missing original-record pointer', () => {
  const id = sourceEntry(db, directory, 'Original attribution.', { timestamp: at });
  editEntry(db, directory, id, 'Corrected statement; deployment unverified.');
  const read = () => {
    const reader = new EntryReader(db);
    try { return reader.effective(id); } finally { reader.close(); }
  };
  assert.equal(read(), 'Corrected statement; deployment unverified.');
  const original = db.prepare('SELECT record_hash FROM agent_entries WHERE id=?').get(id).record_hash;
  db.prepare('UPDATE agent_entries SET record_hash=NULL WHERE id=?').run(id);
  assert.throws(read, /Original session evidence is unavailable/);
  db.prepare('UPDATE agent_entries SET record_hash=? WHERE id=?').run(original, id);
  assert.equal(read(), 'Corrected statement; deployment unverified.');
});

test('citation-heavy voice fixtures persist pointers and depend on their synthetic originals', () => {
  const syncId = snapshot(), refs = require('./fixtures/voice-sources.cjs')(db, syncId);
  const sync = store.getSync(syncId);
  assert.equal(refs.length, 37); assert.deepEqual(sync.items.map(item => item.ref), refs);
  assert.ok(sync.items.every(item => !item.unavailable && item.role === 'toolResult' && /Deployment remains unverified/.test(item.text)));
  for (const row of db.prepare('SELECT evidence_json FROM sync_items WHERE sync_id=?').all(syncId)) {
    const encoded = JSON.parse(row.evidence_json);
    assert.ok(encoded.source_pointer); assert.ok(encoded.source_key); assert.equal(Object.hasOwn(encoded, 'text'), false);
  }
  fs.unlinkSync(sync.items[0].source_path);
  const missing = store.getSync(syncId);
  assert.ok(missing.items.every(item => item.unavailable && item.text === ''));
  assert.deepEqual(missing.items.map(item => item.ref), refs);
  assert.throws(() => store.assertEvidenceAvailable(missing), /Original session evidence/);
});
