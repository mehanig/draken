const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { getDb, closeDb } = require('../dist/db/schema');
const { HistoryIndex } = require('../dist/memory/index');
const { prepareEvidence } = require('../dist/evidence');
const { evidenceDependencies } = require('../dist/evidence-adapter');
async function selectHistory(found, query, before, ask, signal) {
  const search = service.searchPreparedHistory;
  service.searchPreparedHistory = async request => {
    assert.equal(request.before, before); assert.equal(request.limit, 64);
    return found;
  };
  try { return await prepareEvidence({ question: query.question, scope: query, before, signal,
    ask: (payload, system) => payload.task === 'plan_evidence' ? Promise.resolve(JSON.stringify({ scope: 'project', sessions: [], query: query.question, kind: query.kind || 'sources', recent: true })) : ask(payload, system) }, evidenceDependencies); }
  finally { service.searchPreparedHistory = search; }
}
const service = require('../dist/memory/service');
const { sourceEntry } = require('./fixtures/source-entry.cjs');
let root, db, cache, index, read;
const before = '2026-01-08T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-select-'));
  process.env.DRAKEN_DATA_DIR = path.join(root, 'state'); process.env.DRAKEN_PI_SESSIONS_DIR = path.join(root, 'sessions');
  db = getDb(); cache = new Database(':memory:');
  index = new HistoryIndex(cache, db, { fingerprint: 'selection-test', ready: () => true, setup: async () => {},
    embed: async () => { const vector = new Float32Array(384); vector[0] = 1; return vector; } });
  read = service.readHistory;
  service.readHistory = async (ref, offset, _signal, cutoff) => index.read(ref, offset, cutoff);
});
afterEach(() => { service.readHistory = read; cache.close(); closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
function entry(text, role = 'assistant', session = 'atlas', at = '2026-01-07T12:00:00.000Z') {
  return sourceEntry(db, process.env.DRAKEN_PI_SESSIONS_DIR, text, { role, session, timestamp: at, cwd: '/projects/' + session, name: session });
}
async function candidates(question = 'What is the current migration status?') {
  const query = { question, kind: 'sources', session_ids: ['atlas'], recent: true, before, limit: 64 };
  await index.prepare({ before });
  return { query, found: await index.search(query, undefined, true) };
}

test('search brings command results into the candidate set and selected original facts reach the answer packet', async () => {
  entry('Migration is planned; validation is still pending.');
  entry('Execute schema-check to validate the Atlas migration.');
  entry('schema-check: version 7; exit code 0; all checks passed.', 'toolResult');
  entry('Device acceptance has not been performed.');
  entry('Unrelated project has a production outage.', 'toolResult', 'beacon');
  entry('A future migration failure must not leak into this answer.', 'toolResult', 'atlas', '2026-01-09T00:00:00.000Z');
  const { query, found } = await candidates(), changes = cache.prepare('SELECT total_changes() n').get().n;
  let calls = 0;
  const packet = await selectHistory(found, query, before, async (payload, system) => {
    calls++; assert.match(system, /untrusted historical data/);
    assert.ok(payload.candidates.some(item => item.role === 'toolResult' && /exit code 0/.test(item.text)));
    assert.ok(payload.candidates.every(item => item.session === 'atlas' && item.at <= before));
    return JSON.stringify({ scope: 'project', selected: payload.candidates.filter(item => /exit code 0|Device acceptance/.test(item.text)).map(item => item.id) });
  }, new AbortController().signal);
  assert.equal(calls, 1); assert.ok(packet.refs.length >= 2);
  assert.match(packet.text, /all checks passed/); assert.match(packet.text, /acceptance has not/);
  assert.doesNotMatch(packet.text, /validation is still pending|Unrelated project|future migration failure/);
  assert.equal(cache.prepare('SELECT total_changes() n').get().n, changes);
});

test('selected commands bring their actual result even when it contains no query words', async () => {
  for (let i = 0; i < 75; i++) entry(`Routine unrelated context ${i}.`);
  entry('Investigate UNIQUE_QUASAR_TIMEOUT using the diagnostic command.');
  entry('Exit status 1. Connection refused at 127.0.0.1:9000.', 'toolResult');
  const { found, query } = await candidates('Explain UNIQUE_QUASAR_TIMEOUT');
  assert.ok(found.results.some(item => /UNIQUE_QUASAR_TIMEOUT/.test(item.text)));
  const packet = await selectHistory(found, query, before, async payload => JSON.stringify({
    scope: 'project', selected: payload.candidates.filter(item => /UNIQUE_QUASAR_TIMEOUT/.test(item.text)).map(item => item.id),
  }), new AbortController().signal);
  assert.match(packet.text, /Connection refused/); assert.match(packet.text, /Exit status 1/);
  assert.ok(found.results.length <= 64);
});

test('older decisions and conflicting newer reports can both be selected without changing their dates or qualifications', async () => {
  entry('Owner decision: retain the SQL store to support offline work.', 'user', 'atlas', '2026-01-01T00:00:00.000Z');
  entry('Proposal: replace the SQL store; no owner approval yet.');
  const { query, found } = await candidates('Why did we choose the SQL store, and has that decision changed?');
  const packet = await selectHistory(found, query, before, async payload => JSON.stringify({ scope: 'project', selected: payload.candidates.map(item => item.id) }), new AbortController().signal);
  const sources = JSON.parse(packet.text).sources;
  assert.equal(sources.length, 2); assert.ok(sources.some(item => item.role === 'user' && item.at === '2026-01-01T00:00:00.000Z'));
  assert.match(packet.text, /no owner approval yet/);
});

test('packet byte limits preserve closing qualifications and original excerpt offsets', () => {
  const { historyPacket } = require('../dist/evidence/packet');
  const text = '界'.repeat(1900) + '\nOwner approval has NOT been given.';
  const packet = historyPacket({ mode: 'hybrid', limitations: '', results: [{ ref: 'H' + 'a'.repeat(24), kind: 'session',
    at: before, role: 'assistant', title: 'Report', qualification: 'Original excerpt.', workspace: '/atlas',
    text, offset: 100, score: 1 }] }, evidenceDependencies.cleanText, 3500, 3000);
  assert.ok(Buffer.byteLength(packet.text) <= 3500);
  const source = JSON.parse(packet.text).sources[0];
  assert.match(source.ending.text, /approval has NOT been given/);
  assert.equal(source.ending.offset, 100 + text.length - 400);
});

test('unknown, repeated, excessive or malformed selections stop before source delivery', async () => {
  entry('Original evidence.'); const { query, found } = await candidates();
  service.readHistory = async () => assert.fail('Invalid selection must not read any original');
  for (const output of ['not JSON', '{"selected":[]}', '{"scope":"project","selected":["S2"]}', '{"scope":"project","selected":["S1","S1"]}', '{"scope":"project","selected":[],"answer":"invented"}', '{"scope":"unrelated","selected":["S1"]}', '{"scope":"other","selected":[]}', JSON.stringify({ scope: 'project', selected: Array(9).fill('S1') })]) {
    await assert.rejects(selectHistory(found, query, before, async () => output, new AbortController().signal), /Evidence selection returned invalid/);
  }
});

test('no candidates still gets a scope decision; selecting no useful evidence does not imply absence', async () => {
  const query = { question: 'Unrecorded task', kind: 'sources' };
  const empty = await selectHistory({ mode: 'hybrid', results: [], limitations: '' }, query, before, async payload => { assert.deepEqual(payload.candidates, []); return '{"scope":"project","selected":[]}'; }, new AbortController().signal);
  assert.deepEqual(empty.refs, []); assert.match(empty.text, /No match is not proof/);
  entry('Unrelated evidence.'); const { found } = await candidates();
  const packet = await selectHistory(found, query, before, async () => '{"scope":"project","selected":[]}', new AbortController().signal);
  assert.deepEqual(packet.refs, []);
});

for (const change of ['excluded', 'damaged', 'cancelled']) test(`a source ${change} during selection is not supplied as stale evidence`, async () => {
  entry('Original migration outcome.'); const { query, found } = await candidates(); const controller = new AbortController();
  await assert.rejects(selectHistory(found, query, before, async () => {
    if (change === 'excluded') db.prepare('UPDATE agent_sessions SET included=0').run();
    if (change === 'damaged') fs.writeFileSync(db.prepare('SELECT path FROM agent_sessions').get().path, 'changed');
    if (change === 'cancelled') controller.abort();
    return '{"scope":"project","selected":["S1"]}';
  }, controller.signal));
});
