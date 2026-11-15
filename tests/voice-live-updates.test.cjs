// Synthetic native protocol only: no provider, microphone, live database or model.
require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getDb, closeDb } = require('../dist/db/schema');
const { activity } = require('../dist/sync/activity');
const conversation = require('../dist/sync/conversation');
const background = require('../dist/sync/background');
const memory = require('../dist/memory/service');
const context = require('../dist/memory/context');
const live = require('../dist/voice/live');
const { NativeVoice } = require('../voice/realtime/native.mjs');
const BEFORE = '2025-01-01T00:00:00.000Z', NEXT = '2025-02-01T00:00:00.000Z';
const signal = () => new AbortController().signal;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => { for (let n = 0; n < 150; n++) { if (check()) return; await wait(10); } assert.fail('Synthetic condition timed out'); };
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
let root, syncId, emit, before, lookups, restores, gates;
function replace(object, key, value) { const original = object[key]; object[key] = value; restores.push(() => { object[key] = original; }); return original; }
function packet(ref = 'Hfixture') { return { text: JSON.stringify({ sources: [{ ref, text: 'Recorded test evidence; deployment unverified.' }] }), refs: [ref] }; }
const requests = () => fs.readFileSync(path.join(process.env.DRAKEN_CODEX_HOME, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const event = (role, text, done = true) => emit({ method: `thread/realtime/transcript/${done ? 'done' : 'delta'}`, params: { role, [done ? 'text' : 'delta']: text } });
const gate = () => { const value = deferred(); gates.push(value); return value; };
// Run the real scheduler through asynchronous preparation, not just its idle
// predicate. Wire the public cancellation path to this exact worker owner.
async function heldIndexer() {
  const exited = gate(); let preparationSignal, retired = false, preparations = 0;
  const worker = background.createAutoIndexer({
    enabled: () => true, idle: () => activity.backgroundIdle, now: Date.now,
    activeConversations: () => true, scan: async () => ({ warnings: [] }),
    baseline: () => new Map(), stamp: () => new Map([['new-record', 'changed']]),
    prepare: async (_before, signal) => {
      preparations++; preparationSignal = signal;
      await exited.promise; retired = true;
    },
    completed: () => assert.fail('Cancelled preparation must not publish completion'),
  });
  replace(background, 'yieldBackgroundIndexing', () => worker.stop());
  const job = worker.tick();
  await until(() => preparationSignal);
  assert.equal(preparationSignal.aborted, false);
  return { worker, job, exited, get signal() { return preparationSignal; }, get retired() { return retired; }, get preparations() { return preparations; } };
}
async function connected(scenario = 'controlled') {
  fs.writeFileSync(path.join(process.env.DRAKEN_CODEX_HOME, 'scenario.txt'), scenario);
  const call = await live.createLiveCall(syncId, signal());
  assert.equal(activity.backgroundIdle, false);
  await live.connectLiveCall(call.id, 'v=0\r\nm=audio 9 test', signal());
  return call;
}
beforeEach(() => {
  restores = []; gates = []; before = BEFORE; lookups = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-voice-updates-'));
  for (const [key, value] of Object.entries({ DRAKEN_DATA_DIR: root, DRAKEN_PI_SESSIONS_DIR: path.join(root, 'sessions'), DRAKEN_VOICE_MODE: 'native', DRAKEN_CODEX_HOME: path.join(root, 'account'), DRAKEN_CODEX_BIN: path.join(__dirname, 'fixtures/fake-codex.cjs') })) {
    const old = process.env[key]; process.env[key] = value;
    restores.push(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  fs.mkdirSync(process.env.DRAKEN_CODEX_HOME);
  fs.writeFileSync(path.join(process.env.DRAKEN_CODEX_HOME, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic', refresh_token: 'synthetic', id_token: 'synthetic' } }));
  const at = new Date().toISOString();
  syncId = Number(getDb().prepare("INSERT INTO syncs(created_at,snapshot_at,snapshot_version,briefing,compression_complete,decisions,conversation_before) VALUES(?,?,2,'Original frozen briefing.',1,'Original notes.',?)").run(at, at, BEFORE).lastInsertRowid);
  replace(memory, 'historyReadiness', () => ({ ready: true, before }));
  replace(context, 'historyContext', async (...args) => { lookups.push(args); return packet(); });
  const subscribe = replace(NativeVoice.prototype, 'subscribe', function (listener) { emit = listener; return subscribe.call(this, listener); });
});
afterEach(async () => {
  for (const value of gates) value.resolve();
  // Restore the wall clock before lifecycle teardown.
  for (const restore of restores.splice(0).reverse()) restore();
  await live.stopLiveCalls(); closeDb(); fs.rmSync(root, { recursive: true, force: true });
});

function frozenSource() {
  const { frozenEvidence } = require('./fixtures/source-entry.cjs');
  const item = frozenEvidence(getDb(), process.env.DRAKEN_PI_SESSIONS_DIR, 'Verified original frozen result.', { ref: 'E1' });
  getDb().prepare('INSERT INTO sync_items(sync_id,event_key,evidence_json) VALUES(?,?,?)').run(syncId, item.event_key, JSON.stringify(item));
  return getDb().prepare('SELECT path FROM agent_sessions WHERE id=?').get(item.session_id).path;
}
test('damage after reservation prevents the initial native packet from being sent', async () => {
  const file = frozenSource(), call = await live.createLiveCall(syncId, signal());
  let opens = 0; replace(NativeVoice.prototype, 'open', async () => { opens++; return 'unexpected'; });
  fs.unlinkSync(file);
  await assert.rejects(live.connectLiveCall(call.id, 'v=0\\r\\nm=audio 9 test', signal()), /could not connect/);
  assert.equal(opens, 0); assert.equal(activity.callActive, false);
});
test('damage to an idle call snapshot rejects the next user turn rather than reusing copied E text', async () => {
  const file = frozenSource(), call = await connected(); let sends = 0;
  replace(NativeVoice.prototype, 'text', async () => { sends++; }); fs.unlinkSync(file);
  await assert.rejects(live.sendLiveText(call.id, 'Explain E1', randomUUID()), /Original session evidence/);
  await until(() => !activity.callActive); assert.equal(sends, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});
test('damage during H retrieval is fatal rather than hidden by the qualified empty-history fallback', async () => {
  const file = frozenSource(), call = await connected(); let sends = 0, contexts = 0;
  replace(NativeVoice.prototype, 'text', async () => { sends++; });
  replace(NativeVoice.prototype, 'context', async () => { contexts++; });
  replace(context, 'historyContext', async () => { fs.unlinkSync(file); throw Error('Original disappeared during retrieval'); });
  await live.sendLiveText(call.id, 'What changed in the project?', randomUUID());
  await until(() => !activity.callActive);
  assert.equal(live.liveEvents(call.id, 0).active, false, 'fatal verification ends the call, not a successful empty-history answer');
  assert.equal(sends, 0); assert.equal(contexts, 0);
  assert.equal(getDb().prepare('SELECT decisions FROM syncs WHERE id=?').get(syncId).decisions, 'Original notes.');
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});

test('new unprepared corpus arrivals do not block an already-prepared call or replace its own cutoff', async () => {
  const { callReadiness } = require('../dist/sync/preparation');
  replace(memory, 'historyReadiness', capturedOnly => ({ ready: Boolean(capturedOnly), before: capturedOnly ? BEFORE : null }));
  replace(memory, 'prepareHistory', async () => { assert.fail('Setup must not prepare history'); });
  assert.equal(memory.historyReadiness().ready, false);
  assert.equal(callReadiness(syncId, false).ready, true);
  const initial = conversation.conversationStatus(syncId);
  const call = await connected('refinement');
  assert.equal(conversation.conversationStatus(syncId).history_before, BEFORE);
  assert.equal(conversation.conversationStatus(syncId).last_user_at, initial.last_user_at);
  await live.sendLiveText(call.id, 'What are we uploading?', randomUUID());
  await until(() => activity.backgroundIdle);
  assert.deepEqual(lookups.map(args => args[1]), [BEFORE, BEFORE, BEFORE]);
  assert.ok(lookups.every(args => args[4] === true), 'all retrieval stays prepared-only');
});

test('globally ready history cannot initialize a never-prepared conversation', async () => {
  getDb().prepare('UPDATE syncs SET conversation_before=NULL WHERE id=?').run(syncId);
  replace(memory, 'prepareHistory', async () => { assert.fail('Setup must not prepare history'); });
  assert.equal(memory.historyReadiness().ready, true);
  assert.equal(require('../dist/sync/preparation').callReadiness(syncId, false).ready, false);
  await assert.rejects(live.createLiveCall(syncId, signal()), /Prepare history before calling/);
  assert.equal(conversation.conversationStatus(syncId).history_before, null);
  assert.equal(activity.callActive, false);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM live_calls').get().n, 0);
  assert.equal(fs.existsSync(path.join(process.env.DRAKEN_CODEX_HOME, 'requests.jsonl')), false);
});

test('setup and readiness polling never adopt newer READY history; the first real user turn does', async () => {
  before = NEXT;
  const { callReadiness } = require('../dist/sync/preparation');
  for (const capturedOnly of [false, true]) assert.equal(callReadiness(syncId, capturedOnly).before, BEFORE);
  const call = await connected();
  assert.equal(conversation.conversationStatus(syncId).history_before, BEFORE);
  assert.equal(conversation.conversationStatus(syncId).available_before, NEXT);
  await live.sendLiveText(call.id, 'What changed?', randomUUID());
  assert.equal(lookups[0][1], NEXT);
  assert.equal(conversation.conversationStatus(syncId).history_before, NEXT);
});

test('setup rechecks its own preparation after native status, without borrowing globally ready history', async () => {
  const pending = live.createLiveCall(syncId, signal());
  // createLiveCall has reached its native-status await; revoke only this
  // conversation's marker while the synthetic helper check is outstanding.
  getDb().prepare('UPDATE syncs SET conversation_before=NULL WHERE id=?').run(syncId);
  await assert.rejects(pending, /History changed.*Prepare history before calling/);
  assert.equal(conversation.conversationStatus(syncId).history_before, null);
  assert.equal(activity.callActive, false);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM live_calls').get().n, 0);
});

test('unavailable history still permits prepared setup and delivers qualified empty context at the last known cutoff', async () => {
  replace(memory, 'historyReadiness', () => ({ ready: false, before: null }));
  replace(context, 'historyContext', async (...args) => { lookups.push(args); throw Error('Synthetic archive unavailable'); });
  const call = await connected();
  await live.sendLiveText(call.id, 'What changed?', randomUUID());
  assert.equal(lookups[0][1], BEFORE);
  assert.equal(lookups[0][4], true);
  assert.equal(conversation.conversationStatus(syncId).history_before, BEFORE);
  const text = requests().find(item => item.params?.role === 'developer').params.text;
  assert.match(text, /Archive lookup failed or is busy/);
  assert.match(text, /No other search mode or provider was substituted/);
  assert.match(text, /earlier history could not be checked/);
  assert.ok(!live.liveEvents(call.id, 0).events.some(item => item.type === 'sources' && item.evidence.length));
  event('assistant', 'Earlier history could not be checked.'); await flush();
  assert.equal(activity.backgroundIdle, true);
});

test('READY history changes only at the next turn; all native refinements share its captured cutoff and frozen opening', async () => {
  replace(context, 'historyContext', async (...args) => {
    lookups.push(args);
    if (lookups.length === 1) before = NEXT;
    return packet(`Hturn${lookups.length}`);
  });
  const call = await connected('refinement');
  assert.equal(activity.backgroundIdle, true);
  await live.sendLiveText(call.id, 'What are we uploading?', randomUUID());
  await until(() => activity.backgroundIdle);
  assert.deepEqual(lookups.map(args => args[1]), [BEFORE, BEFORE, BEFORE]);
  assert.equal(conversation.conversationStatus(syncId).history_before, BEFORE);
  assert.equal(conversation.conversationStatus(syncId).available_before, NEXT);
  getDb().prepare("UPDATE syncs SET briefing='MUST_NOT_REWRITE_THE_OPENING' WHERE id=?").run(syncId);
  await live.sendLiveText(call.id, 'What else is recorded?', randomUUID());
  await until(() => activity.backgroundIdle);
  assert.deepEqual(lookups.slice(3).map(args => args[1]), [NEXT, NEXT, NEXT]);
  assert.equal(conversation.conversationStatus(syncId).history_before, NEXT);
  const starts = requests().filter(item => item.method === 'thread/realtime/start');
  assert.equal(starts.length, 1);
  assert.match(starts[0].params.initialItems[0].text, /Original frozen briefing/);
  assert.ok(!JSON.stringify(requests()).includes('MUST_NOT_REWRITE_THE_OPENING'));
});

test('typed arrival takes ownership immediately and awaits confirmed background drain before any lookup or user append', async () => {
  const call = await connected(), stopped = gate(); let yields = 0;
  replace(background, 'yieldBackgroundIndexing', () => { yields++; return stopped.promise; });
  const pending = live.sendLiveText(call.id, 'Check the latest tests.', randomUUID());
  assert.equal(yields, 1); assert.equal(activity.backgroundIdle, false);
  assert.equal(activity.voiceTurnActive(syncId), true);
  await wait(30);
  assert.equal(lookups.length, 0);
  assert.equal(requests().filter(item => item.method.includes('append')).length, 0);
  before = NEXT; stopped.resolve(); await pending;
  assert.equal(lookups[0][1], BEFORE, 'capture happens at admission, not after drain');
  assert.equal(activity.backgroundIdle, false, 'delivered input is not a completed answer');
  event('assistant', 'The tests ', false);
  assert.equal(activity.backgroundIdle, false);
  event('assistant', 'The tests passed; deployment is unverified.'); await flush();
  assert.equal(activity.backgroundIdle, true);
});

test('scheduler cancellation is not worker-exit confirmation; newer turns and call cleanup inherit the owned retirement wait', async () => {
  const call = await connected(), retired = gate(); let backgroundOwned = true, stops = 0;
  replace(memory, 'historyProgress', () => ({ background: backgroundOwned }));
  replace(memory, 'stopHistory', () => { stops++; backgroundOwned = false; return retired.promise; });
  replace(background, 'yieldBackgroundIndexing', async () => {});
  const older = live.sendLiveText(call.id, 'Old question.', randomUUID());
  const newer = live.sendLiveText(call.id, 'New question.', randomUUID());
  await wait(30);
  assert.equal(stops, 1, 'never stop a foreground service owner');
  assert.equal(lookups.length, 0, 'scheduler settling alone does not admit either lookup');
  assert.equal(activity.backgroundIdle, false);
  retired.resolve(); await Promise.all([older, newer]);
  assert.equal(lookups.length, 1);
  assert.match(lookups[0][0], /New question/);
  event('assistant', 'The new reply is complete.'); await flush();
  assert.equal(activity.backgroundIdle, true);

  const closingDrain = gate(); backgroundOwned = true;
  replace(memory, 'stopHistory', () => { backgroundOwned = false; return closingDrain.promise; });
  const pending = live.sendLiveText(call.id, 'Last question.', randomUUID());
  let closed = false; const closing = live.endLiveCall(call.id).then(() => { closed = true; });
  await wait(40);
  assert.equal(closed, false); assert.equal(activity.callActive, true);
  closingDrain.resolve(); await Promise.all([closing, pending]);
  assert.equal(activity.callActive, false);
  assert.equal(lookups.length, 1, 'end while draining cannot send missing-context input');
});

test('spoken reception stays nonblocking while background drains; acknowledgement and pending context keep the turn busy', async () => {
  const call = await connected(), stopped = gate(); let yields = 0;
  replace(background, 'yieldBackgroundIndexing', () => { yields++; return stopped.promise; });
  event('user', 'Check the ', false);
  assert.equal(yields, 1);
  assert.equal(activity.backgroundIdle, false);
  before = NEXT;
  event('user', 'Check the export tests.');
  event('assistant', 'I will check the records.');
  assert.equal(live.liveHistory(syncId)[0].turns.length, 2, 'audio transcripts are retained without waiting for indexing');
  assert.equal(lookups.length, 0);
  await wait(450);
  assert.equal(requests().filter(item => item.method.endsWith('appendSpeech')).length, 0);
  assert.equal(activity.backgroundIdle, false);
  stopped.resolve();
  await until(() => requests().some(item => item.method.endsWith('appendSpeech')));
  await until(() => activity.backgroundIdle);
  assert.equal(lookups[0][1], BEFORE);
  assert.equal(live.liveHistory(syncId)[0].turns.filter(row => row.role === 'user').length, 1);
  assert.equal(conversation.conversationStatus(syncId).history_before, BEFORE);
});

test('old interrupted completion and lookup cannot release a newer answer owner; Stop waits for outstanding context delivery', async () => {
  const call = await connected();
  await live.sendLiveText(call.id, 'First question.', randomUUID());
  event('assistant', 'Old streaming reply ', false);
  const held = gate(); let count = 0;
  replace(context, 'historyContext', async (...args) => { lookups.push(args); return ++count === 1 ? held.promise : packet('Hnew'); });
  const older = live.sendLiveText(call.id, 'Second question.', randomUUID());
  await until(() => count === 1);
  const newer = live.sendLiveText(call.id, 'Third question.', randomUUID());
  await newer;
  event('assistant', 'Old streaming reply finished.');
  assert.equal(activity.backgroundIdle, false, 'old assistant completion belongs to its original message/turn');
  held.resolve(packet('Hstale')); await older;
  assert.equal(activity.backgroundIdle, false, 'old context completion cannot release new ownership');
  assert.ok(!requests().some(item => item.params?.text?.includes('Hstale')));
  event('assistant', 'The third answer is complete.'); await flush();
  assert.equal(activity.backgroundIdle, true);

  const appended = gate(); let appending = false;
  const original = replace(NativeVoice.prototype, 'context', async function (text) { appending = true; await original.call(this, text); await appended.promise; });
  const pending = live.sendLiveText(call.id, 'Fourth question.', randomUUID());
  await until(() => appending);
  await live.interruptLiveCall(call.id);
  assert.equal(activity.backgroundIdle, false, 'Stop does not release an in-flight append');
  appended.resolve(); await pending;
  assert.equal(activity.backgroundIdle, true);
});

test('only accepted real user turns refresh inactivity; request retries, typed echoes, stop-control echoes and assistant output do not', async () => {
  const call = await connected();
  let now = Date.now(); replace(Date, 'now', () => now);
  const userAt = () => conversation.conversationStatus(syncId).last_user_at;
  const initial = userAt(); now += 1000;
  const id = randomUUID(); await live.sendLiveText(call.id, 'Check the tests.', id);
  const typed = userAt(); assert.notEqual(typed, initial);
  now += 1000;
  await live.sendLiveText(call.id, 'Check the tests.', id);
  event('user', 'Check the ', false); event('user', 'tests.', false); event('user', 'Check the tests.');
  event('assistant', 'The tests passed.');
  live.liveEvents(call.id, 0); live.observeLiveAudio(call.id, live.liveHistory(syncId)[0].turns.at(-1).id, 10);
  assert.equal(userAt(), typed);
  now += 1000; await live.interruptLiveCall(call.id); await wait(30);
  assert.equal(userAt(), typed, 'Stop transport echo is control, not a second real utterance');
  now += 1000; event('user', 'Stop ', false);
  const spoken = userAt(); assert.notEqual(spoken, typed);
  now += 1000; event('user', 'Stop speaking.');
  assert.equal(userAt(), spoken, 'one spoken turn is touched once, not once per transcript part');
  const stopId = randomUUID(); now += 1000;
  await live.sendLiveText(call.id, 'Stop speaking.', stopId); const stop = userAt();
  now += 1000; await live.sendLiveText(call.id, 'Stop speaking.', stopId); await wait(30);
  assert.equal(userAt(), stop);
  assert.equal(lookups.length, 1, 'spoken/typed stops do not retrieve context');
  event('user', ''); assert.equal(userAt(), stop, 'empty transcript is not real activity');
});

test('idle conversation expiry closes through confirmed helper cleanup without review, notes changes or automatic reopening', async () => {
  const now = Date.now();
  getDb().prepare('UPDATE syncs SET conversation_last_user_at=? WHERE id=?').run(new Date(now - 29 * 60_000).toISOString(), syncId);
  const call = await connected(), closed = gate();
  const close = replace(NativeVoice.prototype, 'close', async function () { const result = await close.call(this); await closed.promise; return result; });
  replace(Date, 'now', () => now + 61_000);
  assert.equal(live.liveEvents(call.id, 0).active, false);
  assert.equal(activity.callActive, true);
  assert.equal(activity.backgroundIdle, false, 'closed-but-unconfirmed cleanup is never idle');
  assert.ok(conversation.conversationStatus(syncId).ended_at);
  closed.resolve(); await live.endLiveCall(call.id);
  assert.equal(activity.callActive, false);
  await assert.rejects(live.createLiveCall(syncId, signal()), error => error.status === 410);
  const row = getDb().prepare('SELECT status,decisions FROM syncs WHERE id=?').get(syncId);
  assert.deepEqual(row, { status: 'open', decisions: 'Original notes.' });
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
  assert.match(live.liveHistory(syncId)[0].end_reason, /inactivity/);
});

test('conversation inactivity waits for the in-flight reply, then expires without extending user time', async () => {
  const call = await connected();
  await live.sendLiveText(call.id, 'Check the tests.', randomUUID());
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  // Simulate a due conversation clock independently of the separate hard call cap.
  getDb().prepare('UPDATE syncs SET conversation_last_user_at=? WHERE id=?').run(old, syncId);
  event('assistant', 'Still explaining ', false);
  conversation.expireConversations();
  assert.equal(conversation.conversationStatus(syncId).ended_at, null);
  assert.equal(live.liveEvents(call.id, 0).active, true);
  event('assistant', 'The explanation is complete; deployment remains unverified.'); await flush();
  assert.equal(live.liveEvents(call.id, 0).active, false);
  await live.endLiveCall(call.id);
  assert.equal(conversation.conversationStatus(syncId).last_user_at, old);
  const messages = getDb().prepare('SELECT content,created_at FROM sync_messages WHERE sync_id=? ORDER BY id').all(syncId);
  assert.equal(messages.length, 2); assert.ok(messages.every(message => message.created_at));
  assert.match(messages[1].content, /explanation is complete/);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});

test('hard call time, turn count and heartbeat lease stay separate from active conversation expiry', async () => {
  const call = await connected(); let now = Date.now(); const started = call.startedAt;
  replace(Date, 'now', () => now);
  // Keep both real-user inactivity and transport lease current until the cap.
  for (let minute = 1; minute <= 29; minute++) {
    now = started + minute * 60_000;
    if (minute % 10 === 0 || minute === 29) { await live.sendLiveText(call.id, 'A real question.', randomUUID()); event('assistant', 'Recorded answer.'); }
    assert.equal(live.liveEvents(call.id, 0).active, true);
  }
  now = started + 30 * 60_000 + 1000;
  assert.equal(live.liveEvents(call.id, 0).active, false); await live.endLiveCall(call.id);
  assert.match(live.liveHistory(syncId)[0].end_reason, /Call time limit/);
  assert.equal(conversation.conversationStatus(syncId).ended_at, null);
  const next = await connected();
  for (let n = 0; n < 60; n++) { await live.sendLiveText(next.id, 'Question.', randomUUID()); event('assistant', 'Recorded answer.'); }
  await assert.rejects(live.sendLiveText(next.id, 'Over the limit.', randomUUID()), /turn limit/);
  await live.endLiveCall(next.id);
  assert.equal(conversation.conversationStatus(syncId).ended_at, null);
  const lost = await connected(); now += 91_000;
  assert.equal(live.liveEvents(lost.id, 0).active, false); await live.endLiveCall(lost.id);
  assert.equal(getDb().prepare('SELECT end_reason FROM live_calls WHERE id=?').get(lost.id).end_reason, 'Connection lost');
  assert.equal(conversation.conversationStatus(syncId).ended_at, null);
});

test('missing assistant completion keeps background blocked and ends through cleanup instead of declaring the call idle', async t => {
  const call = await connected(); let continued = 0;
  replace(NativeVoice.prototype, 'continueAnswer', async () => { continued++; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await live.sendLiveText(call.id, 'Check the tests.', randomUUID());
    t.mock.timers.tick(1500); await flush();
    assert.equal(continued, 1);
    assert.equal(activity.backgroundIdle, false);
    t.mock.timers.tick(45_000);
    assert.equal(live.liveEvents(call.id, 0).active, false);
    assert.equal(activity.backgroundIdle, false, 'failure retains the cleanup lease');
  } finally { t.mock.timers.reset(); }
  await live.endLiveCall(call.id);
  assert.equal(activity.backgroundIdle, true);
  assert.match(live.liveHistory(syncId)[0].end_reason, /completion was not confirmed/);
});

test('history update/retrieval failure supplies the existing honest empty qualification, never fabricated evidence or another provider', async () => {
  const call = await connected(); before = NEXT;
  replace(context, 'historyContext', async (...args) => { lookups.push(args); throw Error('Synthetic updated index failure'); });
  await live.sendLiveText(call.id, 'What changed?', randomUUID());
  assert.equal(lookups[0][1], NEXT);
  const appends = requests().filter(item => item.params?.role === 'developer');
  assert.match(appends[0].params.text, /Archive lookup failed or is busy/);
  assert.match(appends[0].params.text, /No other search mode or provider was substituted/);
  assert.ok(!live.liveEvents(call.id, 0).events.some(item => item.type === 'sources' && item.evidence.length));
  assert.equal(activity.backgroundIdle, false);
  event('assistant', 'Earlier history could not be checked.'); await flush();
  assert.equal(activity.backgroundIdle, true);
});

for (const stop of ['control', 'typed', 'spoken']) test(`${stop} Stop retains streaming assistant ownership until its final event`, async () => {
  const call = await connected();
  await live.sendLiveText(call.id, 'Check the tests.', randomUUID());
  event('assistant', 'Still explaining ', false);
  const assistantId = live.liveHistory(syncId)[0].turns.at(-1).id;
  if (stop === 'control') await live.interruptLiveCall(call.id);
  else if (stop === 'typed') await live.sendLiveText(call.id, 'Stop speaking.', randomUUID());
  else event('user', 'Stop speaking.');
  await flush();
  assert.equal(activity.backgroundIdle, false, 'Stop acknowledgement is not remote completion');
  event('assistant', 'after Stop.', false);
  assert.equal(activity.backgroundIdle, false, 'deltas reuse the still-owned message');
  assert.equal(activity.voiceTurnActive(syncId), true);
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  getDb().prepare('UPDATE syncs SET conversation_last_user_at=? WHERE id=?').run(old, syncId);
  conversation.expireConversations();
  assert.equal(conversation.conversationStatus(syncId).ended_at, null);
  assert.equal(live.liveEvents(call.id, 0).active, true);
  event('assistant', 'Still explaining after Stop.');
  assert.equal(activity.backgroundIdle, true);
  const assistant = live.liveHistory(syncId)[0].turns.find(row => row.id === assistantId);
  assert.equal(assistant.status, 'interrupted');
  assert.equal(assistant.answer, 'Still explaining after Stop.');
  assert.equal(conversation.conversationStatus(syncId).last_user_at, old);
  assert.equal(live.liveEvents(call.id, 0).active, false, 'expiry resumes only after final completion');
  await live.endLiveCall(call.id);
});

test('interrupted message deadline is fixed across repeated Stop and retains ownership until confirmed native cleanup', async t => {
  const call = await connected(), cleaned = gate();
  await live.sendLiveText(call.id, 'Check the tests.', randomUUID());
  event('assistant', 'Partial retained answer.', false);
  const assistantId = live.liveHistory(syncId)[0].turns.at(-1).id;
  const close = replace(NativeVoice.prototype, 'close', async function () { const result = await close.call(this); await cleaned.promise; return result; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await live.interruptLiveCall(call.id);
    t.mock.timers.tick(30_000);
    await live.interruptLiveCall(call.id);
    t.mock.timers.tick(14_999);
    assert.equal(live.liveEvents(call.id, 0).active, true);
    t.mock.timers.tick(1);
    assert.equal(live.liveEvents(call.id, 0).active, false);
    assert.equal(activity.backgroundIdle, false);
  } finally { t.mock.timers.reset(); }
  await wait(40);
  assert.equal(activity.callActive, true, 'timeout requests cleanup, never declares idle');
  assert.equal(activity.voiceTurnActive(syncId), true, 'local transcript finalization is not native completion');
  cleaned.resolve(); await live.endLiveCall(call.id);
  assert.equal(activity.backgroundIdle, true);
  assert.equal(activity.callActive, false);
  const history = live.liveHistory(syncId)[0];
  assert.match(history.end_reason, /Interrupted voice answer completion was not confirmed/);
  const assistant = history.turns.find(row => row.id === assistantId);
  assert.equal(assistant.answer, 'Partial retained answer.');
  assert.equal(assistant.status, 'interrupted');
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});

test('a finalized interrupted message cannot clear or time out a newer assistant owner', async t => {
  const call = await connected();
  await live.sendLiveText(call.id, 'First question.', randomUUID());
  event('assistant', 'Old answer ', false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await live.interruptLiveCall(call.id);
    t.mock.timers.tick(20_000);
    await live.sendLiveText(call.id, 'Next question.', randomUUID());
    event('assistant', 'Old answer finished.');
    assert.equal(activity.backgroundIdle, false);
    event('assistant', 'New answer ', false);
    t.mock.timers.tick(25_000);
    assert.equal(live.liveEvents(call.id, 0).active, true, 'old message deadline was retired, not transferred');
    assert.equal(activity.backgroundIdle, false);
    event('assistant', 'New answer finished.'); await flush();
    assert.equal(activity.backgroundIdle, true);
  } finally { t.mock.timers.reset(); }
});

test('assistant output first arriving after Stop acquires bounded interrupted-message ownership', async t => {
  const call = await connected();
  await live.sendLiveText(call.id, 'Check the tests.', randomUUID());
  await live.interruptLiveCall(call.id);
  assert.equal(activity.backgroundIdle, true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    event('assistant', 'Late output ', false);
    assert.equal(activity.backgroundIdle, false);
    t.mock.timers.tick(45_000);
    assert.equal(live.liveEvents(call.id, 0).active, false);
    assert.equal(activity.backgroundIdle, false);
  } finally { t.mock.timers.reset(); }
  await live.endLiveCall(call.id);
  assert.equal(activity.backgroundIdle, true);
  assert.equal(live.liveHistory(syncId)[0].turns.at(-1).status, 'interrupted');
});

test('Stop cannot retire a dispatched continuation append before its promise settles', async t => {
  const call = await connected(), appended = gate(); let continued = 0;
  replace(NativeVoice.prototype, 'continueAnswer', async () => { continued++; await appended.promise; });
  await live.sendLiveText(call.id, 'Check the tests.', randomUUID());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // Exercise the actual automatic continuation dispatch, not its callback in isolation.
    event('assistant', 'I will check the records.');
    t.mock.timers.tick(400); await flush();
    assert.equal(continued, 1);
    await live.interruptLiveCall(call.id);
    assert.equal(activity.backgroundIdle, false);
    assert.equal(activity.voiceTurnActive(syncId), true);
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    getDb().prepare('UPDATE syncs SET conversation_last_user_at=? WHERE id=?').run(old, syncId);
    conversation.expireConversations();
    assert.equal(conversation.conversationStatus(syncId).ended_at, null);
    const sequence = live.liveEvents(call.id, 0).events.at(-1).sequence;
    appended.resolve(); await flush();
    assert.equal(activity.backgroundIdle, true);
    assert.equal(live.liveEvents(call.id, sequence).events.filter(item => item.type === 'answer_pending').length, 0, 'late settlement does not revive cancelled state');
  } finally { t.mock.timers.reset(); }
  await live.endLiveCall(call.id);
});

test('late continuation settlement cannot retire a newer answer or its streaming message', async t => {
  const call = await connected(), appended = gate(); let continued = 0;
  replace(NativeVoice.prototype, 'continueAnswer', async () => { continued++; await appended.promise; });
  await live.sendLiveText(call.id, 'First question.', randomUUID());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    event('assistant', 'I will check the records.');
    t.mock.timers.tick(400); await flush(); assert.equal(continued, 1);
    await live.interruptLiveCall(call.id);
    await live.sendLiveText(call.id, 'Next question.', randomUUID());
    event('assistant', 'New answer ', false);
    const sequence = live.liveEvents(call.id, 0).events.at(-1).sequence;
    appended.resolve(); await flush();
    assert.equal(activity.backgroundIdle, false);
    assert.equal(live.liveEvents(call.id, sequence).events.length, 0);
    event('assistant', 'New answer finished.');
    assert.equal(activity.backgroundIdle, true);
    t.mock.timers.tick(45_000);
    assert.equal(live.liveEvents(call.id, 0).active, true);
  } finally { t.mock.timers.reset(); }
});

test('stalled continuation after Stop times out through native close before awaiting its drain', async t => {
  const call = await connected(), appended = gate(), cleaned = gate(); let continued = 0, closing = false;
  replace(NativeVoice.prototype, 'continueAnswer', async () => { continued++; await appended.promise; });
  const close = replace(NativeVoice.prototype, 'close', async function () {
    closing = true;
    const result = await close.call(this);
    // Like RPC teardown: this append cannot settle until native.close is invoked.
    appended.reject(Error('Synthetic RPC closed'));
    await cleaned.promise;
    return result;
  });
  await live.sendLiveText(call.id, 'Check the tests.', randomUUID());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    event('assistant', 'I will check the records.');
    t.mock.timers.tick(400); await flush(); assert.equal(continued, 1);
    await live.interruptLiveCall(call.id);
    t.mock.timers.tick(45_000);
    assert.equal(live.liveEvents(call.id, 0).active, false);
    assert.equal(activity.backgroundIdle, false);
  } finally { t.mock.timers.reset(); }
  await until(() => closing);
  await wait(40);
  assert.equal(activity.backgroundIdle, false, 'append rejection still requires helper-exit confirmation');
  cleaned.resolve(); await live.endLiveCall(call.id);
  assert.equal(activity.callActive, false);
  assert.equal(activity.backgroundIdle, true);
  assert.match(live.liveHistory(syncId)[0].end_reason, /continuation delivery was not confirmed/);
});

test('a continuation failure after Stop retains cleanup ownership despite cancelled continuation state', async t => {
  const call = await connected(), appended = gate(), cleaned = gate(); let continued = 0;
  replace(NativeVoice.prototype, 'continueAnswer', async () => { continued++; await appended.promise; });
  const close = replace(NativeVoice.prototype, 'close', async function () { const result = await close.call(this); await cleaned.promise; return result; });
  await live.sendLiveText(call.id, 'Check the tests.', randomUUID());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    event('assistant', 'I will check the records.');
    t.mock.timers.tick(400); await flush(); assert.equal(continued, 1);
    await live.interruptLiveCall(call.id);
    appended.reject(Error('Synthetic ambiguous append failure')); await flush();
    assert.equal(live.liveEvents(call.id, 0).active, false);
    assert.equal(activity.backgroundIdle, false);
  } finally { t.mock.timers.reset(); }
  await wait(40);
  assert.equal(activity.callActive, true);
  cleaned.resolve(); await live.endLiveCall(call.id);
  assert.equal(activity.backgroundIdle, true);
  assert.match(live.liveHistory(syncId)[0].end_reason, /continuation delivery failed/);
});

test('typed question append keeps ownership after Stop until successful settlement, without refreshing activity on retry', async () => {
  const call = await connected(), appended = gate(); let appending = false;
  const text = replace(NativeVoice.prototype, 'text', function (value) {
    if (value === 'Check the tests.') { appending = true; return appended.promise; }
    return text.call(this, value);
  });
  const id = randomUUID(), pending = live.sendLiveText(call.id, 'Check the tests.', id);
  await until(() => appending);
  await live.interruptLiveCall(call.id);
  assert.equal(activity.backgroundIdle, false);
  assert.equal(activity.voiceTurnActive(syncId), true);
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  getDb().prepare('UPDATE syncs SET conversation_last_user_at=? WHERE id=?').run(old, syncId);
  await live.sendLiveText(call.id, 'Check the tests.', id);
  conversation.expireConversations();
  assert.equal(conversation.conversationStatus(syncId).ended_at, null);
  assert.equal(conversation.conversationStatus(syncId).last_user_at, old);
  const sequence = live.liveEvents(call.id, 0).events.at(-1).sequence;
  appended.resolve(); await pending;
  assert.equal(activity.backgroundIdle, true);
  assert.equal(activity.voiceTurnActive(syncId), false);
  assert.ok(!live.liveEvents(call.id, sequence).events.some(item => item.type === 'answer_pending'));
  await live.endLiveCall(call.id);
});

test('stale typed append settlement cannot release the newer turn or renew its deadline', async t => {
  const call = await connected(), appended = gate(), started = gate();
  const text = replace(NativeVoice.prototype, 'text', function (value) {
    if (value === 'First question.') { started.resolve(); return appended.promise; }
    return text.call(this, value);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = live.sendLiveText(call.id, 'First question.', randomUUID());
    await started.promise;
    await live.interruptLiveCall(call.id);
    t.mock.timers.tick(20_000);
    await live.sendLiveText(call.id, 'Next question.', randomUUID());
    event('assistant', 'New answer ', false);
    appended.resolve(); await pending;
    assert.equal(activity.backgroundIdle, false);
    assert.equal(activity.voiceTurnActive(syncId), true);
    event('assistant', 'New answer finished.'); await flush();
    assert.equal(activity.backgroundIdle, true);
    t.mock.timers.tick(45_000);
    assert.equal(live.liveEvents(call.id, 0).active, true, 'settled operation cannot time out the new turn');
  } finally { t.mock.timers.reset(); }
});

for (const operation of ['question', 'context']) test(`${operation} append rejection after Stop closes and retains ownership until helper cleanup`, async () => {
  const call = await connected(), appended = gate(), cleaned = gate(); let appending = false, closing = false;
  const method = operation === 'question' ? 'text' : 'context';
  const original = replace(NativeVoice.prototype, method, function (value) {
    if (method === 'context' || value === 'Check the tests.') { appending = true; return appended.promise; }
    return original.call(this, value);
  });
  const close = replace(NativeVoice.prototype, 'close', async function () {
    closing = true; const result = await close.call(this); await cleaned.promise; return result;
  });
  const pending = live.sendLiveText(call.id, 'Check the tests.', randomUUID());
  await until(() => appending);
  await live.interruptLiveCall(call.id);
  appended.reject(Error('Synthetic ambiguous append failure')); await pending;
  await until(() => closing);
  assert.equal(live.liveEvents(call.id, 0).active, false);
  assert.equal(activity.backgroundIdle, false);
  assert.equal(activity.voiceTurnActive(syncId), true);
  assert.equal(activity.callActive, true);
  cleaned.resolve(); await live.endLiveCall(call.id);
  assert.equal(activity.backgroundIdle, true);
  assert.equal(activity.callActive, false);
  assert.match(live.liveHistory(syncId)[0].end_reason, new RegExp(`${operation} delivery failed`, 'i'));
});

for (const operation of ['question', 'context']) test(`${operation} deadline cannot be extended by repeated Stop; close precedes append drain`, async t => {
  const call = await connected(), appended = gate(), started = gate(), cleaned = gate(); let closing = false;
  const method = operation === 'question' ? 'text' : 'context';
  const original = replace(NativeVoice.prototype, method, function (value) {
    if (method === 'context' || value === 'Check the tests.') { started.resolve(); return appended.promise; }
    return original.call(this, value);
  });
  const close = replace(NativeVoice.prototype, 'close', async function () {
    closing = true; const result = await close.call(this);
    appended.reject(Error('Synthetic RPC teardown')); await cleaned.promise; return result;
  });
  let pending;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    pending = live.sendLiveText(call.id, 'Check the tests.', randomUUID());
    await started.promise;
    await live.interruptLiveCall(call.id);
    t.mock.timers.tick(30_000);
    await live.interruptLiveCall(call.id);
    t.mock.timers.tick(14_999);
    assert.equal(live.liveEvents(call.id, 0).active, true);
    t.mock.timers.tick(1);
    assert.equal(live.liveEvents(call.id, 0).active, false);
    assert.equal(activity.backgroundIdle, false);
  } finally { t.mock.timers.reset(); }
  await until(() => closing); await pending;
  assert.equal(activity.callActive, true);
  assert.equal(activity.voiceTurnActive(syncId), true);
  cleaned.resolve(); await live.endLiveCall(call.id);
  assert.equal(activity.backgroundIdle, true);
  assert.match(live.liveHistory(syncId)[0].end_reason, new RegExp(`${operation} delivery was not confirmed`, 'i'));
});

for (const operation of ['question', 'context', 'typed Stop', 'control Stop', 'open']) test(`cleanup tracks outstanding ${operation} even after confirmed native close`, async () => {
  const call = operation === 'open' ? await live.createLiveCall(syncId, signal()) : await connected();
  const appended = gate(); let dispatched = false, nativeClosed = false;
  const method = operation === 'open' ? 'open' : operation === 'context' ? 'context' : 'text';
  replace(NativeVoice.prototype, method, () => { dispatched = true; return appended.promise; });
  const close = replace(NativeVoice.prototype, 'close', async function () { const result = await close.call(this); nativeClosed = true; return result; });
  const pending = operation === 'open' ? live.connectLiveCall(call.id, 'v=0\r\nm=audio 9 test', signal()) :
    operation === 'control Stop' ? live.interruptLiveCall(call.id) :
    live.sendLiveText(call.id, operation === 'typed Stop' ? 'Stop speaking.' : 'Check the tests.', randomUUID());
  // open is expected to reject after End, regardless of its late native result.
  const settled = pending.then(() => null, error => error);
  await until(() => dispatched);
  let ended = false;
  const ending = live.endLiveCall(call.id).then(() => { ended = true; });
  await until(() => nativeClosed); await flush();
  assert.equal(ended, false, 'helper exit alone cannot retire an outstanding operation promise');
  assert.equal(activity.backgroundIdle, false);
  assert.equal(activity.callActive, true);
  appended.resolve('v=0'); await ending;
  const error = await settled;
  if (operation === 'open') assert.match(error.message, /could not connect/);
  else assert.equal(error, null);
  assert.equal(activity.callActive, false);
  assert.equal(activity.backgroundIdle, true);
});

for (const operation of ['typed Stop', 'control Stop', 'open']) test(`stalled ${operation} has a bounded cleanup deadline`, async t => {
  const call = operation === 'open' ? await live.createLiveCall(syncId, signal()) : await connected();
  const appended = gate(), started = gate();
  replace(NativeVoice.prototype, operation === 'open' ? 'open' : 'text', () => { started.resolve(); return appended.promise; });
  const close = replace(NativeVoice.prototype, 'close', async function () {
    const result = await close.call(this); appended.reject(Error('Synthetic RPC teardown')); return result;
  });
  let settled;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = operation === 'open' ? live.connectLiveCall(call.id, 'v=0\r\nm=audio 9 test', signal()) :
      operation === 'control Stop' ? live.interruptLiveCall(call.id) : live.sendLiveText(call.id, 'Stop speaking.', randomUUID());
    settled = pending.then(() => assert.fail('Stopped native operation must fail'), error => error);
    await started.promise;
    t.mock.timers.tick(44_999);
    assert.equal(live.liveEvents(call.id, 0).active, true);
    t.mock.timers.tick(1);
    assert.equal(live.liveEvents(call.id, 0).active, false);
    assert.equal(activity.backgroundIdle, false);
  } finally { t.mock.timers.reset(); }
  await live.endLiveCall(call.id); await settled;
  assert.equal(activity.callActive, false);
  assert.equal(activity.backgroundIdle, true);
  assert.match(live.liveHistory(syncId)[0].end_reason, /(?:Stop delivery|Live voice setup) was not confirmed/);
});

for (const finalImmediately of [false, true]) test(`late assistant preempts actual preparation and owns retirement independently (immediate final: ${finalImmediately})`, async () => {
  const call = await connected();
  await live.sendLiveText(call.id, 'Check the tests.', randomUUID());
  await live.interruptLiveCall(call.id);
  const indexing = await heldIndexer();
  event('assistant', 'Late output ', false);
  assert.equal(indexing.signal.aborted, true, 'transcript reception cancels preparation synchronously');
  assert.equal(indexing.retired, false);
  assert.equal(activity.backgroundIdle, false);
  if (finalImmediately) event('assistant', 'Late output finished.');
  await flush();
  assert.equal(live.liveHistory(syncId)[0].turns.at(-1).answer, finalImmediately ? 'Late output finished.' : 'Late output ', 'transcripts never wait for worker exit');
  assert.equal(activity.backgroundIdle, false, 'even final transcript cannot retire the worker lease');
  indexing.exited.resolve(); await indexing.job; await flush();
  assert.equal(activity.backgroundIdle, finalImmediately);
  if (!finalImmediately) event('assistant', 'Late output finished.');
  await flush(); assert.equal(activity.backgroundIdle, true);
  assert.equal(indexing.preparations, 1);
});

for (const operation of ['control Stop', 'typed Stop', 'typed question', 'spoken question']) test(`${operation} cancels actual preparation immediately and waits for exit before native dispatch`, async () => {
  const call = await connected(), indexing = await heldIndexer();
  let appends = 0;
  replace(NativeVoice.prototype, 'text', async () => { appends++; });
  replace(NativeVoice.prototype, 'context', async () => { appends++; });
  const pending = operation === 'control Stop' ? live.interruptLiveCall(call.id) : operation === 'spoken question' ?
    event('user', 'Check the records.') : live.sendLiveText(call.id, operation === 'typed Stop' ? 'Stop speaking.' : 'Check the records.', randomUUID());
  assert.equal(indexing.signal.aborted, true);
  await flush();
  assert.equal(appends, 0); assert.equal(lookups.length, 0);
  assert.equal(activity.backgroundIdle, false);
  indexing.exited.resolve(); await indexing.job; await pending;
  if (operation === 'spoken question') await until(() => appends > 0);
  assert.ok(appends > 0);
  if (operation.endsWith('question')) event('assistant', 'The records are retained.');
  await flush(); assert.equal(activity.backgroundIdle, true);
});

test('idle End cancels actual preparation immediately, closes native first, and retains ownership until background exit', async () => {
  const call = await connected(), indexing = await heldIndexer();
  let nativeClosed = false, ended = false;
  const close = replace(NativeVoice.prototype, 'close', async function () { const result = await close.call(this); nativeClosed = true; return result; });
  const ending = live.endLiveCall(call.id).then(() => { ended = true; });
  assert.equal(indexing.signal.aborted, true);
  await until(() => nativeClosed);
  assert.equal(indexing.retired, false); assert.equal(ended, false);
  assert.equal(activity.callActive, true); assert.equal(activity.backgroundIdle, false);
  assert.equal((await live.liveStatus()).state, 'cleanup_pending');
  await assert.rejects(live.createLiveCall(syncId, signal()), /End the existing call/);
  indexing.exited.resolve(); await indexing.job; await ending;
  assert.equal(activity.callActive, false); assert.equal(activity.backgroundIdle, true);
});

test('reservation preempts actual preparation without waiting; setup cannot open before background exit', async () => {
  fs.writeFileSync(path.join(process.env.DRAKEN_CODEX_HOME, 'scenario.txt'), 'controlled');
  const indexing = await heldIndexer(), call = await live.createLiveCall(syncId, signal());
  assert.equal(indexing.signal.aborted, true); assert.equal(indexing.retired, false);
  let opens = 0;
  const open = replace(NativeVoice.prototype, 'open', function (...args) { opens++; return open.apply(this, args); });
  const connecting = live.connectLiveCall(call.id, 'v=0\r\nm=audio 9 test', signal());
  await flush(); assert.equal(opens, 0); assert.equal(activity.backgroundIdle, false);
  indexing.exited.resolve(); await indexing.job; await connecting;
  assert.equal(opens, 1); assert.equal(activity.backgroundIdle, true);
});

test('repeated Stop cannot extend a background-blocked native deadline or dispatch after End', async t => {
  const call = await connected(), indexing = await heldIndexer();
  let appends = 0, nativeClosed = false;
  replace(NativeVoice.prototype, 'text', async () => { appends++; });
  const close = replace(NativeVoice.prototype, 'close', async function () { const result = await close.call(this); nativeClosed = true; return result; });
  let first, second;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    first = assert.rejects(live.interruptLiveCall(call.id), /remote stop could not be confirmed/);
    assert.equal(indexing.signal.aborted, true);
    t.mock.timers.tick(30_000);
    second = assert.rejects(live.interruptLiveCall(call.id), /remote stop could not be confirmed/);
    t.mock.timers.tick(14_999); assert.equal(live.liveEvents(call.id, 0).active, true);
    t.mock.timers.tick(1); assert.equal(live.liveEvents(call.id, 0).active, false);
  } finally { t.mock.timers.reset(); }
  await until(() => nativeClosed);
  assert.equal(indexing.retired, false); assert.equal(appends, 0);
  assert.equal(activity.backgroundIdle, false);
  indexing.exited.resolve(); await indexing.job;
  await Promise.all([first, second, live.endLiveCall(call.id)]);
  assert.equal(appends, 0, 'closed guard runs after background wait');
  assert.equal(activity.backgroundIdle, true);
  assert.match(live.liveHistory(syncId)[0].end_reason, /Stop delivery was not confirmed/);
});

test('instant-final late assistant retains a fixed background retirement deadline across repeated Stop', async t => {
  const call = await connected(), indexing = await heldIndexer();
  let first, second;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    event('assistant', 'Late complete answer.');
    assert.equal(indexing.signal.aborted, true);
    t.mock.timers.tick(20_000);
    first = assert.rejects(live.interruptLiveCall(call.id), /remote stop could not be confirmed/);
    t.mock.timers.tick(20_000);
    second = assert.rejects(live.interruptLiveCall(call.id), /remote stop could not be confirmed/);
    t.mock.timers.tick(4_999); assert.equal(live.liveEvents(call.id, 0).active, true);
    t.mock.timers.tick(1); assert.equal(live.liveEvents(call.id, 0).active, false);
    assert.equal(activity.backgroundIdle, false);
  } finally { t.mock.timers.reset(); }
  assert.match(live.liveHistory(syncId)[0].end_reason, /Background cleanup was not confirmed/);
  indexing.exited.resolve(); await indexing.job;
  await Promise.all([first, second, live.endLiveCall(call.id)]);
  assert.equal(activity.backgroundIdle, true);
});

test('failed background retirement stays fail-closed even after scheduler and native helper exit', () => {
  // A deliberately unconfirmed owner is terminal. Isolate it so teardown cannot
  // fake a release merely to let later tests create calls.
  fs.writeFileSync(path.join(process.env.DRAKEN_CODEX_HOME, 'scenario.txt'), 'controlled');
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', `
    require('./tests/fixtures/fake-memory.cjs');
    const assert = require('node:assert/strict');
    const { closeDb } = require('./dist/db/schema');
    const { activity } = require('./dist/sync/activity');
    const background = require('./dist/sync/background');
    const memory = require('./dist/memory/service');
    const live = require('./dist/voice/live');
    (async () => {
      const signal = () => new AbortController().signal;
      const call = await live.createLiveCall(${syncId}, signal());
      await live.connectLiveCall(call.id, 'v=0\\r\\nm=audio 9 test', signal());
      let exit, entered, preparationSignal;
      const started = new Promise(resolve => { entered = resolve; });
      const exiting = new Promise(resolve => { exit = resolve; });
      const worker = background.createAutoIndexer({
        enabled: () => true, idle: () => activity.backgroundIdle, now: Date.now,
        activeConversations: () => true, scan: async () => ({ warnings: [] }),
        baseline: () => new Map(), stamp: () => new Map([['new', 'changed']]),
        prepare: async (_before, signal) => { preparationSignal = signal; entered(); await exiting; },
        completed: () => assert.fail('Cancelled work must not complete'),
      });
      background.yieldBackgroundIndexing = () => worker.stop();
      const job = worker.tick(); await started;
      let serviceOwned = true;
      memory.historyProgress = () => ({ background: serviceOwned });
      memory.stopHistory = () => { serviceOwned = false; return Promise.reject(Error('Unconfirmed background child exit')); };
      const stopped = live.interruptLiveCall(call.id);
      assert.equal(preparationSignal.aborted, true);
      await assert.rejects(stopped, /remote stop could not be confirmed/);
      exit(); await job;
      await assert.rejects(live.endLiveCall(call.id), /Unconfirmed background child exit/);
      assert.equal(activity.callActive, true); assert.equal(activity.backgroundIdle, false);
      assert.equal((await live.liveStatus()).state, 'cleanup_pending');
      await assert.rejects(live.createLiveCall(${syncId}, signal()), /End the existing call/);
      await assert.rejects(live.stopLiveCalls(), /cleanup remains unconfirmed/);
      assert.equal(activity.callActive, true);
      closeDb(); console.log('BACKGROUND_FAIL_CLOSED_CHECKED');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'BACKGROUND_FAIL_CLOSED_CHECKED');
});

test('late assistant retirement cannot release a newer turn; foreground history is never stopped', async () => {
  const call = await connected();
  await live.interruptLiveCall(call.id);
  const indexing = await heldIndexer();
  event('assistant', 'Late answer.');
  const newer = live.sendLiveText(call.id, 'A newer question.', randomUUID());
  assert.equal(indexing.signal.aborted, true);
  replace(memory, 'historyProgress', () => ({ active: true, background: false }));
  replace(memory, 'stopHistory', () => assert.fail('Foreground history must not be stopped'));
  indexing.exited.resolve(); await indexing.job; await newer;
  assert.equal(activity.backgroundIdle, false, 'old worker retirement cannot retire the new reply');
  event('assistant', 'The newer answer is complete.'); await flush();
  assert.equal(activity.backgroundIdle, true);
});

test('call cleanup awaits an outstanding continuation after native close and ignores late transcript events', async t => {
  const call = await connected(), appended = gate(); let continued = 0, nativeClosed = false;
  replace(NativeVoice.prototype, 'continueAnswer', async () => { continued++; await appended.promise; });
  const close = replace(NativeVoice.prototype, 'close', async function () { const result = await close.call(this); nativeClosed = true; return result; });
  await live.sendLiveText(call.id, 'Check the tests.', randomUUID());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    event('assistant', 'I will check the records.');
    t.mock.timers.tick(400); await flush(); assert.equal(continued, 1);
  } finally { t.mock.timers.reset(); }
  let ended = false;
  const ending = live.endLiveCall(call.id).then(() => { ended = true; });
  await until(() => nativeClosed); await flush();
  assert.equal(ended, false, 'native close runs before the independently owned append drain');
  assert.equal(activity.callActive, true);
  assert.equal(activity.backgroundIdle, false);
  const sequence = live.liveEvents(call.id, 0).events.at(-1).sequence;
  event('assistant', 'Late ignored output.');
  appended.resolve(); await ending;
  assert.equal(activity.callActive, false);
  assert.equal(live.liveEvents(call.id, sequence).events.length, 0);
  assert.ok(!live.liveHistory(syncId)[0].turns.some(row => row.answer === 'Late ignored output.'));
});
