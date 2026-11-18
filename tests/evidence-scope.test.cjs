// Contract tests with synthetic model choices, not model-quality qualification.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const service = require('../dist/memory/service');
const { prepareEvidence } = require('../dist/evidence');
const before = '2026-01-08T00:00:00.000Z';
let search, read, searched, calls;
beforeEach(() => {
  search = service.searchPreparedHistory; read = service.readHistory; searched = []; calls = [];
  service.searchPreparedHistory = async query => { searched.push(query); return { mode: 'hybrid', results: [], limitations: 'Synthetic empty search.' }; };
  service.readHistory = async () => assert.fail('No original may be read without a selected ID');
});
afterEach(() => { service.searchPreparedHistory = search; service.readHistory = read; });
const request = (question, scope = 'project') => ({ question, before, signal: new AbortController().signal,
  ask: async (payload, system) => { calls.push({ payload, system }); return JSON.stringify({ scope, selected: [] }); } });

for (const [scope, kind] of [['unrelated', 'unrelated'], ['unclear', 'clarify'], ['project', 'ready']]) {
  test(`${scope} is a distinct successful result, including when search is empty`, async () => {
    const result = await prepareEvidence(request('A current user request', scope));
    assert.equal(result.kind, kind); assert.deepEqual(result.refs, []); assert.equal(calls.length, 1);
    assert.equal(searched[0].limit, 64); assert.equal(searched[0].before, before);
    if (kind === 'ready') assert.match(result.text, /No match is not proof/);
    else { assert.ok(result.message); assert.equal(JSON.parse(result.text).scope, scope); }
  });
}

test('retrieval refinements never replace the actual question; conversation context has explicit limits', async () => {
  await prepareEvidence({ ...request('What do you think should be next?'), lookupQuestion: 'Search for Atlas architecture changes',
    previousQuestions: Array(10).fill('q'.repeat(900)), briefing: 'b'.repeat(9000), scope: { session_ids: ['atlas'] } });
  assert.equal(searched[0].question, 'Search for Atlas architecture changes');
  assert.deepEqual(searched[0].session_ids, ['atlas']);
  const { payload, system } = calls[0];
  assert.equal(payload.question, 'What do you think should be next?');
  assert.equal(payload.previous_user_messages.length, 6);
  assert.ok(payload.previous_user_messages.every(text => text.length <= 530));
  assert.ok(payload.briefing.length <= 4030);
  assert.match(system, /architecture opinions/); assert.match(system, /do not classify by keywords/i);
  assert.match(system, /Missing candidates never establish/);
});

test('search failure is not converted into an unrelated, clarification or empty-evidence answer', async () => {
  service.searchPreparedHistory = async () => { throw Error('Synthetic unavailable archive'); };
  await assert.rejects(prepareEvidence(request('Current status?')), /unavailable archive/);
  assert.equal(calls.length, 0);
});

test('cancellation before or during search cannot call the selector or return a scope decision', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareEvidence({ ...request('Status?'), signal: controller.signal }), /abort/i);
  assert.equal(searched.length, 0);
  const next = new AbortController();
  service.searchPreparedHistory = async () => { next.abort(); return { results: [], mode: 'hybrid', limitations: '' }; };
  await assert.rejects(prepareEvidence({ ...request('Status?'), signal: next.signal }), /abort/i);
  assert.equal(calls.length, 0);
});
