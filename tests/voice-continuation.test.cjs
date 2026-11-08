const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ReplyContinuation } = require('../dist/voice/continuation');

function fixture(t, resume) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0; const states = [];
  const turn = new ReplyContinuation(async () => { calls++; await resume?.(); }, (pending, error) => states.push({ pending, error }));
  return { turn, states, calls: () => calls, tick: ms => t.mock.timers.tick(ms) };
}
const ack = 'I’ll take that as the demo app’s native iOS rewrite. I’ll check what’s recorded.';

test('a completed acknowledgement waits for retrieval then resumes once, without another user turn', t => {
  const f = fixture(t); f.turn.inputStarted(); f.turn.lookupStarted(); f.turn.response(ack, true);
  f.tick(60000); assert.equal(f.calls(), 0);
  f.turn.contextReady(); f.turn.contextReady(); f.turn.response(ack, true); f.tick(400);
  assert.equal(f.calls(), 1);
  f.turn.response('The recorded simulator tests passed. Deployment is unverified.', true);
  f.turn.contextReady(); f.tick(120000); assert.equal(f.calls(), 1);
  assert.deepEqual(f.states.at(-1), { pending: false, error: undefined });
});

test('ready context waits for streaming output and does not repeat a substantive answer', t => {
  const f = fixture(t); f.turn.inputStarted(); f.turn.lookupStarted(); f.turn.contextReady();
  f.turn.response('Five tests', false); f.tick(5000); assert.equal(f.calls(), 0);
  f.turn.response('Five tests passed. Deployment not checked.', true); f.tick(60000);
  assert.equal(f.calls(), 0); assert.equal(f.states.at(-1).pending, false);
  f.turn.lookupStarted(); assert.equal(f.states.at(-1).pending, false, 'late context cannot reopen a finished answer');
});

test('context alone cannot cue a typed question before its actual input is sent', t => {
  const f = fixture(t); f.turn.lookupStarted(); f.turn.contextReady(); f.tick(10000); assert.equal(f.calls(), 0);
  f.turn.inputStarted(); f.tick(1500); assert.equal(f.calls(), 1);
  f.turn.cancel();
});

test('Stop, a newer question, interruption, and end all cancel waiting or scheduled continuation', t => {
  const f = fixture(t); f.turn.inputStarted(); f.turn.lookupStarted(); f.turn.response(ack, true);
  f.turn.cancel(); f.turn.contextReady(); f.tick(60000); assert.equal(f.calls(), 0);
  const g = new ReplyContinuation(async () => assert.fail('stale continuation'), () => {});
  g.inputStarted(); g.contextReady(); g.cancel(); g.response(ack, true); f.tick(60000);
});

test('a failed lookup can be explained, but another acknowledgement is not an unbounded loop', t => {
  const f = fixture(t); f.turn.inputStarted(); f.turn.response(ack, true); f.turn.contextReady(); f.tick(400);
  f.turn.response('I will check the records.', true); f.tick(120000);
  assert.equal(f.calls(), 1); assert.match(f.states.at(-1).error, /no automatic retry loop/);
});

test('failed or silent continuation is visible and never retried automatically', async t => {
  const f = fixture(t, () => { throw Error('synthetic provider failure'); });
  f.turn.inputStarted(); f.turn.contextReady(); f.tick(1500); await Promise.resolve(); await Promise.resolve();
  assert.match(f.states.at(-1).error, /answer was not confirmed/);
  f.tick(90000); assert.equal(f.calls(), 1);
});

test('late or duplicated acknowledgement events cannot discard an automatic explanation or send another cue', t => {
  const f = fixture(t); f.turn.inputStarted(); f.turn.contextReady(); f.tick(1500);
  f.turn.response(ack, true); f.turn.response(ack, true); f.turn.contextReady(); f.tick(1000);
  assert.equal(f.calls(), 1); assert.ok(!f.states.some(x => x.error));
  f.turn.response('The test record shows five passes. Deployment is unverified.', true);
  f.tick(60000); assert.ok(!f.states.some(x => x.error));
});

test('honest limitations and historical quotes are not mistaken for current lookup promises', t => {
  const f = fixture(t);
  for (const reply of ['I’m unable to find an earlier record.', 'The assistant said “I’ll check the records.”', 'I will not check anything else.', 'Five tests passed. Deployment not checked.']) {
    const turn = new ReplyContinuation(async () => assert.fail('normal answer was repeated'), () => {});
    turn.inputStarted(); turn.response(reply, true); turn.contextReady(); f.tick(60000);
  }
});

test('brief acknowledgements keep a real question pending, but do not revive social replies', t => {
  const f = fixture(t);
  for (const ack of ['Alright.', 'Will do.', 'One sec.', 'Mm-hmm.', 'Uh‑huh.', 'I’m looking through the records.', 'Okay, I’m taking that as the demo rewrite. Checking what’s recorded.', 'Picking up your latest status now.']) {
    let calls = 0; const turn = new ReplyContinuation(async () => { calls++; }, () => {}, () => 'Did the export tests pass?');
    turn.inputStarted(); turn.response(ack, true); turn.contextReady(); f.tick(400);
    assert.equal(calls, 1); turn.cancel();
  }
  const social = new ReplyContinuation(async () => assert.fail('social reply repeated'), () => {}, () => 'Thanks.');
  social.inputStarted(); social.response('Alright.', true); social.contextReady(); f.tick(60000);
});

test('a silent provider reaches a bounded answer deadline', t => {
  const f = fixture(t); f.turn.inputStarted(); f.turn.contextReady(); f.tick(1500); f.tick(45000);
  assert.equal(f.calls(), 1); assert.match(f.states.at(-1).error, /answer was not confirmed/);
});
