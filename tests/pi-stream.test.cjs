const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PiTextStream } = require('../dist/sync/pi-stream');
const start = { type: 'message_start', message: { role: 'assistant' } };
const delta = text => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text, contentIndex: 0 } });
const final = (text, stopReason = 'stop') => ({ type: 'message_end', message: { role: 'assistant', stopReason, content: [{ type: 'text', text }] } });
const settled = { type: 'agent_settled', aborted: false };
const wire = events => events.map(JSON.stringify).join('\n') + '\n';

test('pi JSONL reconstruction handles split records and Unicode without exposing prompts or thinking', () => {
  const text = '{"reply":"Hello\u2028there 🐉","evidence":[],"kind":"conversation"}\n';
  const seen = [], stream = new PiTextStream(part => seen.push(part));
  const data = wire([
    { type: 'session', version: 3 }, { type: 'message_end', message: { role: 'user', content: 'PRIVATE PROMPT' } }, start,
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE THOUGHTS' } },
    delta(text.slice(0, 20)), delta(text.slice(20)), final(text), { type: 'agent_end' }, settled,
  ]);
  for (let i = 0; i < data.length; i += 7) stream.feed(data.slice(i, i + 7));
  assert.equal(stream.finish(), text); assert.equal(seen.join(''), text);
});

test('buffered JSON mode uses only authoritative final text, after successful settlement', () => {
  const expected = '{"reply":"Hello.","evidence":[],"kind":"conversation"}';
  const data = wire([start, delta('Provisional text is not spoken.'), final(expected), settled]);
  for (let split = 0; split <= data.length; split++) {
    const stream = new PiTextStream();
    stream.feed(data.slice(0, split)); stream.feed(data.slice(split));
    assert.equal(stream.finish(), expected);
  }
  const incomplete = new PiTextStream(); incomplete.feed(wire([start, final(expected)]));
  assert.throws(() => incomplete.finish(), /Incomplete/);
  const oversized = new PiTextStream();
  assert.throws(() => oversized.feed(wire([start, final('a'.repeat(64001)), settled])), /too much text/);
  const duplicate = new PiTextStream();
  assert.throws(() => duplicate.feed(wire([start, final(expected), final(expected)])), /Invalid pi final/);
  const unstarted = new PiTextStream();
  assert.throws(() => unstarted.feed(wire([final(expected), settled])), /Invalid pi final/);
});

test('code-zero model errors, truncation, retries, revisions and incomplete streams are not successes', () => {
  for (const callback of [undefined, () => {}]) for (const reason of ['error', 'aborted', 'length', 'toolUse', 'pending']) {
    const stream = new PiTextStream(callback);
    assert.throws(() => stream.feed(wire([start, delta('partial'), final('partial', reason)])), /did not finish/);
  }
  const revised = new PiTextStream(() => {});
  assert.throws(() => revised.feed(wire([start, delta('before'), final('after')])), /revised/);
  const retry = new PiTextStream();
  assert.throws(() => retry.feed(wire([{ type: 'auto_retry_start' }])), /retry/);
  const partial = new PiTextStream(() => {}); partial.feed(wire([start, delta('hello'), final('hello')]));
  assert.throws(() => partial.finish(), /Incomplete/);
  const tooLarge = new PiTextStream();
  assert.throws(() => tooLarge.feed('x'.repeat(1000001)), /safety limit/);
});
