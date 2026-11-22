const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEvidence } = require('../dist/evidence');
const before = '2026-01-08T00:00:00.000Z';
let dependencies, searched, calls;
const plan = (overrides = {}) => ({ scope: 'project', sessions: [], query: 'recorded engineering work', kind: 'sources', recent: true, ...overrides });
beforeEach(() => {
  searched = []; calls = [];
  dependencies = {
    sessions: async () => [{ id: 'atlas', workspace: '/atlas', title: 'Atlas' }, { id: 'beacon', workspace: '/beacon', title: 'Beacon' }],
    search: async query => { searched.push(query); return { mode: 'synthetic', results: [], limitations: 'Empty search.' }; },
    read: async () => assert.fail('No original may be read without a selected ID'),
    cleanText: (text, limit) => text.slice(0, limit),
  };
});
const request = (question, output = plan()) => ({ question, before, signal: new AbortController().signal,
  ask: async (payload, system) => { calls.push({ payload, system }); return JSON.stringify(payload.task === 'plan_evidence' ? output : { scope: 'project', selected: [] }); } });

for (const [scope, kind] of [['unrelated', 'unrelated'], ['unclear', 'clarify'], ['project', 'ready']]) {
  test(`${scope} is distinct from missing evidence and scope refusals do not search`, async () => {
    const result = await prepareEvidence(request('A current user request', scope === 'project' ? plan() : { scope }), dependencies);
    assert.equal(result.kind, kind); assert.deepEqual(result.refs, []); assert.equal(calls.length, scope === 'project' ? 2 : 1);
    if (kind === 'ready') { assert.match(result.text, /No match is not proof/); assert.equal(searched[0].limit, 64); assert.equal(searched[0].before, before); }
    else { assert.equal(searched.length, 0); assert.ok(result.message); assert.equal(JSON.parse(result.text).scope, scope); }
  });
}

test('planning receives actual turns and an untrusted refinement; the model supplies scope and query, not word rules', async () => {
  await prepareEvidence({ ...request('What do you think should be next?', plan({ sessions: ['P1'], query: 'Atlas architecture outcomes' })),
    lookupQuestion: 'Untrusted suggested search', previousQuestions: Array(10).fill('q'.repeat(900)), briefing: 'b'.repeat(9000), scope: { session_ids: ['atlas'] } }, dependencies);
  assert.match(searched[0].question, /Atlas architecture outcomes/); assert.deepEqual(searched[0].session_ids, ['atlas']);
  const { payload, system } = calls[0];
  assert.equal(payload.question, 'What do you think should be next?'); assert.equal(payload.search_hint, 'Untrusted suggested search');
  assert.deepEqual(payload.sessions, [{ id: 'P1', workspace: '/atlas', title: 'Atlas' }]);
  assert.equal(payload.previous_user_messages.length, 6); assert.ok(payload.previous_user_messages.every(text => text.length <= 500));
  assert.ok(payload.briefing.length <= 4000); assert.match(system, /architecture opinions/); assert.match(system, /Do not classify by keywords/);
  assert.equal(calls[1].payload.question, payload.question);
});

for (const question of ['Whatsup currently woth draken?', 'How are things going?', 'And now?', '¿Cómo va el proyecto?']) {
  test(`model interpretation controls retrieval for ${JSON.stringify(question)}`, async () => {
    await prepareEvidence(request(question, plan({ sessions: ['P2'], query: 'Beacon latest implemented outcomes' })), dependencies);
    assert.deepEqual(searched[0].session_ids, ['beacon']); assert.equal(searched[0].recent, true);
    assert.equal(calls[0].payload.question, question);
  });
}

test('historical requests, project switches, multiple sessions and recall follow the validated model plan', async () => {
  for (const [output, expected] of [
    [plan({ sessions: ['P1'], recent: false }), ['atlas']],
    [plan({ sessions: ['P2'] }), ['beacon']],
    [plan({ sessions: ['P1', 'P2'] }), ['atlas', 'beacon']],
    [plan({ kind: 'conversation', recent: false, sessions: ['P1'] }), undefined],
    [plan({ kind: 'all', sessions: ['P1'] }), undefined],
    [plan(), undefined],
  ]) {
    await prepareEvidence({ ...request('A natural-language request', output), previousQuestions: ['Tell me about Atlas'] }, dependencies);
    assert.deepEqual(searched.at(-1).session_ids, expected); assert.equal(searched.at(-1).recent, output.recent); assert.equal(searched.at(-1).kind, output.kind === 'all' ? undefined : output.kind);
  }
});

test('an explicit host scope cannot be widened by the model, including for recall', async () => {
  await prepareEvidence({ ...request('Recall our discussion', plan({ kind: 'conversation' })), scope: { session_ids: ['atlas'] } }, dependencies);
  assert.deepEqual(searched[0].session_ids, ['atlas']);
  await assert.rejects(prepareEvidence({ ...request('Status?', plan({ sessions: ['P2'] })), scope: { session_ids: ['atlas'] } }, dependencies), /Evidence planning returned invalid/);
});

test('invalid planning fails before search, without repair, fallback, or invented source access', async () => {
  for (const output of [null, {}, { scope: 'unclear', query: 'extra' }, plan({ sessions: ['P3'] }), plan({ sessions: ['P1', 'P1'] }), plan({ sessions: ['P0'] }), plan({ kind: 'invented' }), plan({ recent: 'true' }), plan({ query: '' }), plan({ query: 'x'.repeat(2001) }), plan({ before: '2099-01-01' })]) {
    await assert.rejects(prepareEvidence(request('Status?', output), dependencies), /Evidence planning returned invalid/);
  }
  assert.equal(searched.length, 0); assert.ok(calls.every(call => call.payload.task === 'plan_evidence'));
});

test('search failure remains a failure after planning, not a scope decision or empty evidence', async () => {
  dependencies.search = async () => { throw Error('Synthetic unavailable archive'); };
  await assert.rejects(prepareEvidence(request('Current status?'), dependencies), /unavailable archive/); assert.equal(calls.length, 1);
});

test('cancellation at catalog, planning and search boundaries stops later work', async () => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(prepareEvidence({ ...request('Status?'), signal: aborted.signal }, dependencies), /abort/i);
  assert.equal(calls.length, 0);
  const controller = new AbortController();
  await assert.rejects(prepareEvidence({ ...request('Status?'), signal: controller.signal, ask: async () => { controller.abort(); return JSON.stringify(plan()); } }, dependencies), /abort/i);
  assert.equal(searched.length, 0);
  const next = new AbortController();
  dependencies.search = async () => { next.abort(); return { results: [], mode: 'synthetic', limitations: '' }; };
  await assert.rejects(prepareEvidence({ ...request('Status?'), signal: next.signal }, dependencies), /abort/i);
  assert.equal(calls.length, 1);
});
