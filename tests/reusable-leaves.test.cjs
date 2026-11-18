require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getDb, closeDb } = require('../dist/db/schema');
const { scanSessions } = require('../dist/sync/collector');
const store = require('../dist/sync/store');
const { SummaryTree, summaryPreparationKey } = require('../dist/sync/tree');
const { generateReply, cancelReply } = require('../dist/sync/manager');
const { sourceKey, digest } = require('../dist/sync/normalize');
const { LUNA_BATCH } = require('../dist/sync/summary-budget');
const frozen = require('./fixtures/summary-cache.cjs');
const LUNA = 'openai/gpt-6-luna', FINAL = 'openai/gpt-6-astra';
let temp, root, log, control;
beforeEach(() => {
  closeDb(); temp = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-reuse-')); root = path.join(temp, 'sessions'); fs.mkdirSync(root);
  const fake = path.join(temp, 'pi'); fs.copyFileSync(path.join(__dirname, 'fixtures/fake-pi.cjs'), fake); fs.chmodSync(fake, 0o700);
  log = path.join(temp, 'calls.jsonl'); control = path.join(temp, 'control.json'); fs.writeFileSync(control, '{}');
  Object.assign(process.env, { DRAKEN_DATA_DIR: path.join(temp, 'state'), DRAKEN_PI_SESSIONS_DIR: root, DRAKEN_PI_BIN: fake,
    DRAKEN_PI_SUMMARY_MODEL: LUNA, DRAKEN_PI_FINAL_MODEL: FINAL, DRAKEN_FAKE_CONTROL: control, DRAKEN_TEST_CALL_LOG: log });
  delete process.env.DRAKEN_PI_MAX_INVOCATIONS;
});
afterEach(() => { closeDb(); fs.rmSync(temp, { recursive: true, force: true }); });
const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function session(count, width = 100) {
  const id = randomUUID(), file = path.join(root, id + '.jsonl');
  const data = { id, file, rows: [], width };
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, cwd: '/synthetic/' + id, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
  append(data, count); return data;
}
function append(data, count) {
  const start = data.rows.length;
  for (let n = start; n < start + count; n++) {
    const row = { type: 'message', id: `${data.id}-${n}`, parentId: n ? `${data.id}-${n - 1}` : null,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
      message: { role: n ? 'assistant' : 'user', content: [{ type: 'text', text: `SOURCE_${n}: deployment NOT verified. ${'x'.repeat(data.width)}` }] } };
    data.rows.push(row); fs.appendFileSync(data.file, JSON.stringify(row) + '\n');
  }
}
async function start() { await scanSessions(); return store.startSync(); }
function expire() { getDb().exec("UPDATE syncs SET conversation_last_user_at='2020-01-01T00:00:00.000Z'"); }
function background(input) {
  const keys = input.items.map(item => [digest(JSON.stringify([item.agent || 'pi', item.session_id, item.entry_id])),
    digest(JSON.stringify([sourceKey(item), item.agent, item.session_id, item.cwd, item.timestamp, item.role]))]);
  const id = Number(getDb().prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,input_key,source_keys_json)
    VALUES (?,?,?,?,?,?,?)`).run(input.models.summary, input.models.final, input.models.max_invocations, input.items.length,
    new Date().toISOString(), summaryPreparationKey(input), JSON.stringify({ keys, recipe: summaryPreparationKey({ ...input, items: [] }) })).lastInsertRowid);
  return { id, tree: SummaryTree.forBackground(input, id, new AbortController().signal) };
}
function completeBackground(job) {
  getDb().prepare("UPDATE background_runs SET status='completed',completed_at=?,cache_receipt_json=? WHERE id=?")
    .run(new Date().toISOString(), JSON.stringify(job.tree.cacheReceipt()), job.id);
}
async function plan(sync) { const tree = new SummaryTree(sync, 0, new AbortController().signal); try { return await tree.batchSpecs(); } finally { tree.leaves?.close(); } }
function assertCoverage(sync, specs) {
  assert.deepEqual(new Set(specs.flatMap(spec => spec.sources)), new Set(sync.items.map(sourceKey)));
  assert.equal(getDb().prepare('SELECT count(*) n FROM sync_coverage').get().n, 0);
  assert.equal(store.pendingCount(), sync.items.length);
}
function primaryCallsSince(index) { return calls().slice(index).filter(call => call.stage === 'chunk').flatMap(call => call.input.evidence.map(item => [call.input.session, item.sequence])); }

for (const deployed of [false, true]) test(`expired unreviewed snapshots combine with append: every old partial leaf survives (${deployed ? 'deployed output-only backfill' : 'durable receipts'})`, async () => {
  const data = session(17); const first = await start(); await generateReply(first.id);
  append(data, 5); await scanSessions(); const second = store.startConversationSync(randomUUID()); assert.equal(second.items.length, 5); await generateReply(second.id);
  const oldKeys = getDb().prepare("SELECT key FROM summary_cache WHERE kind='chunk'").all().map(row => row.key); assert.equal(oldKeys.length, 2);
  if (deployed) getDb().exec('DELETE FROM summary_leaf_inputs');
  expire(); append(data, 3); const third = await start(); assert.equal(third.items.length, 25);
  // Different E labels and a process/db restart cannot change paid-work identity.
  for (const row of getDb().prepare('SELECT event_key,evidence_json FROM sync_items WHERE sync_id=?').all(third.id)) {
    const value = JSON.parse(row.evidence_json); value.ref = `E${10000 + Number(value.ref.slice(1))}`;
    getDb().prepare('UPDATE sync_items SET evidence_json=? WHERE sync_id=? AND event_key=?').run(JSON.stringify(value), third.id, row.event_key);
  }
  closeDb(); const current = store.getSync(third.id), specs = await plan(current);
  assertCoverage(current, specs); assert.ok(oldKeys.every(key => specs.some(spec => spec.key === key)));
  const before = calls().length, result = await generateReply(current.id);
  assert.deepEqual(primaryCallsSince(before), current.items.slice(-3).map(item => [item.session_id, item.sequence]));
  assert.equal(result.tree.run.processed_entries, 25);
  assert.equal(getDb().prepare('SELECT count(*) n FROM summary_leaf_inputs').get().n, 3);
  assert.equal(getDb().prepare("SELECT value FROM sync_settings WHERE key='auto_summary'").get()?.value || 'false', 'false');
  assert.equal(calls().slice(before).filter(call => call.stage === 'overview').length, 0, 'small tails fit beside saved roots without another merge');
  expire(); const same = await start(); const cached = calls().length; await generateReply(same.id);
  assert.equal(calls().length - cached, 1, 'unchanged parent and leaves require only the new final answer');
});

for (const deployed of [false, true]) test(`interleaved completed batches retain their full original inputs (${deployed ? 'legacy recovery' : 'receipts'})`, async () => {
  session(12); const current = await start();
  for (const parity of [0, 1]) {
    const job = background({ ...current, items: current.items.filter((_, index) => index % 2 === parity) });
    await job.tree.build(); completeBackground(job);
  }
  if (deployed) getDb().exec('DELETE FROM summary_leaf_inputs; DELETE FROM summary_leaf_plans');
  const before = calls().length, specs = await plan(current);
  assertCoverage(current, specs);
  assert.ok(specs.every(spec => spec.reuseOnly), 'newly interleaved entries do not invalidate unchanged complete batch inputs');
  const result = await generateReply(current.id);
  assert.deepEqual(primaryCallsSince(before), [], 'no old primary record is sent for leaf processing again');
  assert.equal(result.tree.run.processed_entries, current.items.length);
});

test('output-only v3 plus deployed legacy islands are reconstructed using original boundaries, not current chunks', async () => {
  const data = session(170, 700), first = await start();
  const legacy = [...new SummaryTree(first, 0, new AbortController().signal).chunkSpecs(false).values()].flat();
  const small = legacy[0], source = small.payload.evidence.at(-1);
  const summary = { observations: [{ topic: 'Old small batch', state: 'blocked', summary: 'Deployment NOT verified.', evidence: [source.id] }], limitations: [] };
  getDb().prepare('INSERT INTO summary_cache VALUES (?,?,?,?,?,?)').run(small.key, 'chunk', LUNA, 'sync-tree-v2-short-labels', JSON.stringify(summary), '2025-01-01T00:00:00.000Z');
  await generateReply(first.id); const keys = getDb().prepare("SELECT key FROM summary_cache WHERE kind='chunk'").all().map(row => row.key);
  getDb().exec('DELETE FROM summary_leaf_inputs'); expire(); append(data, 11); const next = await start();
  const specs = await plan(next); assertCoverage(next, specs); assert.ok(keys.every(key => specs.some(spec => spec.key === key)));
  const before = calls().length; await generateReply(next.id);
  assert.deepEqual(primaryCallsSince(before), next.items.slice(-11).map(item => [item.session_id, item.sequence]));
});

for (const cache of frozen.caches) test(`${cache.version} deployed partial tails survive changed current boundaries`, async () => {
  process.env.DRAKEN_PI_SUMMARY_MODEL = cache.model;
  const file = path.join(root, 'frozen.jsonl'); fs.writeFileSync(file, frozen.records.map(JSON.stringify).join('\n') + '\n');
  const first = await start();
  getDb().prepare('INSERT INTO summary_cache VALUES (?,?,?,?,?,?)').run(cache.key, 'chunk', cache.model, cache.version, JSON.stringify(frozen.output), '2025-01-01T00:00:00.000Z');
  await generateReply(first.id); assert.equal(primaryCallsSince(0).length, 0);
  getDb().exec('DELETE FROM summary_leaf_inputs');
  if (cache.version === 'sync-tree-v1') getDb().prepare("DELETE FROM summary_cache WHERE kind='chunk' AND key!=?").run(cache.key);
  fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'new-tail', parentId: frozen.records.at(-1).id,
    timestamp: '2026-01-03T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'NEW DATA: Deployment still NOT verified.' }] } }) + '\n');
  expire(); const next = await start(), before = calls().length; await generateReply(next.id);
  assert.deepEqual(primaryCallsSince(before), next.items.slice(-1).map(item => [item.session_id, item.sequence]));
  assert.equal(store.getProgress(next.id).run.processed_entries, 3);
});

for (const cancelled of [false, true]) test(`old background-only output cache is backfilled without sync nodes (cancelled=${cancelled})`, async () => {
  const data = session(71); await scanSessions(); const input = store.previewSummaryInput(), job = background(input);
  await job.tree.build(); completeBackground(job); const old = getDb().prepare("SELECT key FROM summary_cache WHERE kind='chunk'").get().key;
  if (cancelled) getDb().prepare("UPDATE background_runs SET status='cancelled',cache_receipt_json='[]' WHERE id=?").run(job.id);
  getDb().exec('DELETE FROM summary_leaf_inputs');
  assert.equal(getDb().prepare('SELECT count(*) n FROM syncs').get().n, 0); assert.equal(getDb().prepare('SELECT count(*) n FROM sync_tree_nodes').get().n, 0);
  append(data, 9); const sync = await start(), before = calls().length; const specs = await plan(sync);
  assertCoverage(sync, specs); assert.ok(specs.some(spec => spec.key === old));
  await generateReply(sync.id); assert.deepEqual(primaryCallsSince(before), sync.items.slice(-9).map(item => [item.session_id, item.sequence]));
});

test('cancelled deployed run retains its completed leaves after expiry and new data', async () => {
  session(8); session(9); const first = await start(); fs.writeFileSync(control, JSON.stringify({ delay: 180 }));
  const pending = generateReply(first.id), rejected = assert.rejects(pending, /cancelled/);
  for (let n = 0; n < 250 && store.getProgress(first.id).run.processed_entries === 0; n++) await new Promise(resolve => setTimeout(resolve, 10));
  cancelReply(first.id); await rejected;
  const completed = getDb().prepare("SELECT key FROM summary_cache WHERE kind='chunk'").all(); assert.equal(completed.length, 1);
  const original = (await plan(store.getSync(first.id))).find(spec => spec.key === completed[0].key).sources;
  getDb().exec('DELETE FROM summary_leaf_inputs'); expire(); session(2); const next = await start(); fs.writeFileSync(control, '{}');
  const before = calls().length; await generateReply(next.id);
  const requested = new Set(primaryCallsSince(before).map(JSON.stringify));
  for (const item of next.items.filter(item => original.includes(sourceKey(item)))) assert.ok(!requested.has(JSON.stringify([item.session_id, item.sequence])));
  assert.equal(store.getProgress(next.id).run.processed_entries, 19); assertCoverage(next, await plan(next));
});

test('full background dependencies omitted by citations remain verified, persisted, and citation-resolvable', async () => {
  const data = session(10); const first = await start(); await generateReply(first.id); store.completeSync(first.id, '', '', true);
  append(data, 4); const second = await start(); assert.equal(second.context.length, 6);
  await generateReply(second.id); const old = getDb().prepare("SELECT key FROM summary_cache WHERE kind='chunk' ORDER BY rowid DESC LIMIT 1").get().key;
  const qualified = { observations: [
    { topic: 'Original background qualification', state: 'blocked', summary: 'Earlier deployment was NOT verified.', evidence: [sourceKey(second.context[0])] },
    { topic: 'New activity', state: 'reported_done', summary: 'Work reported; deployment remains unverified.', evidence: [sourceKey(second.items.at(-1))] },
  ], limitations: [] };
  getDb().prepare('UPDATE summary_cache SET output_json=? WHERE key=?').run(JSON.stringify(qualified), old);
  getDb().exec('DELETE FROM summary_leaf_inputs');
  // Synthetic current snapshot omits old context; the verified receipt must
  // restore ALL six dependencies, not just the model's single primary citation.
  expire(); const next = await start(); getDb().prepare("UPDATE syncs SET context_json='[]' WHERE id=?").run(next.id);
  const before = calls().length; await generateReply(next.id); assert.equal(primaryCallsSince(before).length, 0);
  const restored = store.getSync(next.id); assert.equal(restored.context.length, 6); assert.ok(restored.context.every(item => !item.unavailable));
  const final = calls().at(-1);
  assert.ok(final.verification_evidence.some(item => item.background && item.text.includes('NOT verified')));
  assert.match(restored.briefing, /Earlier deployment was NOT verified/);
  assert.ok(final.summary_tree.flatMap(node => node.observations).some(item => item.background_only));
  const receipt = JSON.parse(getDb().prepare('SELECT input_json FROM summary_leaf_inputs WHERE key=?').get(old).input_json);
  assert.equal(receipt.background.length, 6); assert.ok(receipt.background.every(item => item.source_pointer && !Object.hasOwn(item, 'text')));
  assert.equal(store.getProgress(next.id).run.processed_entries, 4);
});

for (const scope of ['E', 'C']) for (const attribution of ['cwd', 'sequence'])
  test(`same-key cached BG cannot shadow frozen ${scope} with different ${attribution}`, async () => {
    session(4); const original = await start();
    if (scope === 'C') {
      const row = getDb().prepare('SELECT evidence_json FROM sync_items WHERE sync_id=? AND event_key=?').get(original.id, original.items[0].event_key);
      const context = { ...JSON.parse(row.evidence_json), ref: 'C1' };
      getDb().prepare('DELETE FROM sync_items WHERE sync_id=? AND event_key=?').run(original.id, original.items[0].event_key);
      getDb().prepare('UPDATE syncs SET context_json=? WHERE id=?').run(JSON.stringify([context]), original.id);
    }
    const sync = store.getSync(original.id), bg = scope === 'C' ? sync.context[0] : sync.items[0];
    const altered = { ...bg, [attribution]: attribution === 'cwd' ? '/new/model/workspace' : (bg.sequence || 0) + 1000 };
    if (attribution === 'cwd') getDb().prepare('UPDATE agent_sessions SET cwd=? WHERE id=?').run(altered.cwd, altered.session_id);
    // Same canonical identity and physical original, different model input.
    // The selected frozen E/C is still legitimate; the new BG is strict.
    assert.equal(sourceKey(altered), sourceKey(bg));
    const seed = new SummaryTree(sync, 0, new AbortController().signal);
    const spec = seedLeaf(seed, sync.items.slice(-2), [altered]); seed.leaves.close();
    const planned = await plan(store.getSync(sync.id));
    assert.ok(!planned.some(value => value.key === spec.key && value.reuseOnly), 'must not reuse and silently drop the uncited, differently attributed dependency');
    assert.equal(store.getSync(sync.id).context.length, scope === 'C' ? 1 : 0);
    assert.equal(calls().length, 0);
  });

test('source edits invalidate only the affected complete batch, never an unchanged other session', async () => {
  const edited = session(7), stable = session(8), first = await start(); await generateReply(first.id);
  const stableKeys = new Set(first.items.filter(item => item.session_id === stable.id).map(sourceKey));
  // A context edit preserves originals but changes the effective projection.
  fs.appendFileSync(edited.file, JSON.stringify({ type: 'context_edit', id: 'edit', parentId: edited.rows.at(-1).id,
    timestamp: '2026-01-02T00:00:00.000Z', targetId: edited.rows[0].id, replacement: 'CORRECTION: tests were NOT run.' }) + '\n');
  expire(); const next = await start(), before = calls().length; await generateReply(next.id);
  assert.ok(primaryCallsSince(before).length > 0);
  assert.ok(primaryCallsSince(before).every(([session]) => session === edited.id));
  assert.ok((await plan(next)).some(spec => spec.sources.every(key => stableKeys.has(key))));
  assertCoverage(next, await plan(next));
});

for (const corruption of ['output', 'changed-valid-output', 'recipe', 'model']) test(`${corruption} incompatibility never trusts a completed receipt; invalidation stays local`, async () => {
  session(6); session(7); const sync = await start(); await generateReply(sync.id);
  const leaf = getDb().prepare('SELECT * FROM summary_leaf_inputs ORDER BY rowid LIMIT 1').get(), input = JSON.parse(leaf.input_json);
  if (corruption === 'output') getDb().prepare("UPDATE summary_cache SET output_json='{}' WHERE key=?").run(leaf.key);
  else if (corruption === 'changed-valid-output') {
    const output = JSON.parse(getDb().prepare('SELECT output_json FROM summary_cache WHERE key=?').get(leaf.key).output_json);
    output.observations[0].summary = 'CORRUPTED: fabricated validated deployment';
    getDb().prepare('UPDATE summary_cache SET output_json=? WHERE key=?').run(JSON.stringify(output), leaf.key);
  }
  else if (corruption === 'recipe') getDb().prepare("UPDATE summary_leaf_inputs SET recipe='incompatible' WHERE key=?").run(leaf.key);
  else getDb().prepare("UPDATE summary_cache SET model='other/model' WHERE key=?").run(leaf.key);
  expire(); const next = await start(); const before = calls().length; await generateReply(next.id);
  const requested = primaryCallsSince(before); assert.equal(requested.length, input.evidence.length);
  assert.ok(requested.every(([session]) => session === input.session));
  assert.equal(store.getProgress(next.id).run.processed_entries, 13);
  assert.doesNotMatch(store.getSync(next.id).briefing, /CORRUPTED/);
});

for (const deployed of [false, true]) test(`overlapping whole leaves use union coverage, never slicing summaries or redoing old evidence (${deployed})`, async () => {
  session(8); await scanSessions(); const all = store.previewSummaryInput();
  const a = background({ ...all, items: all.items.slice(0, 4) }); await a.tree.build(); completeBackground(a);
  const b = background({ ...all, items: all.items.slice(2) }); await b.tree.build(); completeBackground(b);
  if (deployed) getDb().exec('DELETE FROM summary_leaf_inputs');
  const sync = store.startSync(), before = calls().length, specs = await plan(sync);
  assertCoverage(sync, specs); assert.equal(specs.length, 2); assert.equal(specs.reduce((n, spec) => n + spec.sources.length, 0), 10);
  await generateReply(sync.id); assert.equal(primaryCallsSince(before).length, 0);
  assert.equal(store.getProgress(sync.id).run.processed_entries, 8, 'overlapping original inputs counted once');
});

test('subset membership cannot borrow the full coverage or claims of a larger cached leaf', async () => {
  session(8); await scanSessions(); const all = store.previewSummaryInput(), first = background(all);
  await first.tree.build(); completeBackground(first);
  const subset = { ...all, items: all.items.slice(4) }, job = background(subset), before = calls().length;
  const roots = await job.tree.build();
  assert.deepEqual(new Set(roots.flatMap(node => node.sources)), new Set(subset.items.map(sourceKey)));
  assert.deepEqual(primaryCallsSince(before), subset.items.map(item => [item.session_id, item.sequence]));
  assert.equal(getDb().prepare('SELECT processed_entries FROM background_runs WHERE id=?').get(job.id).processed_entries, 4);
});

test('unrecoverable known completed historical work fails closed rather than silently paying again', async () => {
  session(4); const first = await start(), key = 'f'.repeat(64);
  const output = { observations: [{ topic: 'Unknown historical planner', state: 'blocked', summary: 'Deployment not verified.', evidence: [sourceKey(first.items[0])] }], limitations: [] };
  getDb().prepare('INSERT INTO summary_cache VALUES (?,?,?,?,?,?)').run(key, 'chunk', LUNA, LUNA_BATCH.version, JSON.stringify(output), '2026-01-01T00:00:00.000Z');
  getDb().prepare("INSERT INTO sync_tree_nodes(sync_id,key,kind,label,status,children_json,source_count) VALUES (?,?,'chunk','Original batch','done','[]',4)").run(first.id, key);
  expire(); const next = await start(), before = calls().length;
  await assert.rejects(generateReply(next.id), /could not be reconstructed exactly/);
  assert.equal(calls().length, before); assert.equal(getDb().prepare('SELECT count(*) n FROM sync_coverage').get().n, 0);
});

test('removed or excluded originals cannot be smuggled back as receipt dependencies', async () => {
  const gone = session(6), stable = session(7), first = await start(); await generateReply(first.id);
  store.setIncluded(gone.id, false);
  const refused = background({ items: first.items, context: first.context, models: first.models }), excludedBefore = calls().length;
  await assert.rejects(refused.tree.build(), /excluded/); assert.equal(calls().length, excludedBefore);
  expire(); const next = await start();
  assert.equal(next.items.length, 7); const before = calls().length; await generateReply(next.id); assert.equal(primaryCallsSince(before).length, 0);
  assert.ok((await plan(next)).every(spec => spec.leafInput.evidence.every(item => item.session_id === stable.id)));
  fs.unlinkSync(stable.file); await assert.rejects(generateReply(next.id), /unavailable|changed/);
  assert.equal(primaryCallsSince(before).length, 0);
});

// The follow-up regressions below seed exact outputs; no inference executable
// is involved. Even reconciliation uses an in-process synthetic response.
function seedLeaf(tree, evidence, background = [], batch = true, ordinal) {
  const spec = tree.leafSpec({ session: evidence[0].session_id, workspace: evidence[0].cwd,
    evidence, background, ...(ordinal === undefined ? {} : { chronological_chunk: ordinal }) }, batch);
  const output = JSON.stringify({ observations: [{ topic: 'Synthetic work', state: 'blocked', summary: 'Not verified.', evidence: [spec.sources[0]] }], limitations: [] });
  getDb().prepare('INSERT OR REPLACE INTO summary_cache VALUES (?,?,?,?,?,?)').run(spec.key, 'chunk', tree.sync.models.summary,
    batch ? LUNA_BATCH.version : 'sync-tree-v2-short-labels', output, new Date().toISOString());
  const leaves = tree.leafStore();
  leaves.save(spec.key, tree.sync.models.summary, tree.leafRecipe(batch), batch, leaves.encode(spec.leafInput), output);
  return spec;
}
function syntheticParents(job, calls) {
  job.tree.call = async payload => {
    calls.push(payload.stage); assert.equal(payload.stage, 'overview', 'completed leaves must never be paid again');
    return JSON.stringify({ observations: [{ topic: 'Synthetic parent', state: 'blocked', summary: 'Still not verified.', evidence: [payload.allowed_source_ids[0]] }], limitations: [] });
  };
}
function forbidProvider(tree) { tree.call = async () => { assert.fail('Provider forbidden'); }; }
function seededNode(spec) {
  return { key: spec.key, kind: spec.kind, label: spec.label, sources: spec.sources,
    summary: JSON.parse(getDb().prepare('SELECT output_json FROM summary_cache WHERE key=?').get(spec.key).output_json) };
}
function seedParent(tree, children, label) {
  const spec = tree.reconciliationSpec(children, label, false, false);
  const output = JSON.stringify({ observations: [{ topic: label, state: 'blocked', summary: 'Not verified.', evidence: [...spec.allowed].slice(0, 1) }], limitations: [] });
  getDb().prepare('INSERT OR REPLACE INTO summary_cache VALUES (?,?,?,?,?,?)').run(spec.key, 'overview', tree.sync.models.summary, LUNA_BATCH.version, output, new Date().toISOString());
  getDb().prepare('INSERT OR REPLACE INTO summary_parent_inputs VALUES (?,?,?,?)').run(spec.key, JSON.stringify(spec.children), 0, label);
  return seededNode(spec);
}
const immediate = action => new Promise((resolve, reject) => setImmediate(() => Promise.resolve().then(action).then(resolve, reject)));

test('complete R=[A,BC] wins over larger immediate AB after parent-cache growth', async () => {
  session(9); await scanSessions(); const input = store.previewSummaryInput(), seed = background(input);
  const a = seededNode(seedLeaf(seed.tree, input.items.slice(0, 4)));
  const b = seededNode(seedLeaf(seed.tree, input.items.slice(4, 7)));
  const c = seededNode(seedLeaf(seed.tree, input.items.slice(7)));
  const bc = seedParent(seed.tree, [b, c], 'BC'), root = seedParent(seed.tree, [a, bc], 'Completed root');
  seed.tree.leaves.close();
  const first = background(input); forbidProvider(first.tree);
  assert.equal((await first.tree.build())[0].key, root.key);
  seedParent(seed.tree, [a, b], 'AB');
  const second = background(input); forbidProvider(second.tree);
  assert.equal((await second.tree.build())[0].key, root.key);
  // Deployed caches without a saved root plan must discover the full subtree too.
  getDb().prepare("DELETE FROM summary_leaf_plans WHERE identity LIKE 'parents:%'").run();
  const legacy = background(input); forbidProvider(legacy.tree);
  assert.equal((await legacy.tree.build())[0].key, root.key);
  assert.equal(calls().length, 0);
});

for (const cached of [false, true]) test(`setImmediate exclusion after plannedBatches prevents even synthetic inference (cached=${cached})`, async () => {
  const data = session(3); await scanSessions(); const input = store.previewSummaryInput(), job = background(input);
  if (cached) seedLeaf(job.tree, input.items);
  const original = job.tree.plannedBatches.bind(job.tree);
  job.tree.plannedBatches = async (...args) => {
    const specs = await original(...args);
    for (const spec of specs) job.tree.leafStore().encode(spec.leafInput); // prime successful reads
    await immediate(() => store.setIncluded(data.id, false));
    return specs;
  };
  forbidProvider(job.tree);
  await assert.rejects(job.tree.build(), /excluded/);
  assert.equal(getDb().prepare('SELECT processed_entries FROM background_runs WHERE id=?').get(job.id).processed_entries, 0);
  assert.equal(job.tree.leaves, undefined, 'reader ownership is released on rejection');
  assert.equal(calls().length, 0);
});

test('late agent opt-out revokes a cached leaf without reopening its original', async () => {
  const data = session(3); await scanSessions(); const input = store.previewSummaryInput(), job = background(input);
  seedLeaf(job.tree, input.items);
  const original = job.tree.plannedBatches.bind(job.tree);
  job.tree.plannedBatches = async (...args) => {
    const specs = await original(...args);
    await immediate(() => store.setAgentEnabled('pi', false));
    return specs;
  };
  forbidProvider(job.tree); await assert.rejects(job.tree.build(), /unavailable|changed|excluded/);
  assert.equal(getDb().prepare('SELECT cache_hits FROM background_runs WHERE id=?').get(job.id).cache_hits, 0);
  assert.equal(job.tree.leaves, undefined);
});

for (const boundary of ['cached-leaf', 'cached-parent', 'paid-parent', 'returned-parent']) test(`uncited background revocation at ${boundary} is checked before acceptance/persistence`, async () => {
  const data = session(5); await scanSessions(); const all = store.previewSummaryInput();
  const input = { ...all, items: all.items.slice(1), context: all.items.slice(0, 1) }, job = background(input);
  const a = seededNode(seedLeaf(job.tree, input.items.slice(0, 2), input.context));
  const b = seededNode(seedLeaf(job.tree, input.items.slice(2)));
  const parent = job.tree.reconciliationSpec([a, b], 'Parent', false, false);
  if (boundary === 'cached-parent') seedParent(job.tree, [a, b], 'Parent');
  // Force a parent boundary here; ordinary small tails no longer need a merge.
  job.tree.compactRoots = nodes => nodes.length === 1;
  const revoke = () => store.setIncluded(data.id, false);
  const original = job.tree.node.bind(job.tree);
  job.tree.node = async (spec, ...args) => {
    if ((boundary === 'cached-leaf' && spec.key === a.key) || (boundary !== 'cached-leaf' && boundary !== 'returned-parent' && spec.kind === 'overview')) await immediate(revoke);
    return original(spec, ...args);
  };
  let invoked = 0;
  if (boundary === 'returned-parent') job.tree.call = async payload => {
    invoked++; assert.equal(payload.stage, 'overview'); await immediate(revoke);
    return JSON.stringify({ observations: [{ topic: 'Parent', state: 'blocked', summary: 'Not verified.', evidence: [payload.allowed_source_ids[0]] }], limitations: [] });
  };
  else forbidProvider(job.tree);
  await assert.rejects(job.tree.build(), /excluded|unavailable|changed/);
  assert.equal(invoked, boundary === 'returned-parent' ? 1 : 0);
  if (boundary !== 'cached-parent') assert.equal(getDb().prepare('SELECT key FROM summary_cache WHERE key=?').get(parent.key), undefined);
  assert.equal(job.tree.leaves, undefined);
  assert.equal(calls().length, 0);
});

for (const action of ['excluded', 'cancelled']) test(`queued ${action} between cached and missing leaves reaches the gate before paid work`, async () => {
  const data = session(3); await scanSessions(); const input = store.previewSummaryInput(), job = background(input);
  const controller = new AbortController(); job.tree.signal = controller.signal;
  const cached = seedLeaf(job.tree, input.items.slice(0, 1));
  const originalNode = job.tree.node.bind(job.tree); let delivered;
  job.tree.node = async (spec, ...args) => {
    const result = await originalNode(spec, ...args);
    if (spec.key === cached.key) delivered = immediate(() => action === 'cancelled' ? controller.abort() : store.setIncluded(data.id, false));
    return result;
  };
  let invoked = 0;
  job.tree.call = async payload => {
    invoked++;
    return JSON.stringify({ observations: [{ topic: 'Synthetic', state: 'blocked', summary: 'Not verified.', evidence: [payload.allowed_source_ids[0]] }], limitations: [] });
  };
  try { await assert.rejects(job.tree.build(), /excluded|unavailable|cancelled/); }
  finally { await delivered; }
  assert.equal(invoked, 0, 'resolved cache promises must not starve queued admission/cancellation events until after a paid request');
  assert.equal(job.tree.leaves, undefined);
});

for (const change of ['excluded', 'cancelled']) test(`leaf provider returning after ${change} cannot persist complete work or repair`, async () => {
  const data = session(3); await scanSessions(); const input = store.previewSummaryInput(), job = background(input);
  const controller = new AbortController(); job.tree.signal = controller.signal;
  let invoked = 0;
  job.tree.call = async payload => {
    invoked++;
    await immediate(() => {
      if (change === 'excluded') store.setIncluded(data.id, false);
      if (change === 'cancelled') controller.abort();
    });
    return JSON.stringify({ observations: [{ topic: 'Leaf', state: 'blocked', summary: 'Not verified.', evidence: [payload.allowed_source_ids[0]] }], limitations: [] });
  };
  await assert.rejects(job.tree.build(), /excluded|unavailable|changed|cancelled/);
  assert.equal(invoked, 1);
  assert.equal(getDb().prepare('SELECT count(*) n FROM summary_cache').get().n, 0);
  assert.equal(getDb().prepare('SELECT count(*) n FROM summary_leaf_inputs').get().n, 0);
  assert.equal(job.tree.leaves, undefined);
});

 test('clipped citation dependencies never become restart planning context or renumber existing references', async () => {
  session(14, 3000); const original = await start();
  const { cleanText } = require('../dist/sync/normalize');
  const tree = new SummaryTree(original, 0, new AbortController().signal), leaves = tree.leafStore();
  const context = original.items.slice(0, 6).map((item, i) => ({ ...item, ref: `C${i + 1}`, text: cleanText(item.text, 2000) }));
  for (const item of original.items.slice(0, 6)) getDb().prepare('DELETE FROM sync_items WHERE sync_id=? AND event_key=?').run(original.id, item.event_key);
  getDb().prepare('UPDATE syncs SET context_json=? WHERE id=?').run(leaves.frozenContext(context), original.id);
  const items = original.items.slice(6), first = seedLeaf(tree, items.slice(0, 4), context);
  const second = seedLeaf(tree, items.slice(4), items.slice(0, 4).map(item => ({ ...item, text: cleanText(item.text, 2000) })));
  leaves.close();
  const before = store.getSync(original.id), refs = [...before.items, ...before.context].map(item => [item.ref, sourceKey(item)]);
  assert.deepEqual((await plan(before)).map(spec => spec.key), [first.key, second.key]);
  assert.equal(store.getSync(original.id).context.length, 10);
  getDb().prepare("UPDATE syncs SET briefing='Already briefed' WHERE id=?").run(original.id);
  closeDb();
  const restored = store.getSync(original.id);
  assert.deepEqual((await plan(restored)).map(spec => spec.key), [first.key, second.key]);
  assert.ok((await plan(store.getSync(original.id))).every(spec => spec.reuseOnly));
  const current = new Map([...restored.items, ...restored.context].map(item => [item.ref, sourceKey(item)]));
  assert.ok(refs.every(([ref, key]) => current.get(ref) === key));
  assert.equal(restored.context.length, 10);
  const growth = new SummaryTree(restored, 0, new AbortController().signal);
  seedLeaf(growth, restored.items, context); growth.leaves.close();
  assert.deepEqual((await plan(store.getSync(original.id))).map(spec => spec.key), [first.key, second.key]);
  assert.deepEqual(store.getSync(original.id).context.map(item => [item.ref, sourceKey(item)]), restored.context.map(item => [item.ref, sourceKey(item)]));
  assert.equal(calls().length, 0);
});

 test('completed plan/root survives AB cache growth; a combined snapshot retains the exact old subtree', async () => {
  const data = session(9); await scanSessions(); const input = store.previewSummaryInput(), first = background(input), used = [];
  const a = seedLeaf(first.tree, input.items.slice(0, 3)), b = seedLeaf(first.tree, input.items.slice(3, 6)), z = seedLeaf(first.tree, input.items.slice(6));
  seedParent(first.tree, [seededNode(a), seededNode(b), seededNode(z)], 'Completed root');
  syntheticParents(first, used); const roots = await first.tree.build(); assert.deepEqual(used, []); completeBackground(first);
  const second = background(input); forbidProvider(second.tree); assert.equal((await second.tree.build())[0].key, roots[0].key);
  const grow = background(input); seedLeaf(grow.tree, input.items.slice(0, 6)); grow.tree.leaves.close();
  const third = background(input); forbidProvider(third.tree); assert.equal((await third.tree.build())[0].key, roots[0].key);
  const planner = background(input); assert.deepEqual((await planner.tree.batchSpecs()).map(spec => spec.key), [a.key, b.key, z.key]); planner.tree.leaves.close();
  append(data, 1); await scanSessions(); const combined = background(store.previewSummaryInput());
  seedLeaf(combined.tree, combined.tree.sync.items.slice(-1)); const more = []; syntheticParents(combined, more);
  const result = await combined.tree.build(); assert.deepEqual(more, []);
  assert.ok(result.some(node => node.key === roots[0].key), 'keep the completed root alongside its small appended tail');
  assert.equal(calls().length, 0);
});

for (const citeReviewed of [false, true]) test(`partial historical overlap fails closed even when another session is reviewed (citation reviewed=${citeReviewed})`, async () => {
  const a = session(8), b = session(1), old = await start(), key = 'e'.repeat(64);
  const ref = sourceKey(old.items.find(item => item.session_id === (citeReviewed ? b.id : a.id)));
  const output = JSON.stringify({ observations: [{ topic: 'Unknown boundary', state: 'blocked', summary: 'Not verified.', evidence: [ref] }], limitations: [] });
  getDb().prepare('INSERT INTO summary_cache VALUES (?,?,?,?,?,?)').run(key, 'chunk', LUNA, LUNA_BATCH.version, output, new Date().toISOString());
  getDb().prepare("INSERT INTO sync_tree_nodes(sync_id,key,kind,label,status,children_json,source_count) VALUES (?,?,'chunk','Synthetic','done','[]',8)").run(old.id, key);
  for (const item of old.items.filter(item => item.session_id === b.id)) getDb().prepare('INSERT INTO sync_coverage VALUES (?,?)').run(item.event_key, old.id);
  expire(); const next = await start(); assert.equal(next.items.length, 8);
  await assert.rejects(plan(next), /could not be reconstructed exactly/);
  const retry = new SummaryTree(store.getSync(next.id), 0, new AbortController().signal);
  retry.plannedBatches = () => assert.fail('Exhausted reconstruction was repeated');
  await assert.rejects(retry.batchSpecs(), /could not be reconstructed exactly/); retry.leaves.close();
  assert.equal(calls().length, 0);
});

 test('historical frozen boundaries recover unchanged leaves in the SAME session after an appended edit; stale background is rejected', async () => {
  const data = session(12), old = await start(), job = background(old);
  const first = seedLeaf(job.tree, old.items.slice(0, 4)), stable = seedLeaf(job.tree, old.items.slice(4, 8));
  const stale = seedLeaf(job.tree, old.items.slice(8), old.items.slice(0, 1));
  for (const spec of [first, stable, stale]) getDb().prepare("INSERT INTO sync_tree_nodes(sync_id,key,kind,label,status,children_json,source_count) VALUES (?,?,'chunk','Synthetic','done','[]',4)").run(old.id, spec.key);
  // Match deployed v3 whole-session planning boundaries with legacy islands.
  // The middle and final slices are exact legacy leaves from separate old
  // snapshots, whose frozen records stay readable after the edit.
  for (const [index, spec] of [first, stable, stale].entries()) {
    const id = Number(getDb().prepare("INSERT INTO syncs(created_at,context_json) VALUES (?,?)").run(new Date().toISOString(), job.tree.leafStore().frozenContext(spec.leafInput.background)).lastInsertRowid);
    for (const item of spec.leafInput.evidence) {
      const row = getDb().prepare('SELECT evidence_json FROM sync_items WHERE sync_id=? AND event_key=?').get(old.id, item.event_key);
      getDb().prepare('INSERT INTO sync_items VALUES (?,?,?)').run(id, item.event_key, row.evidence_json);
    }
    getDb().prepare("INSERT INTO sync_tree_nodes(sync_id,key,kind,label,status,children_json,source_count) VALUES (?,?,'chunk','Synthetic','done','[]',4)").run(id, spec.key);
  }
  job.tree.leaves.close(); getDb().exec('DELETE FROM summary_leaf_inputs');
  fs.appendFileSync(data.file, JSON.stringify({ type: 'context_edit', id: 'followup-edit', parentId: data.rows.at(-1).id, timestamp: '2026-01-02T00:00:00.000Z', targetId: data.rows[0].id, replacement: 'Changed effective projection.' }) + '\n');
  expire(); const next = await start(), specs = await plan(next);
  assert.ok(specs.some(spec => spec.key === stable.key && spec.reuseOnly));
  assert.ok(!specs.some(spec => spec.key === first.key || spec.key === stale.key));
  assert.equal(calls().length, 0);
});

 test('planning yields to event-loop cancellation during token packing, not just before work starts', async () => {
  session(700, 700); const sync = await start(), controller = new AbortController(), tree = new SummaryTree(sync, 0, controller.signal);
  let entered = false; const original = tree.tokenBatches.bind(tree);
  tree.tokenBatches = async (...args) => { entered = true; setImmediate(() => controller.abort()); return original(...args); };
  forbidProvider(tree); await assert.rejects(tree.batchSpecs(), /cancelled/); tree.leaves.close();
  assert.equal(entered, true); assert.equal(calls().length, 0);
});

 test('recovery saves unselected aliases; warm planning never opens unrelated archives or replays old packing', async () => {
  const data = session(12), old = await start(), job = background(old);
  const a = seedLeaf(job.tree, old.items.slice(0, 6)), ab = seedLeaf(job.tree, old.items);
  completeBackground(job); job.tree.leaves.close();
  const id = Number(getDb().prepare("INSERT INTO syncs(created_at) VALUES (?)").run(new Date().toISOString()).lastInsertRowid);
  for (const item of old.items.slice(0, 6)) {
    const row = getDb().prepare('SELECT evidence_json FROM sync_items WHERE sync_id=? AND event_key=?').get(old.id, item.event_key);
    getDb().prepare('INSERT INTO sync_items VALUES (?,?,?)').run(id, item.event_key, row.evidence_json);
  }
  for (const [syncId, spec] of [[id, a], [old.id, ab]]) getDb().prepare("INSERT INTO sync_tree_nodes(sync_id,key,kind,label,status,children_json,source_count) VALUES (?,?,'chunk','Synthetic','done','[]',?)").run(syncId, spec.key, spec.sources.length);
  getDb().exec('DELETE FROM summary_leaf_inputs'); expire(); append(data, 3); const next = await start();
  await plan(next);
  assert.equal(getDb().prepare('SELECT count(*) n FROM summary_leaf_inputs WHERE key IN (?,?)').get(a.key, ab.key).n, 2);
  const { ReusableLeaves } = require('../dist/sync/reusable-leaves'); const original = ReusableLeaves.prototype.snapshots;
  ReusableLeaves.prototype.snapshots = () => assert.fail('Warm planner reopened historical archives');
  try { const tree = new SummaryTree(store.getSync(next.id), 0, new AbortController().signal); tree.plannedBatches = () => assert.fail('Warm plan repacked unchanged inputs');
    await tree.batchSpecs(); tree.leaves.close(); } finally { ReusableLeaves.prototype.snapshots = original; }
  assert.equal(calls().length, 0);
});

test('large rollover with 63 irrelevant context variants replays only actual per-session inputs, then none when warm', async () => {
  const data = session(600, 300), old = await start(), job = background(old);
  const specs = await job.tree.plannedBatches(old, false, () => false);
  for (const spec of specs) seedLeaf(job.tree, spec.leafInput.evidence, spec.leafInput.background);
  const receipt = specs.map(spec => [spec.key, digest(getDb().prepare('SELECT output_json FROM summary_cache WHERE key=?').get(spec.key).output_json)]);
  getDb().prepare("UPDATE background_runs SET status='completed',processed_entries=?,completed_at=?,cache_receipt_json=? WHERE id=?")
    .run(old.items.length, new Date().toISOString(), JSON.stringify(receipt), job.id);
  const unrelated = session(63, 300); await scanSessions();
  const context = store.startConversationSync(randomUUID());
  const foreign = context.items.filter(item => item.session_id === unrelated.id);
  const frozenRows = getDb().prepare('SELECT event_key,evidence_json FROM sync_items WHERE sync_id=? ORDER BY rowid').all(old.id);
  for (const item of foreign) {
    const id = Number(getDb().prepare('INSERT INTO syncs(created_at,context_json) VALUES (?,?)')
      .run(new Date().toISOString(), job.tree.leafStore().frozenContext([item])).lastInsertRowid);
    for (const row of frozenRows) getDb().prepare('INSERT INTO sync_items VALUES (?,?,?)').run(id, row.event_key, row.evidence_json);
  }
  job.tree.leaves.close(); store.setIncluded(unrelated.id, false); fs.unlinkSync(unrelated.file);
  getDb().exec('DELETE FROM summary_leaf_inputs'); expire(); append(data, 20); const current = await start();
  const tree = new SummaryTree(current, 0, new AbortController().signal), original = tree.plannedBatches.bind(tree);
  let replayedEntries = 0, passes = 0;
  tree.plannedBatches = async (input, ...rest) => { passes++; replayedEntries += input.items.length; return original(input, ...rest); };
  const result = await tree.batchSpecs(); tree.leaves.close();
  assert.equal(result.filter(spec => spec.reuseOnly).length, specs.length);
  assert.ok(passes <= 3, `bounded packing passes: ${passes}`);
  assert.ok(replayedEntries <= 3 * current.items.length, `bounded per-session input work: ${replayedEntries}`);
  const warm = new SummaryTree(store.getSync(current.id), 0, new AbortController().signal);
  warm.plannedBatches = () => assert.fail('Warm rollover replayed token packing');
  assert.deepEqual((await warm.batchSpecs()).map(spec => spec.key), result.map(spec => spec.key)); warm.leaves.close();
  assert.equal(calls().length, 0);
});

test('output-only same-session legacy boundaries survive an edit to a different chunk', async () => {
  const data = session(30, 5800), old = await start(), job = background(old);
  const chunks = [...job.tree.chunkSpecs(false).values()].flat(); assert.ok(chunks.length >= 3);
  for (const spec of chunks) {
    seedLeaf(job.tree, spec.leafInput.evidence, spec.leafInput.background, false, spec.leafInput.chronological_chunk);
    getDb().prepare("INSERT INTO sync_tree_nodes(sync_id,key,kind,label,status,children_json,source_count) VALUES (?,?,'chunk','Synthetic','done','[]',?)")
      .run(old.id, spec.key, spec.sources.length);
  }
  job.tree.leaves.close(); getDb().exec('DELETE FROM summary_leaf_inputs');
  fs.appendFileSync(data.file, JSON.stringify({ type: 'context_edit', id: 'other-chunk-edit', parentId: data.rows.at(-1).id,
    timestamp: '2026-01-02T00:00:00.000Z', targetId: data.rows[0].id, replacement: 'Changed first input only.' }) + '\n');
  expire(); const next = await start(), planned = await plan(next);
  for (const spec of chunks.slice(1)) assert.ok(planned.some(candidate => candidate.key === spec.key && candidate.reuseOnly));
  assert.ok(!planned.some(spec => spec.key === chunks[0].key));
  const { ReusableLeaves } = require('../dist/sync/reusable-leaves'); const original = ReusableLeaves.prototype.snapshots;
  ReusableLeaves.prototype.snapshots = () => assert.fail('Proven changed boundary caused another replay');
  try { await plan(store.getSync(next.id)); } finally { ReusableLeaves.prototype.snapshots = original; }
  assert.equal(calls().length, 0);
});

for (const interrupted of [false, true]) test(`generateReply same-snapshot midpoint retry retains deployed provenance (interrupted=${interrupted})`, async () => {
  const data = session(340, 6000);
  // Highly compressible, byte-bound input exercises the deployed midpoint
  // split at production budgets, rather than reducing limits for the test.
  fs.writeFileSync(data.file, fs.readFileSync(data.file, 'utf8').replaceAll('x'.repeat(6000), ' '.repeat(5998) + 'x.'));
  const sync = await start(), seed = new SummaryTree(sync, 0, new AbortController().signal);
  const old = await seed.plannedBatches(sync, false, () => false, undefined, true);
  const current = await seed.plannedBatches(sync, false, () => false);
  assert.deepEqual(old.map(spec => spec.sources.length), [159, 79, 80, 22]);
  assert.deepEqual(current.map(spec => spec.sources.length), [159, 158, 1, 22]);
  for (const spec of old) {
    seedLeaf(seed, spec.leafInput.evidence, spec.leafInput.background);
    seed.register(spec);
  }
  const parent = seedParent(seed, old.map(seededNode), 'Deployed root');
  seed.register(seed.reconciliationSpec(old.map(seededNode), 'Deployed root', false, false));
  seed.leaves.close();
  getDb().exec('DELETE FROM summary_leaf_inputs; DELETE FROM summary_leaf_plans; DELETE FROM summary_parent_inputs');
  getDb().prepare("INSERT INTO sync_tree_nodes(sync_id,key,kind,label,children_json,source_count) VALUES (?,'stale','overview','Other run','[]',1)").run(sync.id);
  const originalCall = SummaryTree.prototype.call;
  SummaryTree.prototype.call = async payload => {
    assert.equal(payload.task, 'final_verdict', 'no completed leaf or parent may be paid again');
    return 'Still unverified [R1].';
  };
  try {
    if (interrupted) {
      const { ReusableLeaves } = require('../dist/sync/reusable-leaves'), snapshots = ReusableLeaves.prototype.snapshots;
      ReusableLeaves.prototype.snapshots = async () => { throw new Error('Synthetic migration interruption'); };
      try { await assert.rejects(generateReply(sync.id), /migration interruption/); }
      finally { ReusableLeaves.prototype.snapshots = snapshots; }
      assert.equal(getDb().prepare("SELECT count(*) n FROM sync_tree_nodes WHERE sync_id=? AND kind='chunk'").get(sync.id).n, old.length);
      closeDb();
    }
    const result = await generateReply(sync.id, undefined, undefined, { deferHistory: true });
    assert.equal(result.tree.run.processed_entries, 340);
    assert.deepEqual(new Set(result.tree.nodes.filter(node => node.kind === 'chunk').map(node => node.key)), new Set(old.map(spec => spec.key)));
    assert.ok(result.tree.nodes.some(node => node.key === parent.key), 'deployed parent topology survives');
    assert.ok(!result.tree.nodes.some(node => node.key === 'stale'));
    assert.ok(getDb().prepare("SELECT 1 FROM sync_tree_nodes WHERE sync_id=? AND key='stale'").get(sync.id), 'display filtering never deletes history');
    assert.equal(calls().length, 0);
  } finally { SummaryTree.prototype.call = originalCall; }
});

test('node display migration tags existing topology with latest known run only once', async () => {
  session(3); const sync = await start();
  const db = getDb(), { initSchema } = require('../dist/db/schema');
  const run = () => Number(db.prepare(`INSERT INTO sync_runs(sync_id,summary_model,final_model,max_invocations,total_entries,started_at)
    VALUES (?,?,?,10,3,?)`).run(sync.id, LUNA, FINAL, new Date().toISOString()).lastInsertRowid);
  run(); const latest = run();
  db.prepare("INSERT INTO sync_tree_nodes(sync_id,key,kind,label,children_json,source_count) VALUES (?,'root','overview','Old root','[\"leaf\"]',3)").run(sync.id);
  db.exec('ALTER TABLE sync_tree_nodes DROP COLUMN last_run_id');
  initSchema(db);
  assert.equal(db.prepare("SELECT last_run_id FROM sync_tree_nodes WHERE key='root'").get().last_run_id, latest);
  assert.deepEqual(store.getProgress(sync.id).nodes[0].children, ['leaf']);
  run(); initSchema(db);
  assert.equal(store.getProgress(sync.id).nodes.length, 0, 'restart must not relabel historical nodes as current');
  assert.equal(db.prepare("SELECT count(*) n FROM sync_tree_nodes WHERE key='root'").get().n, 1);
});

// Force preparation reuse explicitly; prepared chat must never run these gates.
async function rebuildBriefing(id) {
  const { briefing } = store.getSync(id);
  getDb().prepare("UPDATE syncs SET briefing='' WHERE id=?").run(id);
  try { return await generateReply(id, undefined, undefined, { deferHistory: true }); }
  finally { getDb().prepare('UPDATE syncs SET briefing=? WHERE id=?').run(briefing, id); }
}
test('briefing lifecycle checks do not reload originals; final admission and commit each verify provenance once', async t => {
  session(3); const sync = await start(), seed = new SummaryTree(sync, 0, new AbortController().signal);
  seedLeaf(seed, sync.items); seed.leaves.close();
  const originalOpen = store.requireOpen, originalVerify = SummaryTree.prototype.verifyFinal;
  const reads = []; let verified = 0;
  t.mock.method(store, 'requireOpen', (...args) => { reads.push(args[2] ?? true); return originalOpen(...args); });
  t.mock.method(SummaryTree.prototype, 'verifyFinal', function () { verified++; return originalVerify.call(this); });
  const result = await generateReply(sync.id, undefined, undefined, { deferHistory: true });
  assert.ok(result.briefing); assert.equal(reads.filter(Boolean).length, 1);
  assert.ok(reads.filter(value => !value).length >= 2);
  assert.equal(verified, 2, 'verify at final inference admission and inside the save transaction');
});

for (const boundary of ['before-final', 'queued-exclusion', 'queued-cancel', 'returned-final', 'before-repair', 'returned-repair', 'persistence', 'agent-disabled'])
  test(`generateReply final fresh gate outside call prevents ${boundary}`, async () => {
    const data = session(3), sync = await start(), seed = new SummaryTree(sync, 0, new AbortController().signal);
    seedLeaf(seed, sync.items); seed.leaves.close();
    const originalBuild = SummaryTree.prototype.build, originalCall = SummaryTree.prototype.call, originalVerify = SummaryTree.prototype.verifyFinal;
    let invoked = 0;
    const revoke = () => store.setIncluded(data.id, false);
    SummaryTree.prototype.build = async function () {
      const roots = await originalBuild.call(this);
      assert.equal(this.leaves, undefined);
      if (boundary === 'before-final') await immediate(revoke);
      if (boundary === 'queued-exclusion') setImmediate(revoke);
      if (boundary === 'queued-cancel') setImmediate(() => cancelReply(sync.id));
      if (boundary === 'agent-disabled') setImmediate(() => store.setAgentEnabled('pi', false));
      return roots;
    };
    SummaryTree.prototype.verifyFinal = function () {
      if (getDb().inTransaction && boundary === 'persistence') revoke();
      return originalVerify.call(this);
    };
    SummaryTree.prototype.call = async function (payload) {
      assert.equal(payload.task, 'final_verdict'); invoked++;
      // The trap replaces the provider boundary, but retains a synthetic spend.
      getDb().prepare('UPDATE sync_runs SET invocations=invocations+1 WHERE id=?').run(this.runId);
      if (boundary === 'returned-final') await immediate(revoke);
      if (boundary === 'before-repair' && !payload.repair) { setImmediate(revoke); return 'Missing citation.'; }
      if (boundary === 'returned-repair') {
        if (!payload.repair) return 'Missing citation.';
        await immediate(revoke);
      }
      return 'Still unverified [R1].';
    };
    try {
      await assert.rejects(generateReply(sync.id), /excluded|cancelled/);
      const expected = ['before-final', 'queued-exclusion', 'queued-cancel', 'agent-disabled'].includes(boundary) ? 0 : boundary === 'returned-repair' ? 2 : 1;
      assert.equal(invoked, expected);
      const result = store.getSync(sync.id);
      assert.equal(result.briefing, ''); assert.equal(result.messages.filter(message => message.role === 'assistant').length, 0);
      assert.equal(result.messages.filter(message => message.role === 'user').length, 0);
      assert.equal(result.tree.run.invocations, expected); assert.equal(result.tree.complete, false);
      assert.equal(calls().length, 0);
    } finally {
      SummaryTree.prototype.build = originalBuild; SummaryTree.prototype.call = originalCall; SummaryTree.prototype.verifyFinal = originalVerify;
    }
  });

for (const adopted of [false, true]) test(`final gate includes uncited background originals (adopted=${adopted})`, async () => {
  const data = session(1); session(3); const original = await start();
  const bg = original.items.filter(item => item.session_id === data.id), items = original.items.filter(item => item.session_id !== data.id);
  const seed = new SummaryTree(original, 0, new AbortController().signal);
  seedLeaf(seed, items, bg);
  for (const item of bg) getDb().prepare('DELETE FROM sync_items WHERE sync_id=? AND event_key=?').run(original.id, item.event_key);
  if (!adopted) getDb().prepare('UPDATE syncs SET context_json=? WHERE id=?').run(seed.leafStore().frozenContext(bg), original.id);
  seed.leaves.close();
  const build = SummaryTree.prototype.build, call = SummaryTree.prototype.call;
  let invoked = 0;
  SummaryTree.prototype.build = async function () {
    const roots = await build.call(this);
    assert.ok(roots.every(root => root.summary.observations.every(observation => !observation.evidence.includes(sourceKey(bg[0])))));
    assert.ok(store.getSync(original.id).context.some(item => item.session_id === data.id));
    setImmediate(() => store.setIncluded(data.id, false));
    return roots;
  };
  SummaryTree.prototype.call = async () => { invoked++; assert.fail('Uncited background still requires fresh consent'); };
  try {
    await assert.rejects(generateReply(original.id, undefined, undefined, { deferHistory: true }), /excluded/);
    assert.equal(invoked, 0); assert.equal(store.getSync(original.id).briefing, '');
  } finally { SummaryTree.prototype.build = build; SummaryTree.prototype.call = call; }
});

test('frozen foreground proof cannot admit a stale extra background edit from a historical receipt', async () => {
  const data = session(4), original = await start(), seed = new SummaryTree(original, 0, new AbortController().signal);
  const stale = seedLeaf(seed, original.items.slice(1), original.items.slice(0, 1)); seed.leaves.close();
  getDb().prepare('DELETE FROM sync_items WHERE sync_id=? AND event_key=?').run(original.id, original.items[0].event_key);
  fs.appendFileSync(data.file, JSON.stringify({ type: 'context_edit', id: 'extra-bg-edit', parentId: data.rows.at(-1).id,
    timestamp: '2026-01-02T00:00:00.000Z', targetId: data.rows[0].id, replacement: 'Changed extra background.' }) + '\n');
  await scanSessions();
  const current = store.getSync(original.id), planned = await plan(current);
  assert.ok(!planned.some(spec => spec.key === stale.key));
  assert.equal(store.getSync(original.id).context.length, 0, 'unknown old BG cannot be borrowed as frozen E/C');
  assert.equal(calls().length, 0);
});

for (const completed of [false, true]) for (const reopen of [false, true])
  test(`source opt-out remains effective after retry and reopen (completed=${completed}, reopen=${reopen})`, async () => {
    const data = session(3), original = await start(), seed = new SummaryTree(original, 0, new AbortController().signal);
    const bg = original.items.slice(0, 1);
    seedLeaf(seed, original.items.slice(1), bg); seed.leaves.close();
    getDb().prepare('DELETE FROM sync_items WHERE sync_id=? AND event_key=?').run(original.id, bg[0].event_key);
    const change = async () => store.setIncluded(data.id, false);
    const call = SummaryTree.prototype.call; let invoked = 0;
    SummaryTree.prototype.call = async function (payload) {
      invoked++; assert.equal(payload.task, 'final_verdict', 'no replacement leaf or parent may be paid while a persisted dependency is invalid');
      if (invoked === 1 && !completed) await immediate(change);
      return 'Still unverified [R1].';
    };
    try {
      if (completed) { await generateReply(original.id); await change(); }
      else await assert.rejects(generateReply(original.id), /unavailable|changed|excluded/);
      const prior = store.getSync(original.id);
      assert.ok(prior.context.some(item => item.event_key === bg[0].event_key));
      assert.deepEqual(JSON.parse(getDb().prepare('SELECT refs_json FROM summary_planning_context WHERE sync_id=?').get(original.id).refs_json), []);
      if (reopen) closeDb();
      await assert.rejects(rebuildBriefing(original.id), /unavailable|changed|excluded/);
      assert.equal(invoked, 1, 'retry must stop before any new provider call, not merely reject the final answer after spending');
      const result = store.getSync(original.id);
      assert.equal(result.briefing, prior.briefing);
      assert.equal(result.messages.filter(message => message.role === 'assistant').length, 0);
      assert.equal(result.context.find(item => item.event_key === bg[0].event_key).text, bg[0].text, 'historical citation stays readable, not promoted or rewritten');
    } finally { SummaryTree.prototype.call = call; }
  });

test('final source-consent checks leave no open readers on success or revocation', async () => {
  const data = session(3), sync = await start();
  const runId = Number(getDb().prepare(`INSERT INTO sync_runs(sync_id,summary_model,final_model,max_invocations,total_entries,started_at)
    VALUES (?,?,?,10,3,?)`).run(sync.id, LUNA, FINAL, new Date().toISOString()).lastInsertRowid);
  const tree = new SummaryTree(sync, runId, new AbortController().signal);
  seedLeaf(tree, sync.items); forbidProvider(tree); await tree.build();
  const { EvidenceReader } = require('../dist/db/evidence'), project = EvidenceReader.prototype.project, close = EvidenceReader.prototype.close;
  const open = new Set();
  EvidenceReader.prototype.project = function (...args) { open.add(this); return project.apply(this, args); };
  EvidenceReader.prototype.close = function () { open.delete(this); return close.call(this); };
  try {
    tree.verifyFinal(); assert.equal(open.size, 0); assert.equal(tree.leaves, undefined);
    store.setIncluded(data.id, false);
    assert.throws(() => tree.verifyFinal(), /excluded/); assert.equal(open.size, 0);
    fs.unlinkSync(data.file);
    assert.throws(() => tree.verifyFinal(), /unavailable|changed/); assert.equal(open.size, 0);
  } finally { EvidenceReader.prototype.project = project; EvidenceReader.prototype.close = close; }
});

for (const context of [false, true]) test(`deployed missing-sequence BG remains an authorized reduced initial view (C=${context})`, async () => {
  const data = session(3), original = await start(), bg = original.items[0];
  if (context) {
    const reader = new (require('../dist/db/evidence').EvidenceReader)(getDb());
    try {
      getDb().prepare('DELETE FROM sync_items WHERE sync_id=? AND event_key=?').run(original.id, bg.event_key);
      getDb().prepare('UPDATE syncs SET context_json=? WHERE id=?').run(JSON.stringify([JSON.parse(reader.freeze({ ...bg, ref: 'C1' }))]), original.id);
    } finally { reader.close(); }
  }
  const sync = store.getSync(original.id), seed = new SummaryTree(sync, 0, new AbortController().signal);
  const reduced = { ...(context ? sync.context[0] : sync.items[0]) }; delete reduced.sequence;
  const a = seedLeaf(seed, sync.items.slice(0, 1), context ? sync.context : []);
  const b = seedLeaf(seed, sync.items.slice(1), [reduced]);
  seedParent(seed, [seededNode(a), seededNode(b)], 'Completed reduced-view root'); seed.leaves.close();
  const call = SummaryTree.prototype.call; let invoked = 0;
  SummaryTree.prototype.call = async payload => { invoked++; assert.equal(payload.task, 'final_verdict', 'no repeated leaf or parent work for a still-frozen reduced view'); return 'Still unverified [R1].'; };
  try {
    await generateReply(sync.id);
    fs.appendFileSync(data.file, JSON.stringify({ type: 'context_edit', id: 'reduced-view-later-edit', parentId: data.rows.at(-1).id,
      timestamp: '2026-01-03T00:00:00.000Z', targetId: data.rows[0].id, replacement: 'Later H, not replacement frozen input.' }) + '\n');
    await scanSessions(); closeDb();
    await rebuildBriefing(sync.id);
    assert.equal(invoked, 2);
  } finally { SummaryTree.prototype.call = call; }
});

test('durably initial C remains frozen after later edits and reopen', async () => {
  const data = session(3), original = await start(), reader = new (require('../dist/db/evidence').EvidenceReader)(getDb());
  const bg = original.items[0];
  try {
    getDb().prepare('DELETE FROM sync_items WHERE sync_id=? AND event_key=?').run(original.id, bg.event_key);
    getDb().prepare('UPDATE syncs SET context_json=? WHERE id=?').run(JSON.stringify([JSON.parse(reader.freeze({ ...bg, ref: 'C1' }))]), original.id);
  } finally { reader.close(); }
  const sync = store.getSync(original.id), seed = new SummaryTree(sync, 0, new AbortController().signal);
  seedLeaf(seed, sync.items, sync.context); seed.leaves.close();
  const call = SummaryTree.prototype.call; let invoked = 0;
  SummaryTree.prototype.call = async payload => { assert.equal(payload.task, 'final_verdict'); invoked++; return 'Still unverified [R1].'; };
  try {
    await generateReply(sync.id);
    fs.appendFileSync(data.file, JSON.stringify({ type: 'context_edit', id: 'initial-c-later-edit', parentId: data.rows.at(-1).id,
      timestamp: '2026-01-03T00:00:00.000Z', targetId: data.rows[0].id, replacement: 'Later H, not replacement C.' }) + '\n');
    await scanSessions(); closeDb();
    await rebuildBriefing(sync.id);
    assert.equal(invoked, 2, 'initial C still allows only explicit final answers, never repeated leaf preparation');
    assert.equal(store.getSync(sync.id).context.find(item => item.ref === 'C1').text, bg.text);
    assert.deepEqual(JSON.parse(getDb().prepare('SELECT refs_json FROM summary_planning_context WHERE sync_id=?').get(sync.id).refs_json), ['C1']);
  } finally { SummaryTree.prototype.call = call; }
});

test('prepared foreground keeps the selected frozen edit after newer context_edit and catalog changes', async () => {
  const data = session(3);
  fs.appendFileSync(data.file, JSON.stringify({ type: 'context_edit', id: 'selected-edit', parentId: data.rows.at(-1).id,
    timestamp: '2026-01-02T00:00:00.000Z', targetId: data.rows[0].id, replacement: 'Selected old projection: deployment unverified.' }) + '\n');
  const sync = await start(); await generateReply(sync.id);
  const captured = store.getSync(sync.id), old = captured.items[0];
  assert.match(old.text, /Selected old projection/); assert.ok(captured.conversation.history_before);
  fs.appendFileSync(data.file, JSON.stringify({ type: 'context_edit', id: 'new-edit', parentId: 'selected-edit',
    timestamp: '2026-01-03T00:00:00.000Z', targetId: data.rows[0].id, replacement: 'New H projection, not replacement E.' }) + '\n');
  await scanSessions();
  getDb().prepare('UPDATE agent_sessions SET cwd=? WHERE id=?').run('/new/catalog/workspace', data.id);
  getDb().prepare('UPDATE agent_entries SET active=0 WHERE session_id=? AND entry_id=?').run(data.id, old.entry_id);
  const frozen = store.getSync(sync.id);
  assert.equal(frozen.items[0].text, old.text); assert.equal(frozen.items[0].unavailable, undefined);
  const before = calls().length, result = await generateReply(sync.id, 'What remains?', randomUUID());
  assert.equal(primaryCallsSince(before).length, 0, 'ordinary edit/index advance must not repay frozen leaves');
  assert.equal(store.getSync(sync.id).items[0].text, old.text); assert.ok(result.messages.some(message => message.role === 'assistant'));
  const final = calls().slice(before).find(call => call.task === 'final_verdict');
  assert.ok(final, 'explicit next question reaches final inference');
});

test('deployed v3 recursive MIDPOINT leaves recover by exact keys, including the old partial tail', async () => {
  const limit = LUNA_BATCH.plannedRequestTokens; LUNA_BATCH.plannedRequestTokens = 14000;
  try {
    const data = session(170, 1200), old = await start(), job = background(old);
    const specs = await job.tree.plannedBatches(old, false, () => false, undefined, true); assert.ok(specs.length >= 3);
    for (const spec of specs) {
      seedLeaf(job.tree, spec.leafInput.evidence, spec.leafInput.background);
      getDb().prepare("INSERT INTO sync_tree_nodes(sync_id,key,kind,label,status,children_json,source_count) VALUES (?,?,'chunk','Synthetic','done','[]',?)")
        .run(old.id, spec.key, spec.sources.length);
    }
    job.tree.leaves.close(); getDb().exec('DELETE FROM summary_leaf_inputs'); expire(); append(data, 17);
    const next = await start(), restored = await plan(next);
    for (const spec of specs) assert.ok(restored.some(candidate => candidate.key === spec.key && candidate.reuseOnly));
    assert.deepEqual(restored.filter(spec => !spec.reuseOnly).flatMap(spec => spec.sources), next.items.slice(-17).map(sourceKey));
    assert.equal(calls().length, 0);
  } finally { LUNA_BATCH.plannedRequestTokens = limit; }
});
