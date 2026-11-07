const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
// Node >=22.19 loads this pure, type-only-dependency module without a transpiler or DOM.
const { prepareSpeech, sampleSpeech, PersonaMotion } = require('../client/src/persona/motion.ts');
function cue(text = 'Maybe we should go?') {
  const samples = new Float32Array(16000);
  for (let i = 4000; i < 12000; i++) samples[i] = Math.sin(i * 0.15) * 0.2;
  return { text, samples, sampleRate: 16000, duration: 1, startedAt: 3, now: () => 3.5 };
}
test('mouth timing follows actual audio energy, including silence and end boundaries', () => {
  const track = prepareSpeech(cue('aaa'));
  for (const time of [-1, 0.1, 0.9, 1, 2, NaN]) assert.equal(sampleSpeech(track, time).jaw, 0);
  assert.ok(sampleSpeech(track, 0.5).jaw > 0.5);
  const silent = cue(); silent.samples.fill(0);
  assert.equal(sampleSpeech(prepareSpeech(silent), 0.5).jaw, 0);
});
test('text cues distinguish closed consonants and rounded vowels without inventing audio timing', () => {
  const closed = sampleSpeech(prepareSpeech(cue('mmm')), 0.5), rounded = sampleSpeech(prepareSpeech(cue('ooo')), 0.5);
  assert.equal(closed.jaw, 0); assert.ok(rounded.jaw > 0.3); assert.ok(rounded.round > 0.5);
});
test('gaps, interruption and reduced motion close the mouth even when phase still says speaking', () => {
  const motion = new PersonaMotion(), playback = cue('aaa');
  const active = { mode: 'speaking', motion: true, playback };
  assert.ok(motion.sample(active, 1, 0.1).jaw > 0);
  assert.equal(motion.sample({ ...active, playback: null }, 1.1, 0.1).jaw, 0);
  assert.equal(motion.sample({ ...active, mode: 'thinking' }, 1.2, 0.1).jaw, 0);
  assert.equal(motion.sample({ ...active, motion: false }, 1.3, 0.1).jaw, 0);
  assert.equal(motion.sample({ ...active, mode: 'ended' }, 1.4, 0.1).breath, 0);
  motion.dispose();
});
test('suspended playback clocks do not flap the jaw and a new chunk resets its alignment', () => {
  const motion = new PersonaMotion();
  assert.equal(motion.sample({ mode: 'speaking', motion: true, playback: { ...cue(), now: () => NaN } }, 1, 0.1).jaw, 0);
  let clock = 3.5;
  const input = { mode: 'speaking', motion: true, playback: { ...cue('ooo'), now: () => clock } };
  assert.ok(motion.sample(input, 1.1, 0.1).jaw > 0);
  clock = NaN; assert.equal(motion.sample(input, 1.2, 0.1).jaw, 0);
  clock = 3.5; assert.ok(motion.sample(input, 1.3, 0.1).jaw > 0);
  clock = 3.9; assert.equal(motion.sample(input, 1.4, 0.1).jaw, 0);
  assert.equal(motion.sample({ ...input, playback: cue('mmm') }, 1.5, 0.1).jaw, 0);
});
test('live mouth follows received energy without invented phoneme timing or suspended-clock movement', () => {
  const motion = new PersonaMotion(); let level = 0.8, clock = 2;
  const input = { mode: 'speaking', motion: true, playback: { ...cue(), samples: new Float32Array(0), duration: Infinity, startedAt: 0, now: () => clock, level: () => level } };
  assert.ok(motion.sample(input, 1, 0.1).jaw > 0.4);
  level = 0; assert.equal(motion.sample(input, 1.1, 0.1).jaw, 0);
  level = 0.8; clock = NaN; assert.equal(motion.sample(input, 1.2, 0.1).jaw, 0);
  clock = 2; assert.equal(motion.sample({ ...input, motion: false }, 1.3, 0.1).jaw, 0);
  input.playback.level = () => { throw Error('observer failed'); };
  assert.equal(motion.sample(input, 1.4, 0.1).jaw, 0);
});

test('the persona module contains no backend, session, microphone or provider dependencies', () => {
  const root = require('node:path').join(__dirname, '../client/src/persona');
  for (const file of fs.readdirSync(root).filter(f => /\.tsx?$/.test(f))) {
    const content = fs.readFileSync(require('node:path').join(root, file), 'utf8');
    assert.doesNotMatch(content, /from ['"][^'"]*(?:\/voice\/|\/api\/|\/contexts\/)/, file);
    assert.doesNotMatch(content, /getUserMedia|\/api\/voice|invokePi|localStorage/, file);
  }
});
