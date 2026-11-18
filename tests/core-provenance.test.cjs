// Append-only preparation contract. Real SQLite/JSONL, synthetic provider only.
require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { getDb, closeDb } = require('../dist/db/schema');
const { scanSessions } = require('../dist/sync/collector');
const store = require('../dist/sync/store');
const { EvidenceReader, withEvidenceRef } = require('../dist/db/evidence');
const { SummaryTree } = require('../dist/sync/tree');
const { generateReply, launchReply } = require('../dist/sync/manager');
const { prepareCall } = require('../dist/sync/preparation');
const { sourceKey } = require('../dist/sync/normalize');
let root, file, calls, originalCall;
beforeEach(() => {
  closeDb(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-append-only-')); fs.mkdirSync(root + '/sessions');
  Object.assign(process.env, { DRAKEN_DATA_DIR: root + '/state', DRAKEN_PI_SESSIONS_DIR: root + '/sessions',
    DRAKEN_PI_BIN: '/no-provider-permitted', DRAKEN_PI_SUMMARY_MODEL: 'openai/gpt-6-luna', DRAKEN_PI_FINAL_MODEL: 'openai/gpt-6-astra' });
  file = root + '/sessions/source.jsonl';
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'append-only', cwd: '/synthetic', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
  calls = []; originalCall = SummaryTree.prototype.call;
  SummaryTree.prototype.call = async payload => {
    calls.push(payload);
    if (payload.task === 'sync_recap') return JSON.stringify({ lines: ['Synthetic project history.', 'No saved decisions.', 'Deployment remains unverified.'] });
    return payload.task === 'final_verdict' ? 'Synthetic report [R1].' : JSON.stringify({ observations: [
      { topic: 'Synthetic', state: 'blocked', summary: 'Not independently verified.', evidence: [payload.allowed_source_ids[0]] }], limitations: [] });
  };
});
afterEach(() => { SummaryTree.prototype.call = originalCall; closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
async function append(start, count) {
  for (let n = start; n < start + count; n++) fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'm' + n,
    parentId: n ? 'm' + (n - 1) : null, timestamp: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    message: { role: n ? 'assistant' : 'user', content: 'Original source ' + n + ': deployment was not verified.' } }) + '\n');
  await scanSessions();
}
async function prepared() { await append(0, 20); const sync = store.startSync(); await generateReply(sync.id); return store.getSync(sync.id); }
function treeFor(sync) {
  const id = Number(getDb().prepare(`INSERT INTO sync_runs(sync_id,summary_model,final_model,max_invocations,total_entries,started_at)
    VALUES (?,?,?,?,?,?)`).run(sync.id, sync.models.summary, sync.models.final, 10, sync.items.length, new Date().toISOString()).lastInsertRowid);
  return new SummaryTree(sync, id, new AbortController().signal);
}

test('a completed tree uses saved receipts without reopening originals at planning, node or final boundaries', async t => {
  const sync = await prepared(), tree = treeFor(sync), before = calls.length;
  t.mock.method(EvidenceReader.prototype, 'project', () => { throw Error('Cached tree must not reopen originals'); });
  await tree.beforePreparation(); const roots = await tree.build(); await tree.beforeFinal(); tree.verifyFinal();
  assert.ok(roots.length); assert.equal(calls.length, before);
});

test('append summarizes only the new tail and keeps completed roots without an unnecessary overview request', async () => {
  const first = await prepared(), oldKeys = first.tree.nodes.filter(node => node.kind === 'chunk').map(node => node.key);
  getDb().prepare('UPDATE syncs SET conversation_ended_at=? WHERE id=?').run(new Date().toISOString(), first.id);
  await append(20, 2); const second = store.startConversationSync('synthetic-append'), before = calls.length;
  await generateReply(second.id); const delta = calls.slice(before), chunks = delta.filter(call => call.stage === 'chunk');
  assert.equal(chunks.length, 1); assert.equal(chunks[0].input.evidence.length, 2);
  assert.equal(delta.filter(call => call.stage === 'overview').length, 0);
  assert.equal(delta.filter(call => call.task === 'final_verdict').length, 1);
  const result = store.getSync(second.id); assert.equal(result.items.length, 22);
  assert.ok(oldKeys.every(key => result.tree.nodes.some(node => node.key === key)));
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM sync_coverage').get().n, 0);
});

test('source exclusion still revokes a cached tree without reading the source files', async t => {
  const sync = await prepared(), tree = treeFor(sync); await tree.build();
  t.mock.method(EvidenceReader.prototype, 'project', () => { throw Error('No whole-archive reread'); });
  store.setIncluded('append-only', false);
  assert.throws(() => tree.verifyFinal(), /excluded/);
});

test('reference aliases preserve their selected pointer without changing the original label or rereading bytes', async t => {
  const sync = await prepared(), original = sync.items[0], alias = withEvidenceRef(original, 'C99');
  const reader = new EvidenceReader(getDb());
  try {
    t.mock.method(EvidenceReader.prototype, 'project', () => { throw Error('Aliasing must not reopen originals'); });
    const a = JSON.parse(reader.freeze(original)), b = JSON.parse(reader.freeze(alias));
    assert.equal(original.ref, 'E1'); assert.equal(alias.ref, 'C99');
    assert.deepEqual(a.source_pointer, b.source_pointer); assert.equal(a.source_key, b.source_key);
  } finally { reader.close(); }
});

test('memoized source keys still change when a caller actually changes an input object', async () => {
  const sync = await prepared(), item = { ...sync.items[0] }, first = sourceKey(item);
  item.text += ' changed'; assert.notEqual(sourceKey(item), first);
  item.text = sync.items[0].text; assert.equal(sourceKey(item), first);
  item.event_key += '-other'; assert.notEqual(sourceKey(item), first);
});

test('a newly captured snapshot is handed to preparation without reopening its originals', async t => {
  await append(0, 20);
  t.mock.method(EvidenceReader.prototype, 'project', () => { throw Error('The captured inputs must not be reread'); });
  const sync = store.startConversationSync('synthetic-shared-snapshot');
  launchReply(sync.id, undefined, sync);
  for (let n = 0; n < 1000 && store.getSync(sync.id, false).busy; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(store.getProgress(sync.id).run.status, 'completed');
});

test('ready background history is adopted without a foreground reindex or snapshot reload', async t => {
  const sync = await prepared(), memory = require('../dist/memory/service');
  getDb().prepare('UPDATE syncs SET conversation_before=NULL WHERE id=?').run(sync.id);
  t.mock.method(memory, 'prepareHistory', async () => { throw Error('Completed background history must be reused'); });
  t.mock.method(EvidenceReader.prototype, 'project', () => { throw Error('History admission must not reload frozen evidence'); });
  const result = prepareCall(sync.id);
  assert.ok(result.conversation.history_before); assert.deepEqual(result.items, []); assert.deepEqual(result.context, []);
});
