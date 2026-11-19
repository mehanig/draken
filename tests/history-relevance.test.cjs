// Synthetic projects and records; never reads a developer's real history.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { getDb, closeDb } = require('../dist/db/schema');
const { HistoryIndex } = require('../dist/memory/index');
const { indexReadiness } = require('../dist/memory/readiness');
const { prepareEvidence } = require('../dist/evidence');
const { historyPacket } = require('../dist/evidence/packet');
const { evidenceDependencies } = require('../dist/evidence-adapter');
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
async function planned(question, plan, previousQuestions = []) {
  let found, query;
  const packet = await prepareEvidence({ question, before: cutoff, signal: new AbortController().signal, previousQuestions,
    ask: async payload => JSON.stringify(payload.task === 'plan_evidence' ? plan : { scope: 'project', selected: payload.candidates.slice(0, 8).map(item => item.id) }) },
    { ...evidenceDependencies, search: async value => { query = value; return found = await index.search(value, undefined, true); },
      read: async (ref, offset, _signal, before) => index.read(ref, offset, before) });
  return { packet, found, query };
}
const trailPlan = (query, recent = true) => ({ scope: 'project', sessions: ['P2'], query, kind: 'sources', recent });

test('a casual status question receives recent originals even when older lexical/vector matches fill their top-k lists', async () => {
  for (let i=0;i<100;i++) entry(`Draken startup proposal ${i}; implementation not yet done.`, 'draken');
  entry('Settings page installed and browser checked. Existing data preserved.', 'draken', '2026-01-07T21:59:00.000Z', 'toolResult');
  entry('Future failed deployment.', 'draken', '2026-01-08T00:00:00.000Z');
  await index.prepare({ before: cutoff });
  const { packet, found, query } = await planned('Whatsup currently woth draken?', { scope: 'project', sessions: ['P1'], query: 'Draken latest state', kind: 'sources', recent: true });
  assert.equal(query.recent, true); assert.ok(found.results.length <= 64);
  assert.match(packet.text, /Settings page installed and browser checked/); assert.doesNotMatch(packet.text, /Future failed deployment/);
});
test('source permission revoked during model planning is checked before prepared search and original reads', async () => {
  fixture(); await index.prepare({ before: cutoff }); const changes = cache.prepare('SELECT total_changes() n').get().n;
  const packet = await prepareEvidence({ question: 'Trailboard status?', before: cutoff, signal: new AbortController().signal,
    ask: async payload => {
      if (payload.task === 'plan_evidence') { db.prepare("UPDATE agent_sessions SET included=0 WHERE id='trailboard'").run(); return JSON.stringify(trailPlan('Trailboard current work')); }
      assert.deepEqual(payload.candidates, []); return '{"scope":"project","selected":[]}';
    } }, { ...evidenceDependencies, search: query => index.search(query, undefined, true), read: async () => assert.fail('Revoked source was read') });
  assert.deepEqual(packet.refs, []); assert.equal(cache.prepare('SELECT total_changes() n').get().n, changes);
});

test('project candidates include recent work and exclude other projects, discussions and future records', async () => {
  fixture(); await index.prepare({ before: cutoff });
  const { found } = await planned("Hello, can you check what's happening with iOS Trailboard rewrite", trailPlan('Trailboard current work'));
  assert.ok(found.results.some(item => /Profile-first journal navigation/.test(item.text)));
  assert.ok(found.results.every(record => record.session_id === 'trailboard' && record.at <= cutoff));
  assert.ok(!found.results.some(record => record.kind === 'discussion' || /only a small SwiftUI|future record must/.test(record.text)));
  const packet = historyPacket(found, evidenceDependencies.cleanText, 7000, 1200); assert.ok(Buffer.byteLength(packet.text) <= 7000);
  assert.match(packet.text, /old dismissal callbacks/);
  const { found: upload } = await planned('What are we uploading here? Images or what exactly?', trailPlan('Trailboard upload payload'), ['Tell me about Trailboard']);
  assert.ok(upload.results.some(record => /GPS points and recording events/.test(record.text)));
  assert.ok(upload.results.every(record => record.session_id === 'trailboard'));
  const conversation = await index.search({ question: 'Trailboard', kind: 'conversation', before: cutoff }, undefined, true);
  assert.ok(conversation.results.some(record => record.kind === 'discussion'));
});
test('multi-topic questions include original definitions, not just recent incidental keyword matches', async () => {
  fixture(); entry('Missing relative document links: []\nUnrelated simulator progress.', 'trailboard', '2026-01-07T21:30:00.000Z', 'toolResult');
  await index.prepare({ before: cutoff });
  const { found } = await planned('What does it mean upload safety and missing links?', trailPlan('upload safety missing links', false), ['Check Trailboard.']);
  const packet = historyPacket(found, evidenceDependencies.cleanText, 7000, 1200);
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
test('source excerpts keep explanatory text, command context and closing qualifications', () => {
  const text = 'Recorded state. '.repeat(12) + 'Uploads contain GPS points and events; retries retain stable IDs.\nTool requested: read ' + 'x'.repeat(1000) + '\nDevice acceptance has NOT been performed.';
  const packet = historyPacket({ mode: 'hybrid', limitations: 'Synthetic source, not independently verified.', results: [
    { ref: 'H' + 'a'.repeat(24), kind: 'session', role: 'assistant', text, offset: 0, qualification: 'Agent report.', at: cutoff },
  ] }, evidenceDependencies.cleanText, 7000, 1200);
  assert.match(packet.text, /GPS points and events/); assert.match(packet.text, /Tool requested: read/);
  assert.match(packet.text, /Device acceptance has NOT been performed/);
});
test('explicit source requests support deeper prepared-only readback without corpus writes', async () => {
  entry('Earlier context. '.repeat(160) + 'GPS points and recording events are the payload.'); await index.prepare({ before: cutoff });
  const found = await index.search({ question: 'GPS points', before: cutoff }, undefined, true), ref = found.results[0].ref;
  const service = require('../dist/memory/service'), original = service.readHistory, search = service.searchPreparedHistory;
  const changes = cache.prepare('SELECT total_changes() n').get().n;
  service.readHistory = async (id, offset, _signal, before) => index.read(id, offset, before);
  service.searchPreparedHistory = async query => index.search(query, undefined, true);
  try {
    const packet = await require('../dist/evidence').prepareEvidence({ question: `${ref} offset 2000`, before: cutoff,
      signal: new AbortController().signal, scope: { session_ids: ['trailboard'] },
      ask: async payload => payload.task === 'plan_evidence' ? JSON.stringify({ scope: 'project', sessions: [], query: 'original context', kind: 'sources', recent: false }) : '{"scope":"project","selected":["S1"]}' }, evidenceDependencies);
    assert.equal(JSON.parse(packet.text).sources[0].offset, 2000); assert.match(packet.text, /GPS points and recording events/);
    assert.equal(cache.prepare('SELECT total_changes() n').get().n, changes);
  } finally { service.readHistory = original; service.searchPreparedHistory = search; }
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
