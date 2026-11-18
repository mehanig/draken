// Pure public-contract tests. No Draken storage, service, normalizer or provider imports.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEvidence } = require('../dist/evidence');
const before = '2026-01-08T00:00:00.000Z';
let dependencies, searched, calls;
beforeEach(() => {
  searched = []; calls = [];
  dependencies = {
    search: async query => { searched.push(query); return { mode: 'synthetic', results: [], limitations: 'Empty search.' }; },
    read: async () => assert.fail('No original may be read without a selected ID'),
    cleanText: (text, limit) => text.slice(0, limit),
  };
});
const request = (question, scope = 'project') => ({ question, before, signal: new AbortController().signal,
  ask: async (payload, system) => { calls.push({ payload, system }); return JSON.stringify({ scope, selected: [] }); } });

for (const [scope, kind] of [['unrelated', 'unrelated'], ['unclear', 'clarify'], ['project', 'ready']]) {
  test(`${scope} is a distinct successful result, including when search is empty`, async () => {
    const result = await prepareEvidence(request('A current user request', scope), dependencies);
    assert.equal(result.kind, kind); assert.deepEqual(result.refs, []); assert.equal(calls.length, 1);
    assert.equal(searched[0].limit, 64); assert.equal(searched[0].before, before);
    if (kind === 'ready') assert.match(result.text, /No match is not proof/);
    else { assert.ok(result.message); assert.equal(JSON.parse(result.text).scope, scope); }
  });
}

test('retrieval refinements never replace the actual question; conversation context has explicit limits', async () => {
  await prepareEvidence({ ...request('What do you think should be next?'), lookupQuestion: 'Search for Atlas architecture changes',
    previousQuestions: Array(10).fill('q'.repeat(900)), briefing: 'b'.repeat(9000), scope: { session_ids: ['atlas'] } }, dependencies);
  assert.equal(searched[0].question, 'Search for Atlas architecture changes');
  assert.deepEqual(searched[0].session_ids, ['atlas']);
  const { payload, system } = calls[0];
  assert.equal(payload.question, 'What do you think should be next?');
  assert.equal(payload.previous_user_messages.length, 6);
  assert.ok(payload.previous_user_messages.every(text => text.length <= 500));
  assert.ok(payload.briefing.length <= 4000);
  assert.match(system, /architecture opinions/); assert.match(system, /do not classify by keywords/i);
  assert.match(system, /Missing candidates never establish/);
});

test('search failure is not converted into an unrelated, clarification or empty-evidence answer', async () => {
  dependencies.search = async () => { throw Error('Synthetic unavailable archive'); };
  await assert.rejects(prepareEvidence(request('Current status?'), dependencies), /unavailable archive/);
  assert.equal(calls.length, 0);
});

test('cancellation before or during search cannot call the selector or return a scope decision', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareEvidence({ ...request('Status?'), signal: controller.signal }, dependencies), /abort/i);
  assert.equal(searched.length, 0);
  const next = new AbortController();
  dependencies.search = async () => { next.abort(); return { results: [], mode: 'synthetic', limitations: '' }; };
  await assert.rejects(prepareEvidence({ ...request('Status?'), signal: next.signal }, dependencies), /abort/i);
  assert.equal(calls.length, 0);
});
