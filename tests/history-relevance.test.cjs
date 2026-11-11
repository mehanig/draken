// Synthetic projects and records; never reads a developer's real history.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { getDb, closeDb } = require('../dist/db/schema');
const { HistoryIndex } = require('../dist/memory/index');
const { indexReadiness } = require('../dist/memory/readiness');
const { historyQuery: voiceHistoryQuery } = require('../dist/memory/focus');
const { historyPacket } = require('../dist/memory/context');
const { sourceEntry } = require('./fixtures/source-entry.cjs');
let root, db, cache, index;
const cutoff = '2026-01-07T22:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-relevance-'));
  process.env.DRAKEN_DATA_DIR = path.join(root, 'state'); process.env.DRAKEN_PI_SESSIONS_DIR = path.join(root, 'sessions');
  db = getDb(); cache = new Database(':memory:');
  index = new HistoryIndex(cache, db, { fingerprint: 'relevance-fixture', ready: () => true, setup: async () => {},
    embed: async () => { const v = new Float32Array(384); v[0] = 1; return v; } });
});
afterEach(() => { cache.close(); closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
function entry(text, session = 'trailboard', timestamp = '2026-01-07T18:00:00.000Z', role = 'assistant') {
  return sourceEntry(db, process.env.DRAKEN_PI_SESSIONS_DIR, text, { session, timestamp, role,
    name: session === 'trailboard' ? 'Trailboard iOS rewrite' : 'Beacon indexing', cwd: '/projects/' + session });
}
function fixture() {
  entry('Safe upload retries: stable IDs and receipts prevent duplicate walks, GPS points and recording events. This is not image upload.', 'trailboard', '2026-01-05T19:00:00.000Z');
  entry('Historical subscription issue: missing functional Terms/EULA and Privacy Policy links. This is not a current candidate audit.', 'trailboard', '2026-01-05T20:00:00.000Z', 'toolResult');
  entry('Visual work: Home calendar, Profile, statistics, recorder and sharing. Journal and weight work remain. Full visual parity needs owner review.', 'trailboard', '2026-01-07T17:00:00.000Z');
  entry('Recording and sharing checkpoint reports 317 tests. Device acceptance and full visual parity are not established.', 'trailboard', '2026-01-07T19:00:00.000Z');
  entry('Now implementing Profile-first journal navigation. Categories get their own stack level. Back returns to Profile; old dismissal callbacks must not close a newer detail.', 'trailboard', '2026-01-07T21:00:00.000Z');
  entry('The journal integrated after the cutoff. This future record must not leak.', 'trailboard', '2026-01-07T23:00:00.000Z');
  entry('What are we uploading here? Images or what exactly?', 'beacon');
  entry('Upload safety in the search index transport.', 'beacon');
  const sync = Number(db.prepare("INSERT INTO syncs(created_at,status) VALUES(?,'completed')").run('2026-01-05T18:00:00.000Z').lastInsertRowid);
  for (const [role, text] of [['user', "Hello, can you check what's happening with iOS Trailboard rewrite"], ['assistant', 'I will check Trailboard. There is only a small SwiftUI foundation.'], ['user', 'So, have you checked']]) {
    db.prepare('INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES(?,?,?,?)').run(sync, role, text, '2026-01-05T19:00:00.000Z');
  }
}
test('project scope follows generic follow-ups, changes on an explicit switch, and still permits conversation recall', () => {
  fixture(); db.prepare("UPDATE agent_sessions SET name='Beacon indexing: upload safety, visual parity, screen tests and remaining blockers' WHERE id='beacon'").run(); let focus;
  for (const question of ["What's happening with iOS Trailboard rewrite?", 'So, have you checked', 'What is it working on at the moment?', 'What does it mean upload safety and missing links?', 'What are we uploading here? Images?', 'How is visual parity progressing?', 'Which screens match and what remains?', 'What is still blocked?']) {
    const plan = voiceHistoryQuery(db, question, focus); focus = plan.focus;
    assert.deepEqual(plan.query.session_ids, ['trailboard']); assert.equal(plan.query.kind, 'sources');
    if (question.includes('uploading here')) assert.deepEqual(plan.query.topics, ['upload safety', 'missing links']);
  }
  const next = voiceHistoryQuery(db, "What's happening with Beacon?", focus); assert.deepEqual(next.query.session_ids, ['beacon']);
  assert.deepEqual(new Set(voiceHistoryQuery(db, 'Compare Trailboard and Beacon.', next.focus).query.session_ids), new Set(['trailboard', 'beacon']));
  const recall = voiceHistoryQuery(db, 'What did we discuss in the previous call?', next.focus);
  assert.equal(recall.query.kind, 'conversation'); assert.equal(recall.query.session_ids, undefined);
  assert.deepEqual(voiceHistoryQuery(db, 'Switch to a different project.', next.focus).focus.sessions, []);
});
test('original project evidence and latest work displace identical old questions and acknowledgements', async () => {
  fixture(); await index.prepare({ before: cutoff });
  const plan = voiceHistoryQuery(db, "Hello, can you check what's happening with iOS Trailboard rewrite");
  const found = await index.search({ ...plan.query, before: cutoff }, undefined, true);
  assert.match(found.results[0].text, /Profile-first journal navigation/);
  assert.ok(found.results.every(record => record.session_id === 'trailboard' && record.at <= cutoff));
  assert.ok(!found.results.some(record => record.kind === 'discussion' || /only a small SwiftUI|future record must/.test(record.text)));
  const packet = historyPacket(found, 7000, 1200); assert.ok(Buffer.byteLength(packet.text) <= 7000);
  assert.match(packet.text, /old dismissal callbacks/);
  const follow = voiceHistoryQuery(db, 'What are we uploading here? Images or what exactly?', plan.focus);
  const upload = await index.search({ ...follow.query, before: cutoff }, undefined, true);
  assert.ok(upload.results.some(record => /GPS points and recording events/.test(record.text)));
  assert.ok(upload.results.every(record => record.session_id === 'trailboard'));
  const conversation = await index.search({ question: 'Trailboard', kind: 'conversation', before: cutoff }, undefined, true);
  assert.ok(conversation.results.some(record => record.kind === 'discussion'));
});
test('multi-topic questions include original definitions, not just recent incidental keyword matches', async () => {
  fixture(); entry('Missing relative document links: []\nUnrelated simulator progress.', 'trailboard', '2026-01-07T21:30:00.000Z', 'toolResult');
  await index.prepare({ before: cutoff });
  const prior = voiceHistoryQuery(db, 'Check Trailboard.').focus;
  const plan = voiceHistoryQuery(db, 'What does it mean upload safety and missing links?', prior);
  const found = await index.search({ ...plan.query, before: cutoff }, undefined, true);
  const packet = historyPacket(found, 7000, 1200);
  assert.match(packet.text, /GPS points and recording events/); assert.match(packet.text, /Terms\/EULA and Privacy Policy/);
  assert.ok(Buffer.byteLength(packet.text) <= 7000);
});
test('repeated passages cannot crowd distinct evidence out of top-k before ranking', async () => {
  for (let i = 0; i < 100; i++) entry('Upload safety checks have been requested. No outcome is recorded yet.');
  entry('Upload safety uses stable IDs for GPS coordinates and recording events. This is a distinct recorded explanation.');
  await index.prepare({ before: cutoff });
  const found = await index.search({ question: 'upload safety', session_ids: ['trailboard'], kind: 'sources', before: cutoff }, undefined, true);
  assert.ok(found.results.some(record => /GPS coordinates/.test(record.text)));
  assert.equal(found.results.filter(record => /checks have been requested/.test(record.text)).length, 1);
});
test('voice source excerpts keep the explanatory paragraph rather than cutting its middle in favor of tool commands', () => {
  const text = 'Recorded state. '.repeat(12) + 'Uploads contain GPS points and events; retries retain stable IDs.\nTool requested: read ' + 'x'.repeat(1000);
  const packet = historyPacket({ mode: 'hybrid', limitations: 'Synthetic source, not independently verified.', results: [
    { ref: 'H' + 'a'.repeat(24), kind: 'session', role: 'assistant', text, offset: 0, qualification: 'Agent report.', at: cutoff },
  ] }, 7000, 1200);
  assert.match(packet.text, /GPS points and events/); assert.doesNotMatch(packet.text, /Tool requested: read/);
  assert.match(packet.text, /tool requests omitted/);
});
test('explicit source requests support deeper prepared-only readback without corpus writes', async () => {
  entry('Earlier context. '.repeat(160) + 'GPS points and recording events are the payload.'); await index.prepare({ before: cutoff });
  const found = await index.search({ question: 'GPS points', before: cutoff }, undefined, true), ref = found.results[0].ref;
  const service = require('../dist/memory/service'), original = service.readHistory;
  const changes = cache.prepare('SELECT total_changes() n').get().n;
  service.readHistory = async (id, offset, _signal, before) => index.read(id, offset, before);
  try {
    const packet = await require('../dist/memory/context').historyContext(`${ref} offset 2000`, cutoff, undefined, 7000, true, { session_ids: ['trailboard'] });
    assert.equal(JSON.parse(packet.text).sources[0].offset, 2000); assert.match(packet.text, /GPS points and recording events/);
    assert.equal(cache.prepare('SELECT total_changes() n').get().n, changes);
  } finally { service.readHistory = original; }
});
test('a legacy or interrupted import cannot certify its indexed prefix; later appends do not invalidate a captured prefix', async () => {
  entry('A recorded checkpoint.'); db.prepare('UPDATE agent_sessions SET scanned_bytes=0').run();
  await assert.rejects(index.prepare(), /Finish importing/); assert.equal(indexReadiness(cache, db).ready, false);
  db.prepare('UPDATE agent_sessions SET scanned_bytes=byte_offset').run();
  await index.prepare(); assert.equal(indexReadiness(cache, db).ready, true);
  const file = db.prepare('SELECT path FROM agent_sessions').get().path;
  fs.appendFileSync(file, '{"type":"message","id":"still-writing');
  assert.equal(indexReadiness(cache, db).ready, true, 'captured history is not an unbounded live stream');
  fs.truncateSync(file, 10); assert.equal(indexReadiness(cache, db).ready, false);
});
