const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Database = require('better-sqlite3');
const { getDb, closeDb } = require('../dist/db/schema');
const { sourceEntry } = require('./fixtures/source-entry.cjs');
const { capturePilot, readPilotBatch, listPilotSessions } = require('../dist/workflow-pilot/evidence-host');
const { initPilotStore, createPilot, runPilot, loadPilot, recoverPilotStore } = require('../dist/workflow-pilot/backfill');
const { prepareProcedureEvidence } = require('../dist/evidence');
const { validateExtraction, extractProcedures } = require('../dist/workflow-learning');
let root, db, store, prior;
const before = '2026-11-19T00:00:00.000Z', timestamp = '2026-11-18T00:00:00.000Z';
const signal = () => new AbortController().signal;
function output(ref) {
  return { episodes: [{ objective: 'Inspect a local change', refs: [ref], steps: [{ action: 'Request inspection', outcome: 'No result established', basis: 'requested', refs: [ref] }],
    prerequisites: [], corrections: [], candidate: { name: 'Local inspection', appliesWhen: 'A local result is requested', notEstablished: 'No repeatability or completion established' }, questions: ['What was inspected?'] }], limitations: ['One partial example'] };
}
function seed(n = 2) {
  for (let i = 0; i < n; i++) sourceEntry(db, path.join(root, 'sessions'), `Please inspect local change ${i}. Deployment remains unverified.`, { timestamp, role: 'user' });
  return capturePilot(db, 'session-a', n, before);
}
function model(counter, mutate) {
  return async (prompt, request) => {
    counter.calls++; const packet = JSON.parse(prompt).evidence;
    request.onAccounting({ input: 10, output: 20 });
    if (mutate) await mutate(packet, request);
    return JSON.stringify(output(packet.records[0].ref));
  };
}
beforeEach(() => {
  closeDb(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-workflow-pilot-'));
  prior = { DRAKEN_DATA_DIR: process.env.DRAKEN_DATA_DIR, DRAKEN_PI_SESSIONS_DIR: process.env.DRAKEN_PI_SESSIONS_DIR };
  Object.assign(process.env, { DRAKEN_DATA_DIR: root, DRAKEN_PI_SESSIONS_DIR: path.join(root, 'sessions') });
  db = getDb(); store = new Database(path.join(root, 'pilot.sqlite')); store.pragma('foreign_keys = ON'); initPilotStore(store);
});
afterEach(() => {
  store.close(); closeDb(); fs.rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('capture is metadata-only; listing does not require readable original bytes', () => {
  const captured = seed(); fs.unlinkSync(path.join(root, 'sessions/session-a.jsonl'));
  assert.equal(listPilotSessions(db).length, 1);
  assert.deepEqual(capturePilot(db, 'session-a', 2, before), captured);
  assert.ok(!JSON.stringify(captured).includes('Please inspect'));
  assert.throws(() => capturePilot(db, 'session-a', 25, before), /24 records/);
});

test('original-backed packet clips transparently and never selects another session', async () => {
  seed();
  const controller = new AbortController();
  const dependencies = { cleanText: text => text, read: async ref => ({ ref, sessionId: 's', sequence: 1, at: timestamp, role: 'toolResult', text: 'a'.repeat(7000) + 'NOT VERIFIED' }) };
  const packet = await prepareProcedureEvidence({ sessionId: 's', before, refs: ['one'], signal: controller.signal }, dependencies);
  assert.equal(packet.records[0].clipped, true); assert.match(packet.records[0].text, /NOT VERIFIED$/);
  assert.match(packet.limitations.join(' '), /middle/);
  await assert.rejects(prepareProcedureEvidence({ sessionId: 'other', before, refs: ['one'], signal: signal() }, dependencies), /scope|session/);
  controller.abort(); await assert.rejects(prepareProcedureEvidence({ sessionId: 's', before, refs: ['one'], signal: controller.signal }, dependencies));
});

test('complete extraction resumes without another call; source tables remain unchanged', async () => {
  const capture = seed(10), counter = { calls: 0 }, job = createPilot(store, db.name, capture, 'fake/model');
  const tables = ['summary_cache','summary_leaf_inputs','sync_coverage','sync_runs','sync_items','agent_entries'];
  const counts = () => tables.map(t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
  const priorCounts = counts();
  const report = await runPilot(db, store, job, model(counter), signal());
  assert.match(report, /Local inspection/); assert.match(report, /10 tail records/); assert.equal(counter.calls, 2);
  await runPilot(db, store, loadPilot(store, job.id), model(counter), signal());
  const repeated = createPilot(store, db.name, { ...capture, before: '2026-11-20T00:00:00.000Z' }, 'fake/model');
  assert.equal(repeated.id, job.id); assert.equal(repeated.capture.before, before);
  await runPilot(db, store, repeated, model(counter), signal());
  assert.equal(counter.calls, 2); assert.equal(loadPilot(store, job.id).calls, 2);
  assert.deepEqual(counts(), priorCounts);
  assert.equal(store.prepare('SELECT COUNT(*) n FROM workflow_pilot_artifacts').get().n, 2);
});

for (const change of ['excluded', 'disabled', 'window', 'baseline', 'bytes', 'inactive', 'missing']) {
  test(`cached extraction cannot bypass changed source: ${change}`, async () => {
    const capture = seed(), counter = { calls: 0 }, job = createPilot(store, db.name, capture, 'fake/model');
    await runPilot(db, store, job, model(counter), signal());
    if (change === 'excluded') db.prepare('UPDATE agent_sessions SET included=0').run();
    if (change === 'disabled') db.prepare('UPDATE agent_sources SET enabled=0').run();
    if (change === 'window') db.prepare("UPDATE sync_settings SET value='1' WHERE key='activity_days'").run();
    if (change === 'baseline') db.prepare("INSERT OR REPLACE INTO sync_settings(key,value) VALUES('history_since','2099-01-01')").run();
    if (change === 'bytes') { const file = path.join(root, 'sessions/session-a.jsonl'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Please inspect', 'Please destroy')); }
    if (change === 'inactive') db.prepare('UPDATE agent_entries SET active=0').run();
    if (change === 'missing') fs.unlinkSync(path.join(root, 'sessions/session-a.jsonl'));
    await assert.rejects(runPilot(db, store, loadPilot(store, job.id), model(counter), signal()));
    assert.equal(counter.calls, 1);
  });
}

test('revocation of an uncited original after inference rejects the artifact', async () => {
  const capture = seed(), counter = { calls: 0 }, job = createPilot(store, db.name, capture, 'fake/model');
  await assert.rejects(runPilot(db, store, job, model(counter, () => db.prepare('UPDATE agent_entries SET active=0 WHERE id=?').run(capture.originals[1].id)), signal()), /available/);
  assert.equal(counter.calls, 1); assert.equal(store.prepare('SELECT COUNT(*) n FROM workflow_pilot_artifacts').get().n, 0);
});

test('invalid output consumes its attempt; explicit retry does not reset the total limit', async () => {
  const capture = seed(), job = createPilot(store, db.name, capture, 'fake/model'); let calls = 0;
  const bad = async () => { calls++; return JSON.stringify(output('not-supplied')); };
  await assert.rejects(runPilot(db, store, job, bad, signal()), /unavailable originals/);
  await assert.rejects(runPilot(db, store, loadPilot(store, job.id), bad, signal()), /--retry/);
  assert.equal(calls, 1);
  for (let i = 0; i < 2; i++) await assert.rejects(runPilot(db, store, loadPilot(store, job.id), bad, signal(), true), /unavailable originals/);
  await assert.rejects(runPilot(db, store, loadPilot(store, job.id), bad, signal(), true), /three paid/);
  assert.equal(calls, 3); assert.equal(loadPilot(store, job.id).calls, 3);
});

test('cancellation saves no artifact and preserves spent usage', async () => {
  const capture = seed(), job = createPilot(store, db.name, capture, 'fake/model'), counter = { calls: 0 }, controller = new AbortController();
  await assert.rejects(runPilot(db, store, job, model(counter, () => controller.abort()), controller.signal));
  assert.equal(loadPilot(store, job.id).calls, 1); assert.equal(loadPilot(store, job.id).status, 'cancelled');
  assert.equal(store.prepare('SELECT COUNT(*) n FROM workflow_pilot_artifacts').get().n, 0);
  assert.notEqual(store.prepare('SELECT usage_json FROM workflow_pilot_attempts').get().usage_json, null);
});

test('completed first batch survives a later failure and explicit retry', async () => {
  const capture = seed(9), job = createPilot(store, db.name, capture, 'fake/model'), counter = { calls: 0 };
  const ask = model(counter, () => { if (counter.calls === 2) throw Error('transport failed'); });
  await assert.rejects(runPilot(db, store, job, ask, signal()), /transport failed/);
  assert.equal(store.prepare('SELECT COUNT(*) n FROM workflow_pilot_artifacts').get().n, 1);
  await runPilot(db, store, loadPilot(store, job.id), model(counter), signal(), true);
  assert.equal(counter.calls, 3); assert.equal(loadPilot(store, job.id).status, 'completed');
});

test('restart records unknown interrupted attempts; never resets paid counts', () => {
  const capture = seed(), job = createPilot(store, db.name, capture, 'fake/model');
  store.prepare("UPDATE workflow_pilot_jobs SET status='running',calls=1 WHERE id=?").run(job.id);
  store.prepare("INSERT INTO workflow_pilot_attempts(job_id,batch_key,status,started_at) VALUES (?,?,'running',?)").run(job.id, 'key', timestamp);
  recoverPilotStore(store);
  assert.equal(loadPilot(store, job.id).calls, 1); assert.equal(loadPilot(store, job.id).status, 'interrupted');
  assert.equal(store.prepare('SELECT status FROM workflow_pilot_attempts').get().status, 'interrupted');
});

test('learning validates strict schema, references and outcome labels without predetermined categories', async () => {
  const valid = output('R1'); assert.deepEqual(validateExtraction(JSON.stringify(valid), ['R1']), valid);
  for (const edit of [v => v.episodes[0].steps[0].basis = 'success', v => v.episodes[0].steps[0].basis = ['observed'], v => v.categories = ['web'], v => v.episodes[0].refs = [], v => v.episodes[0].candidate = null]) {
    const value = structuredClone(valid); edit(value); assert.throws(() => validateExtraction(JSON.stringify(value), ['R1']));
  }
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(extractProcedures({ records: [{ ref: 'R1' }] }, async () => { calls++; return JSON.stringify(valid); }, controller.signal)); assert.equal(calls, 0);
});
