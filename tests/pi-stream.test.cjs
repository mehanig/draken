const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PiTextStream } = require('../dist/sync/pi-stream');
const { VoiceAnswerStream } = require('../dist/voice/answer-stream');
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
test('voice object framing tolerates pretty JSON and fences without speaking partial objects or wrapper text', () => {
  const first = { reply: 'A } brace and a "quote" 🐉.', evidence: ['E1'], kind: 'grounded' };
  const second = { reply: 'Next sentence.', evidence: [], kind: 'conversation' };
  for (const wrap of [false, true]) {
    const seen = [], parser = new VoiceAnswerStream(json => seen.push(JSON.parse(json)));
    const prefix = (wrap ? '```json\n' : '') + JSON.stringify(first, null, 2);
    for (const character of prefix.slice(0, -1)) parser.feed(character);
    assert.equal(seen.length, 0); parser.feed(prefix.slice(-1)); assert.deepEqual(seen, [first]);
    parser.feed('\n' + JSON.stringify(second) + (wrap ? '\n```' : '')); parser.finish();
    assert.deepEqual(seen, [first, second]);
  }
  const incomplete = new VoiceAnswerStream(() => assert.fail('Partial object escaped'));
  incomplete.feed('{"reply":"partial'); assert.throws(() => incomplete.finish(), /incomplete/);
  assert.throws(() => new VoiceAnswerStream(() => {}).feed('Here is an answer:'), /not valid JSON/);
});

test('voice framing accepts observed comma separators and arrays across every packet boundary', () => {
  const a = { reply: 'Thanks for confirming.', evidence: [], kind: 'conversation' };
  const b = { reply: 'What next?', evidence: [], kind: 'conversation' };
  const sequence = JSON.stringify(a) + ' \n, ' + JSON.stringify(b);
  for (const text of [sequence, '[' + sequence + ']', '```json\n[' + sequence + ']\n```']) {
    for (let split = 0; split <= text.length; split++) {
      const seen = [], parser = new VoiceAnswerStream(raw => seen.push(JSON.parse(raw)));
      parser.feed(text.slice(0, split)); parser.feed(text.slice(split)); parser.finish();
      assert.deepEqual(seen, [a, b]);
    }
  }
  for (const text of [',' + JSON.stringify(a), JSON.stringify(a) + ',,', '[' + JSON.stringify(a) + ',]', '[' + JSON.stringify(a) + JSON.stringify(b) + ']', JSON.stringify(a) + ',']) {
    const parser = new VoiceAnswerStream(JSON.parse);
    assert.throws(() => { parser.feed(text); parser.finish(); });
  }
});

test('code-zero model errors, truncation, retries, revisions and incomplete streams are not successes', () => {
  for (const reason of ['error', 'aborted', 'length', 'toolUse', 'pending']) {
    const stream = new PiTextStream(() => {});
    assert.throws(() => stream.feed(wire([start, delta('partial'), final('partial', reason)])), /did not finish/);
  }
  const revised = new PiTextStream(() => {});
  assert.throws(() => revised.feed(wire([start, delta('before'), final('after')])), /revised/);
  const retry = new PiTextStream(() => {});
  assert.throws(() => retry.feed(wire([{ type: 'auto_retry_start' }])), /retry/);
  const partial = new PiTextStream(() => {}); partial.feed(wire([start, delta('hello'), final('hello')]));
  assert.throws(() => partial.finish(), /Incomplete/);
  const tooLarge = new PiTextStream(() => {});
  assert.throws(() => tooLarge.feed('x'.repeat(1000001)), /safety limit/);
});
