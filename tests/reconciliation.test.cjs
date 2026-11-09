// Synthetic status transitions, never private developer histories.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { getDb, closeDb } = require('../dist/db/schema');
const { HistoryIndex } = require('../dist/memory/index');
const { historyPacket } = require('../dist/memory/context');
const { reconciliationGaps } = require('../dist/sync/reconciliation');
const { voiceHistoryQuery } = require('../dist/voice/history-focus');
const { sourceEntry } = require('./fixtures/source-entry.cjs');
let root, db, cache, index;
const cutoff = '2026-01-08T13:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-reconciliation-'));
  process.env.DRAKEN_DATA_DIR = path.join(root, 'state'); process.env.DRAKEN_PI_SESSIONS_DIR = path.join(root, 'sessions');
  db = getDb(); cache = new Database(':memory:');
  index = new HistoryIndex(cache, db, { fingerprint: 'synthetic-reconciliation', ready: () => true, setup: async () => {},
    embed: async () => { const v = new Float32Array(384); v[0] = 1; return v; } });
});
afterEach(() => { cache.close(); closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
const add = (text, timestamp, session = 'trailboard', role = 'assistant') => sourceEntry(db, process.env.DRAKEN_PI_SESSIONS_DIR, text,
  { session, timestamp, role, name: session === 'trailboard' ? 'Trailboard iOS rewrite' : 'Beacon service', cwd: '/projects/' + session });
const ref = position => cache.prepare('SELECT ref FROM records WHERE position=? AND group_id=?').get(position, 'session:trailboard').ref;
async function timeline() {
  const old = add('Push coordinator checkpoint.\nStill unfinished: app logout/deletion integration, permission/token/tap/badge callbacks, durable backend delivery jobs and migration/device acceptance. Real push disabled.', '2026-01-06T17:32:00.000Z');
  add('The feature is not finished. Implemented core pieces only.\n\nWhat remains:\n\n| Piece | State |\n| permission/token/tap/badge callbacks, logout/deletion | Not wired into the app yet |\n| durable backend delivery jobs | Unfinished |', '2026-01-06T18:00:00.000Z');
  const client = add('Client wiring implemented.\n- APNs adapters and permission/token/tap/badge callbacks implemented.\n- Startup, logout and deletion integration completed.\n- Device consent and reconnect controls added.\nReported 353 tests. Backend delivery and device acceptance still gated; live registration disabled.', '2026-01-06T19:27:00.000Z');
  add('Most screens are implemented.\n\n### Actual implementation work left\n\n| Area | Remaining work |\n| durable backend delivery jobs | Connect the pipeline; client wiring is present, but job creation is unfinished |\n| migration/device acceptance | Still unfinished |', '2026-01-06T19:47:00.000Z');
  const jobs = add('Durable backend delivery jobs implemented locally.\nAtomic inbox/job creation, leases, crash recovery, retry and expiry fencing implemented. Migration tests reported passing.\nLive delivery remains disabled: dispatcher, fresh binding checks, receipts and device/provider acceptance are unfinished.', '2026-01-06T20:18:00.000Z');
  const latest = add('Latest notification checkpoint: client wiring and durable backend delivery jobs exist. Notification dispatcher and reminder serving still unfinished. Device/provider acceptance remains outstanding. This is not end-to-end delivery completion.', '2026-01-08T12:13:00.000Z');
  add('Client theme colors implemented, native app tests passed. No statement about notification delivery.', '2026-01-08T12:30:00.000Z');
  add('Push logout/deletion permission/token/tap/badge callbacks and durable backend delivery jobs all finished in Beacon; device/provider acceptance passed.', '2026-01-08T12:40:00.000Z', 'beacon');
  add('FUTURE: all push callbacks, backend delivery jobs and migration/device acceptance finished.', '2026-01-08T14:00:00.000Z');
  await index.prepare({ before: cutoff });
  return { old: ref(old), client: ref(client), jobs: ref(jobs), latest: ref(latest) };
}
test('a status question reconciles client completion, durable foundations and unfinished delivery without corpus writes', async () => {
  const ids = await timeline();
  const changes = cache.prepare('SELECT total_changes() n').get().n;
  const plan = voiceHistoryQuery(db, `Where we are at Trailboard iOS rewrite? How long will it take and what's still blocked? ${ids.old}`);
  assert.equal(plan.query.recent, true);
  const found = await index.search({ ...plan.query, before: cutoff, reconcile: true }, undefined, true);
  const thread = found.reconciliation.threads.find(item => item.earlier_ref === ids.old);
  assert.ok(thread); assert.ok(thread.later_refs.includes(ids.client)); assert.ok(thread.later_refs.includes(ids.jobs)); assert.ok(thread.later_refs.includes(ids.latest));
  const packet = historyPacket(found, 24000, 3000), body = JSON.parse(packet.text);
  assert.ok(Buffer.byteLength(packet.text) <= 24000);
  for (const id of Object.values(ids)) assert.ok(packet.refs.includes(id));
  assert.ok(body.sources.every(item => item.session_id === 'trailboard' && item.at <= cutoff));
  assert.match(packet.text, /Client wiring implemented/); assert.match(packet.text, /Durable backend delivery jobs implemented locally/);
  assert.match(packet.text, /dispatcher and reminder serving still unfinished/); assert.doesNotMatch(packet.text, /FUTURE|all finished in Beacon/);
  assert.equal(cache.prepare('SELECT total_changes() n').get().n, changes);
  assert.deepEqual(reconciliationGaps(Object.values(ids).map(id => `[${id}]`).join(' '), packet), []);
  assert.ok(reconciliationGaps(`Old wiring still missing [${ids.old}]`, packet).length);
});
test('packet byte pressure never keeps a cited old blocker without its selected follow-ups', async () => {
  const ids = await timeline();
  const found = await index.search({ question: `Current blocked status ${ids.old}`, reconcile: true, kind: 'sources', session_ids: ['trailboard'], before: cutoff }, undefined, true);
  for (const bytes of [3500, 5000, 7000, 24000]) {
    const packet = historyPacket(found, bytes, bytes > 7000 ? 3000 : 1200), body = JSON.parse(packet.text);
    assert.ok(Buffer.byteLength(packet.text) <= bytes);
    for (const thread of found.reconciliation.threads) if (packet.refs.includes(thread.earlier_ref)) {
      assert.ok(thread.later_refs.every(id => packet.refs.includes(id)), 'Never drop the correction while retaining its old anchor');
    }
    for (const thread of body.reconciliation.threads) assert.ok([thread.earlier_ref, ...thread.later_refs].every(id => packet.refs.includes(id)));
  }
});
test('closing qualifications survive clipping as separate original-offset excerpts', () => {
  const old = 'H' + 'a'.repeat(24), later = 'H' + 'b'.repeat(24);
  const full = 'Client callbacks implemented. ' + 'Detailed implementation report. '.repeat(60) + '\nDelivery remains disabled; no device acceptance.';
  const found = { mode: 'hybrid', limitations: 'Synthetic.', results: [
    { ref: later, kind: 'session', role: 'assistant', text: full, offset: 0, at: cutoff, sequence: 2 },
    { ref: old, kind: 'session', role: 'assistant', text: 'Client callbacks remain unfinished.', offset: 0, at: cutoff, sequence: 1 },
  ], reconciliation: { checked_narratives: 2, omitted_narratives: 0, omitted_threads: 0, threads: [{ earlier_ref: old, later_refs: [later], matched_terms: ['callbacks'], other_candidates: 0 }], qualification: 'Candidate, not verified supersession.' } };
  const packet = historyPacket(found, 3500, 800), body = JSON.parse(packet.text), update = body.sources.find(item => item.ref === later);
  assert.match(update.text, /Client callbacks implemented/); assert.match(update.ending.text, /Delivery remains disabled/);
  assert.equal(update.ending.text, full.slice(update.ending.offset));
});
test('source sequence beats a skewed clock, and later plans remain plans rather than a computed completion state', async () => {
  const old = add('Export signing remains blocked: receipt validation and retry fencing are pending.', '2026-01-07T12:00:00.000Z');
  const later = add('Plan for export signing: implement receipt validation and retry fencing next. No implementation or test execution occurred.', '2026-01-06T12:00:00.000Z');
  await index.prepare({ before: cutoff });
  const found = await index.search({ question: `Is this still blocked ${ref(old)}`, reconcile: true, kind: 'sources', session_ids: ['trailboard'], before: cutoff }, undefined, true);
  assert.ok(found.reconciliation.threads.find(item => item.earlier_ref === ref(old)).later_refs.includes(ref(later)));
  const packet = historyPacket(found, 7000, 1200); assert.match(packet.text, /No implementation or test execution occurred/);
  assert.match(packet.text, /Not exhaustive or verified supersession/); assert.ok(!('completed' in found.reconciliation));
});
test('an original H status question searches for updates, while an offset read remains an explicit read', async () => {
  const ids = await timeline(); const service = require('../dist/memory/service');
  const saved = { searchPreparedHistory: service.searchPreparedHistory, readHistory: service.readHistory }; let searches = 0, reads = 0;
  service.searchPreparedHistory = query => { searches++; return index.search(query, undefined, true); };
  service.readHistory = (id, offset, _signal, before) => { reads++; return index.read(id, offset, before); };
  try {
    const selection = { kind: 'sources', session_ids: ['trailboard'] };
    const result = await require('../dist/memory/context').historyContext(`Is ${ids.old} still blocked?`, cutoff, undefined, 24000, true, selection);
    assert.ok(result.refs.includes(ids.client)); assert.equal(searches, 1); assert.equal(reads, 0);
    await require('../dist/memory/context').historyContext(`${ids.old} offset 30`, cutoff, undefined, 7000, true, selection);
    assert.equal(reads, 1); assert.equal(searches, 1);
  } finally { Object.assign(service, saved); }
});
test('the citation guard also catches old frozen E/C aliases; an unrelated alias cannot satisfy it', async () => {
  const ids = await timeline(), found = await index.search({ question: `Current blockers ${ids.old}`, reconcile: true, kind: 'sources', session_ids: ['trailboard'], before: cutoff }, undefined, true);
  const packet = historyPacket(found, 24000, 3000), body = JSON.parse(packet.text), earlier = body.sources.find(item => item.ref === ids.old);
  const aliases = [{ ref: 'E7', session: earlier.session_id, sequence: earlier.sequence }];
  assert.ok(reconciliationGaps('Still missing [E7]', packet, aliases).length);
  assert.deepEqual(reconciliationGaps('Still missing [E7]', packet, [{ ...aliases[0], session: 'beacon' }]), []);
  const citations = Object.values(ids).map(id => `[${id}]`).join(' ');
  assert.deepEqual(reconciliationGaps(citations + ' [E7]', packet, aliases), []);
});
test('a retrieved follow-up is checked again when its own pending sub-task was completed later', async () => {
  const old = add('Permission callbacks and account cleanup remain unfinished. The app integration is blocked.', '2026-01-06T12:00:00.000Z');
  const client = add('Implemented permission callbacks and account cleanup.\n\nRemaining: durable backend delivery jobs are unfinished. Provider activation remains disabled.', '2026-01-06T14:00:00.000Z');
  const jobs = add('Implemented durable backend delivery jobs: atomic inbox creation, leases and bounded retries.\n\nDelivery remains disabled; shared dispatcher implementation is still pending.', '2026-01-06T16:00:00.000Z');
  await index.prepare({ before: cutoff });
  const records = [...index.current.values()], seed = records.find(record => record.ref === ref(old));
  const found = require('../dist/memory/reconcile').reconcileHistory(records, [{ ...seed, offset: 0, score: 1 }], { question: 'Current status', kind: 'sources', reconcile: true, before: cutoff });
  assert.ok(found.reconciliation.threads.some(thread => thread.earlier_ref === ref(client) && thread.later_refs.includes(ref(jobs))));
  const packet = historyPacket({ ...found, mode: 'hybrid', limitations: 'Synthetic.' }, 32000, 3000);
  assert.match(packet.text, /Implemented permission callbacks/); assert.match(packet.text, /Implemented durable backend delivery jobs/); assert.match(packet.text, /shared dispatcher implementation is still pending/);
});
test('voice carries the same expanded evidence and later-update graph as chat without truncating it into a handoff', async () => {
  const ids=await timeline();
  const service=require('../dist/memory/service'),saved=service.searchPreparedHistory;
  const {historyContext,DISCUSSION_HISTORY_BYTES}=require('../dist/memory/context');
  const {historyDelivery}=require('../dist/voice/history-delivery');
  const changes=cache.prepare('SELECT total_changes() n').get().n;
  service.searchPreparedHistory=query=>{assert.equal(query.reconcile,true);return index.search(query,undefined,true);};
  try {
    const query=voiceHistoryQuery(db,`Is ${ids.old} still the current blocked status in Trailboard?`).query;
    const packet=await historyContext(query.question,cutoff,undefined,DISCUSSION_HISTORY_BYTES,true,query);
    const delivery=historyDelivery(packet,17);
    const recovered=delivery.contexts.length===1?delivery.contexts[0].slice(delivery.contexts[0].indexOf('\n')+1):delivery.contexts.slice(0,-1).map(text=>JSON.parse(text.slice(text.indexOf('\n')+1)).fragment).join('');
    assert.equal(recovered,packet.text);
    for(const ref of Object.values(ids))assert.ok(JSON.parse(delivery.receipt).refs.includes(ref));
    assert.match(recovered,/Client wiring implemented/);assert.match(recovered,/Durable backend delivery jobs implemented locally/);
    assert.match(recovered,/dispatcher and reminder serving still unfinished/);assert.doesNotMatch(recovered,/FUTURE|all finished in Beacon/);
    assert.ok(JSON.parse(recovered).reconciliation.threads.length);
    assert.equal(cache.prepare('SELECT total_changes() n').get().n,changes);
  } finally {service.searchPreparedHistory=saved;}
  assert.throws(()=>service.validateHistoryQuery({question:'Status',reconcile:'yes'}),/Invalid reconciliation/);
});
test('a deliberate long original-reference read still includes requested tool-call text', () => {
  const source = { ref: 'H' + 'a'.repeat(24), kind: 'session', role: 'assistant', text: 'Inspecting the plan.\nTool requested: read /demo/Trailboard/plan.md', offset: 0, at: cutoff };
  assert.match(historyPacket({ mode: 'reference_read', results: [source], limitations: 'Explicit source read.' }, 32000, 4000).text, /Tool requested: read/);
  assert.doesNotMatch(historyPacket({ mode: 'hybrid', results: [source], limitations: 'Work search.' }, 32000, 3000).text, /Tool requested: read/);
});
