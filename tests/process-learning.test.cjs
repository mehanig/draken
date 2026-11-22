const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { getDb, closeDb } = require('../dist/db/schema');
const { initProcessSchema } = require('../dist/db/process-schema');
const { sourceEntry } = require('./fixtures/source-entry.cjs');
const { capturePilot } = require('../dist/workflow-pilot/evidence-host');
const { summarizeProcessSample, compareProcessSamples } = require('../dist/workflow-pilot/process');
const { validateProcess, validateProcessMatch, processMatchInput } = require('../dist/workflow-learning');
let dir, db, store, prior;
const before = '2026-11-19T00:00:00.000Z';
const signal = () => new AbortController().signal;
function value(ref, tool = 'bash') {
  return { summary: 'Release inspection requested, not verified.', fragments: [{ key: 'release', goal: 'Inspect PR 52 for version 0.9.3', context: 'A requested release inspection', state: 'partial', refs: [ref],
    coverage: { triggerRefs: [ref], outcomeRefs: [], gaps: ['Outcome missing'] },
    stages: [{ key: 'inspect', action: 'Inspect release', normalizedAction: 'Inspect readiness', role: 'main', condition: null, claims: [{ description: 'Inspection requested', basis: 'requested', refs: [ref] }], refs: [ref], tools: [{ name: tool, usage: 'Inspect release', refs: [ref] }], skills: [] }],
    dependencies: [], decisions: [{ description: 'User requests inspection, not publication', basis: 'requested', refs: [ref] }], exceptions: [], questions: ['Did it pass?'],
    matching: { goal: 'Inspect a release', context: 'Before publication' } }], limitations: ['Partial sample'] };
}
function match() { return { relation: 'shared_subprocedure', reason: 'Both inspect before publication; tools are secondary.', sharedStages: [{ left: 'S1', right: 'S1', description: 'Inspect readiness' }], importantDifferences: [], toolSkillDifferences: ['Different inspection tools'], missingEvidence: ['No publication outcome'] }; }
function seed(text = 'Please inspect PR 52 with bash; do not publish.') {
  sourceEntry(db, path.join(dir, 'sessions'), text, { timestamp: '2026-11-18T00:00:00.000Z', role: 'user' });
  return capturePilot(db, 'session-a', 1, before);
}
function ask(counter, mutate) { return async (raw, request) => {
  counter.n++; const payload = JSON.parse(raw); request.onAccounting({ input: 1, output: 2 });
  if (mutate) await mutate(payload);
  return JSON.stringify(payload.task === 'compare_processes' ? match() : value(payload.records[0].ref));
}; }
beforeEach(() => {
  closeDb(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-learning-'));
  prior = { DRAKEN_DATA_DIR: process.env.DRAKEN_DATA_DIR, DRAKEN_PI_SESSIONS_DIR: process.env.DRAKEN_PI_SESSIONS_DIR };
  Object.assign(process.env, { DRAKEN_DATA_DIR: dir, DRAKEN_PI_SESSIONS_DIR: path.join(dir, 'sessions') });
  db = getDb(); store = new Database(path.join(dir, 'process.sqlite')); store.pragma('foreign_keys = ON'); initProcessSchema(store);
});
afterEach(() => {
  store.close(); closeDb(); fs.rmSync(dir, { recursive: true, force: true });
  for (const [k,v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('additive migration creates process and saved-enrichment tables and is repeatable', () => {
  initProcessSchema(store);
  assert.deepEqual(store.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(x => x.name), ['episode_extractions', 'episode_memberships', 'episode_reconstructions', 'episode_revisions', 'process_extractions', 'work_episodes', 'workflow_discoveries', 'workflow_enrichments', 'workflow_requests']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='process_extractions'").get().n, 1);
  assert.equal(store.pragma('foreign_key_check').length, 0);
});

test('strict process schema validates tool/skill references and preserves empty skill uncertainty', () => {
  const v = value('R1'); assert.deepEqual(validateProcess(JSON.stringify(v), ['R1']), v);
  for (const change of [x => x.fragments[0].stages[0].tools[0].refs = ['unknown'], x => x.fragments[0].stages[0].skills = [{name:'invented',usage:'Used',refs:[]}], x => x.fragments[0].state = ['completed'], x => x.fragments[0].stages[0].claims[0].basis = 'success', x => x.fragments.push(x.fragments[0]), x => x.extra = true]) {
    const bad = structuredClone(v); change(bad); assert.throws(() => validateProcess(JSON.stringify(bad), ['R1']));
  }
  assert.throws(() => validateProcess(JSON.stringify({summary:'Nothing',fragments:[],limitations:[]}), []));
  assert.throws(() => validateProcessMatch(JSON.stringify({...match(),relation:'identical'}), [processMatchInput(v.fragments[0]),processMatchInput(v.fragments[0])]));
});

test('matching primary excludes instance identifiers, state, questions and tool names', () => {
  const a = value('R1').fragments[0], b = value('R99', 'different-tool').fragments[0];
  b.goal = 'Inspect PR 900 for version 99'; b.state = 'completed'; b.questions = [];
  const x = processMatchInput(a), y = processMatchInput(b);
  assert.deepEqual(x.primary, y.primary); assert.notDeepEqual(x.secondary, y.secondary);
  assert.ok(!JSON.stringify(x).includes('PR 52')); assert.ok(!JSON.stringify(x).includes('R1')); assert.ok(!JSON.stringify(x).includes('Did it pass'));
});

test('one call saves summary plus process and fragment provenance atomically; resume revalidates without paying', async () => {
  const capture = seed(), counter = {n:0};
  const original = db.prepare('SELECT COUNT(*) n FROM summary_cache').get().n;
  const result = await summarizeProcessSample(db, store, capture, 'fake/model', ask(counter), signal());
  const repeated = await summarizeProcessSample(db, store, capture, 'fake/model', ask(counter), signal());
  assert.equal(counter.n, 1); assert.equal(result.id, repeated.id); assert.equal(repeated.cached, true);
  assert.equal(store.prepare('SELECT COUNT(*) n FROM episode_extractions').get().n, 1);
  assert.equal(store.prepare('SELECT assembly FROM work_episodes').get().assembly, 'fragment');
  const row = store.prepare('SELECT * FROM process_extractions').get();
  assert.equal(row.status, 'completed'); assert.ok(row.usage_json);
  assert.ok(!row.source_dependencies_json.includes('Please inspect'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM summary_cache').get().n, original);
});

for (const change of ['permission','bytes','baseline','uncited','cancel']) test(`no admission after changed ${change}`, async () => {
  seed(); seed('An additional uncited record.'); const capture = capturePilot(db,'session-a',2,before), counter = {n:0}, controller = new AbortController();
  await assert.rejects(summarizeProcessSample(db, store, capture, 'fake/model', ask(counter, () => {
    if (change === 'permission') db.prepare('UPDATE agent_sessions SET included=0').run();
    if (change === 'baseline') db.prepare("INSERT OR REPLACE INTO sync_settings(key,value) VALUES('history_since','2099-01-01')").run();
    if (change === 'uncited') db.prepare('UPDATE agent_entries SET active=0 WHERE id=?').run(capture.originals[1].id);
    if (change === 'bytes') { const p = path.join(dir,'sessions/session-a.jsonl'); fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('Please inspect','Please destroy')); }
    if (change === 'cancel') controller.abort();
  }), controller.signal));
  assert.equal(store.prepare('SELECT COUNT(*) n FROM work_episodes').get().n, 0);
  assert.equal(store.prepare('SELECT output_json FROM process_extractions').get().output_json, null);
});

test('comparison uses generalized descriptions, keeps separate episodes and verifies all parent sources on cached reuse', async () => {
  const counter = {n:0};
  const a = await summarizeProcessSample(db, store, seed(), 'fake/model', ask(counter), signal());
  const b = await summarizeProcessSample(db, store, seed('Inspect another release with a different tool.'), 'fake/model', ask(counter), signal());
  const selections = [a,b].map(x => ({ extraction:x.id, fragment:'release' }));
  const result = await compareProcessSamples(db,store,selections,'fake/model',ask(counter, payload => {
    assert.equal(payload.selections, undefined); assert.equal(payload.records, undefined);
    assert.equal(payload.candidates[0].primary.goal, 'Inspect a release');
  }),signal());
  assert.equal(result.output.relation,'shared_subprocedure'); assert.equal(counter.n,3);
  await compareProcessSamples(db,store,selections,'fake/model',ask(counter),signal()); assert.equal(counter.n,3);
  assert.equal(store.prepare('SELECT COUNT(*) n FROM work_episodes').get().n,2);
  await summarizeProcessSample(db,store,seed('Fourth work item'),'fake/model',ask(counter),signal());
  await summarizeProcessSample(db,store,seed('Fifth work item'),'fake/model',ask(counter),signal());
  await summarizeProcessSample(db,store,seed('Sixth work item'),'fake/model',ask(counter),signal());
  await summarizeProcessSample(db,store,seed('Seventh work item'),'fake/model',ask(counter),signal());
  await assert.rejects(summarizeProcessSample(db,store,seed('Eighth work item'),'fake/model',ask(counter),signal()), /seven invocations/);
  db.prepare('UPDATE agent_sessions SET included=0').run();
  await assert.rejects(compareProcessSamples(db,store,selections,'fake/model',ask(counter),signal()));
  assert.equal(counter.n,7);
});

test('cached legacy output and its comparisons cannot bypass the current source-role check', async () => {
  sourceEntry(db,path.join(dir,'sessions'),'Assistant reports a result without tool output.',{timestamp:'2026-11-18T00:00:00.000Z',role:'assistant'});
  const capture=capturePilot(db,'session-a',1,before),counter={n:0};
  const a=await summarizeProcessSample(db,store,capture,'fake/model',ask(counter),signal());
  const b=await summarizeProcessSample(db,store,seed('A separate user request'),'fake/model',ask(counter),signal());
  const old=JSON.parse(store.prepare('SELECT output_json FROM process_extractions WHERE id=?').get(a.id).output_json);
  old.fragments[0].stages[0].claims[0].basis='observed';
  store.prepare('UPDATE process_extractions SET output_json=? WHERE id=?').run(JSON.stringify(old),a.id);
  await assert.rejects(summarizeProcessSample(db,store,capture,'fake/model',ask(counter),signal()),/secondary accounts/);
  await assert.rejects(compareProcessSamples(db,store,[{extraction:a.id,fragment:'release'},{extraction:b.id,fragment:'release'}],'fake/model',ask(counter),signal()),/secondary accounts/);
  assert.equal(counter.n,2);
});

test('invalid output remains a spent attempt and cannot silently retry', async () => {
  const capture=seed(); let calls=0;
  const invalid=async()=>{calls++;return JSON.stringify(value('unavailable'));};
  await assert.rejects(summarizeProcessSample(db,store,capture,'fake/model',invalid,signal()));
  await assert.rejects(summarizeProcessSample(db,store,capture,'fake/model',invalid,signal()),/no automatic retry/);
  assert.equal(calls,1); assert.equal(store.prepare('SELECT status FROM process_extractions').get().status,'failed');
});
