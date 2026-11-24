require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const { getDb, closeDb } = require('../dist/db/schema');
const { scanSessions } = require('../dist/sync/collector');
const store = require('../dist/sync/store');
const { SummaryTree } = require('../dist/sync/tree');
const { generateReply } = require('../dist/sync/manager');
const { LUNA_BATCH } = require('../dist/sync/summary-budget');
const { sourceKey } = require('../dist/sync/normalize');
const { activity } = require('../dist/sync/activity');
const live = require('../dist/voice/live');
const calls = require('../dist/sync/model-call');
let originalModelCall;
let root, file, syncId, bg, native, requests, statusHook, openHook, contextHook, closeHook, finalCalls, originalCall, originalLoad;
const signal = () => new AbortController().signal;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class SyntheticNative {
  constructor(options) { this.options = options; native = this; }
  subscribe(listener) { this.emit = listener; return () => {}; }
  async open(_sdp, options) { await openHook?.(); options.onReady?.(); requests.push(['open', options]); return 'synthetic SDP'; }
  async context(text) { requests.push(['context', text]); await contextHook?.(); }
  async text(text) { requests.push(['text', text]); }
  async continueAnswer(text) { requests.push(['continue', text]); }
  async close() { await closeHook?.(); return { helperExited: true }; }
}
beforeEach(() => {
  closeDb(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-live-scope-'));
  Object.assign(process.env, { DRAKEN_DATA_DIR: path.join(root, 'db'), DRAKEN_PI_SESSIONS_DIR: path.join(root, 'sessions'), DRAKEN_VOICE_MODE: 'native',
    DRAKEN_PI_SUMMARY_MODEL: 'openai/gpt-6-luna', DRAKEN_PI_FINAL_MODEL: 'openai/gpt-6-astra' });
  getDb().prepare("INSERT INTO sync_settings VALUES('activity_days','null')").run();
  fs.mkdirSync(process.env.DRAKEN_PI_SESSIONS_DIR); file = path.join(process.env.DRAKEN_PI_SESSIONS_DIR, 'scope.jsonl');
  const rows = [{ type: 'session', version: 3, id: 'scope', cwd: '/synthetic/old', timestamp: '2026-01-01T00:00:00.000Z' }];
  for (let n = 0; n < 3; n++) rows.push({ type: 'message', id: `m${n}`, parentId: n ? `m${n - 1}` : null,
    timestamp: `2026-01-01T00:00:0${n}.000Z`, message: { role: 'assistant', content: [{ type: 'text', text: `Original ${n}: deployment NOT verified.` }] } });
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  requests = []; finalCalls = 0; native = statusHook = openHook = contextHook = closeHook = undefined;
  originalLoad = Module._load;
  Module._load = function (name, ...args) {
    if (name.endsWith('/voice/realtime/native.mjs')) return { NativeVoice: SyntheticNative, nativeStatus: async () => { await statusHook?.(); return { readyForProbe: true }; } };
    return originalLoad.call(this, name, ...args);
  };
  originalModelCall = calls.modelCall;
  calls.modelCall = async payload => { assert.equal(payload.task, 'select_evidence'); return '{"scope":"project","selected":[]}'; };
  originalCall = SummaryTree.prototype.call;
  SummaryTree.prototype.call = async payload => { assert.equal(payload.task, 'final_verdict', 'no new summary/model preparation'); finalCalls++; return 'Still unverified [R1].'; };
});
afterEach(async () => {
  await live.stopLiveCalls(); Module._load = originalLoad; SummaryTree.prototype.call = originalCall; calls.modelCall = originalModelCall;
  closeDb(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.DRAKEN_VOICE_MODE;
});
async function prepared(initial = false) {
  await scanSessions(); const first = store.startSync(); syncId = first.id; bg = first.items[0];
  const encoded = getDb().prepare('SELECT evidence_json FROM sync_items WHERE sync_id=? AND event_key=?').get(syncId, bg.event_key).evidence_json;
  getDb().prepare('DELETE FROM sync_items WHERE sync_id=? AND event_key=?').run(syncId, bg.event_key);
  if (initial) getDb().prepare('UPDATE syncs SET context_json=? WHERE id=?').run(JSON.stringify([{ ...JSON.parse(encoded), ref: 'C1' }]), syncId);
  const current = store.getSync(syncId), seed = new SummaryTree(current, 0, signal());
  const spec = seed.leafSpec({ session: current.items[0].session_id, workspace: current.items[0].cwd, evidence: current.items, background: initial ? current.context : [bg] }, true);
  const output = JSON.stringify({ observations: [{ topic: 'Synthetic', state: 'blocked', summary: 'Not verified.', evidence: [spec.sources[0]] }], limitations: [] });
  getDb().prepare('INSERT INTO summary_cache VALUES (?,?,?,?,?,?)').run(spec.key, 'chunk', current.models.summary, LUNA_BATCH.version, output, new Date().toISOString());
  const leaves = seed.leafStore(); leaves.save(spec.key, current.models.summary, seed.leafRecipe(true), true, leaves.encode(spec.leafInput), output); leaves.close();
  await generateReply(syncId);
  const result = store.getSync(syncId);
  assert.equal(finalCalls, 1); assert.equal(result.context.length, 1); assert.equal(result.context[0].ref, 'C1');
  assert.deepEqual(JSON.parse(getDb().prepare('SELECT refs_json FROM summary_planning_context WHERE sync_id=?').get(syncId).refs_json), initial ? ['C1'] : []);
  assert.ok(result.briefing && result.tree.complete && result.conversation.history_before);
  assert.ok(!JSON.parse(output).observations[0].evidence.includes(sourceKey(bg)), 'uncited dependency really adopted');
  return result;
}
async function edit(target = 'm0') {
  fs.appendFileSync(file, JSON.stringify({ type: 'context_edit', id: `edit-${target}`, parentId: 'm2', timestamp: '2026-01-03T00:00:00.000Z', targetId: target, replacement: 'Conflicting newer projection.' }) + '\n');
  await scanSessions();
}
async function connected() { const call = await live.createLiveCall(syncId, signal()); await live.connectLiveCall(call.id, 'synthetic SDP', signal()); return call; }
function event(role, text, done = true) { native.emit({ method: `thread/realtime/transcript/${done ? 'done' : 'delta'}`, params: { role, [done ? 'text' : 'delta']: text } }); }

for (const reopen of [false, true]) test(`live rejects actual adopted BG after edit before native status (reopen=${reopen})`, async () => {
  const before = await prepared(); await edit(); if (reopen) closeDb();
  let probes = 0; statusHook = () => { probes++; };
  await assert.rejects(live.createLiveCall(syncId, signal()), /unavailable|changed|excluded/);
  assert.equal(probes, 0); assert.deepEqual(requests, []); assert.equal(finalCalls, 1);
  const after = store.getSync(syncId); assert.equal(after.briefing, before.briefing); assert.deepEqual(after.context, before.context);
  assert.equal(activity.callActive, false); assert.equal(getDb().prepare('SELECT count(*) n FROM sync_coverage').get().n, 0);
});
test('adopted BG revoked during native status is rejected before reservation', async () => {
  await prepared(); statusHook = edit;
  await assert.rejects(live.createLiveCall(syncId, signal()), /unavailable|changed|excluded/);
  assert.deepEqual(requests, []); assert.equal(activity.callActive, false);
});
test('adopted BG revoked after reservation cannot reach open or its initial context', async () => {
  await prepared(); const call = await live.createLiveCall(syncId, signal()); await edit();
  await assert.rejects(live.connectLiveCall(call.id, 'synthetic SDP', signal()), /could not connect/);
  assert.deepEqual(requests, []); assert.equal(activity.callActive, false);
  await assert.rejects(live.sendLiveText(call.id, 'Explain C1', randomUUID()), /ended/);
});
test('native setup await cannot deliver stale adopted BG in the initial realtime packet', async () => {
  await prepared(); const call = await live.createLiveCall(syncId, signal()); openHook = edit;
  await assert.rejects(live.connectLiveCall(call.id, 'synthetic SDP', signal()), /could not connect/);
  assert.deepEqual(requests, [], 'ready hook precedes initial packet delivery inside open');
  assert.equal(activity.callActive, false);
});

test('revocation during a native context append cannot return a ready handoff receipt', async () => {
  await prepared(); const call = await connected(); await live.sendLiveText(call.id, 'Explain C1', randomUUID());
  contextHook = async () => { contextHook = undefined; await edit(); };
  await assert.rejects(native.options.answer([{ role: 'user', content: 'Read C1 in more detail' }], signal()), /unavailable|changed|excluded/);
  await live.endLiveCall(call.id); assert.equal(activity.callActive, false);
});

for (const boundary of ['typed', 'audio', 'requested context', 'after context before text', 'continuation'])
  test(`active adopted BG revocation blocks ${boundary} and holds ownership until helper exit`, async () => {
    const before = await prepared(), call = await connected();
    if (boundary === 'requested context' || boundary === 'continuation') await live.sendLiveText(call.id, 'Explain C1', randomUUID());
    event('assistant', 'Already spoken qualification. ', false);
    if (boundary === 'continuation') event('assistant', 'Let me check that.');
    const exit = deferred(); closeHook = () => exit.promise;
    let offset = requests.length;
    try {
      if (boundary === 'after context before text') {
        contextHook = async () => { offset = requests.length; contextHook = undefined; await edit(); };
        await live.sendLiveText(call.id, 'Explain C1', randomUUID());
      } else {
        await edit();
        if (boundary === 'typed') await assert.rejects(live.sendLiveText(call.id, 'Explain C1', randomUUID()), /unavailable|changed|excluded/);
        if (boundary === 'audio') event('user', 'Spoken question about C1');
        if (boundary === 'requested context') await assert.rejects(native.options.answer('C1', signal()), /unavailable|changed|excluded|superseded/);
        if (boundary === 'continuation') {
          await new Promise(resolve => setTimeout(resolve, 1700));
        }
      }
      await tick();
      assert.equal(live.liveEvents(call.id, 0).active, false);
      assert.deepEqual(requests.slice(offset), [], 'zero new native request boundaries after revocation');
      assert.equal(activity.callActive, true, 'native cleanup still owns the call');
      assert.ok(live.liveHistory(syncId)[0].turns.some(row => /Already spoken|Let me check/.test(row.answer)));
      if (boundary === 'audio') assert.ok(live.liveHistory(syncId)[0].turns.some(row => row.question === 'Spoken question about C1'));
      const after = store.getSync(syncId); assert.equal(after.briefing, before.briefing); assert.deepEqual(after.context, before.context);
    } finally { exit.resolve(); await live.endLiveCall(call.id); }
    assert.equal(activity.callActive, false);
  });

test('each live boundary freshly reads originals once, without stacked full-snapshot rereads', async () => {
  await prepared();
  const { EvidenceReader } = require('../dist/db/evidence'), project = EvidenceReader.prototype.project, close = EvidenceReader.prototype.close;
  let reads = 0; const readers = new Set();
  EvidenceReader.prototype.project = function (...args) { reads++; readers.add(this); return project.apply(this, args); };
  EvidenceReader.prototype.close = function () { readers.delete(this); return close.call(this); };
  try {
    const call = await live.createLiveCall(syncId, signal());
    assert.equal(reads, 6, 'three originals once on each side of nativeStatus await'); assert.equal(readers.size, 0);
    reads = 0; await live.connectLiveCall(call.id, 'synthetic SDP', signal());
    assert.equal(reads, 6, 'one fresh physical gate before open, one after helper setup before the initial packet'); assert.equal(readers.size, 0);
    reads = 0; await live.sendLiveText(call.id, 'Explain C1', randomUUID());
    assert.equal(reads, 9, 'admission plus fresh context and text dispatch, not three reads at each gate'); assert.equal(readers.size, 0);
  } finally { EvidenceReader.prototype.project = project; EvidenceReader.prototype.close = close; }
});

test('initial E and original planning C retain selected views through edit, catalog advance and reopen', async () => {
  const before = await prepared(true); await edit(); await edit('m1');
  getDb().prepare('UPDATE agent_sessions SET cwd=? WHERE id=?').run('/advanced/catalog', 'scope');
  getDb().prepare('UPDATE agent_entries SET active=0,present=0 WHERE session_id=?').run('scope'); closeDb();
  const call = await connected(); await live.sendLiveText(call.id, 'Explain C1 and E2', randomUUID());
  assert.deepEqual(requests.map(row => row[0]), ['open', 'context', 'text']);
  assert.match(JSON.stringify(requests), /Original 0: deployment NOT verified/);
  assert.doesNotMatch(JSON.stringify(requests), /Conflicting newer projection/);
  assert.deepEqual(store.getSync(syncId).context, before.context); assert.equal(finalCalls, 1);
});
for (const initial of [false, true]) for (const revocation of ['session', 'agent', 'missing', 'changed'])
  test(`live preserves ingested content but applies permission changes: ${revocation} (initial C=${initial})`, async () => {
    await prepared(initial);
    if (revocation === 'session') store.setIncluded('scope', false);
    if (revocation === 'agent') getDb().prepare("UPDATE agent_sources SET enabled=0 WHERE id='pi'").run();
    if (revocation === 'missing') fs.unlinkSync(file);
    if (revocation === 'changed') fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('deployment NOT verified', 'deployment WAS verified'));
    if (revocation === 'session' || revocation === 'agent') {
      await assert.rejects(live.createLiveCall(syncId, signal()), /unavailable|changed|excluded/);
      assert.deepEqual(requests, []); assert.equal(activity.callActive, false);
    } else {
      const call = await live.createLiveCall(syncId, signal()); assert.ok(call.id);
    }
  });
