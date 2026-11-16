// Independent core repros: real temporary SQLite/JSONL; synthetic model/native
// boundaries only. Canonical citation IDs must not erase selected provenance.
require('./fixtures/fake-memory.cjs');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const { getDb, closeDb } = require('../dist/db/schema');
const { scanSessions } = require('../dist/sync/collector');
const store = require('../dist/sync/store');
const { EvidenceReader } = require('../dist/db/evidence');
const { SummaryTree, validateSummary } = require('../dist/sync/tree');
const { generateReply } = require('../dist/sync/manager');
const { LUNA_BATCH } = require('../dist/sync/summary-budget');
const { sourceKey, sourceRepresentatives } = require('../dist/sync/normalize');
const { EvidenceScope, evidenceIdentities } = require('../dist/sync/evidence-scope');
const live = require('../dist/voice/live');
let temp, file, sid, calls, payloads, nativeRequests, probes, originalCall, originalLoad;
const signal = () => new AbortController().signal;
function output(ref) { return { observations: [{ topic: 'Synthetic', state: 'blocked', summary: 'Not verified.', evidence: [ref] }], limitations: [] }; }
beforeEach(() => {
  closeDb(); temp = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-core-provenance-'));
  const root = path.join(temp, 'sessions'); fs.mkdirSync(root);
  Object.assign(process.env, { DRAKEN_DATA_DIR: path.join(temp, 'state'), DRAKEN_PI_SESSIONS_DIR: root,
    DRAKEN_PI_BIN: '/no-provider-permitted', DRAKEN_PI_SUMMARY_MODEL: 'openai/gpt-6-luna',
    DRAKEN_PI_FINAL_MODEL: 'openai/gpt-6-astra', DRAKEN_VOICE_MODE: 'native' });
  sid = randomUUID(); file = path.join(root, sid + '.jsonl');
  const rows = [{ type: 'session', version: 3, id: sid, cwd: '/synthetic', timestamp: '2026-01-01T00:00:00.000Z' },
    ...Array.from({ length: 4 }, (_, i) => ({ type: 'message', id: 'm' + i, parentId: i ? 'm' + (i - 1) : null,
      timestamp: `2026-01-01T00:00:0${i}.000Z`, message: { role: i ? 'assistant' : 'user', content: [{ type: 'text', text: 'Original body ' + i + ' not verified.' }] } }))];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  calls = []; payloads = []; nativeRequests = []; probes = 0;
  originalCall = SummaryTree.prototype.call;
  SummaryTree.prototype.call = async payload => {
    payloads.push(payload);
    calls.push(payload.task === 'final_verdict' ? 'final' : payload.stage);
    return payload.task === 'final_verdict' ? 'Unverified [R1].' : JSON.stringify(output(payload.allowed_source_ids[0]));
  };
  originalLoad = Module._load;
  Module._load = function (name, ...args) {
    if (name.endsWith('/voice/realtime/native.mjs')) return {
      nativeStatus: async () => { probes++; return { readyForProbe: true }; },
      NativeVoice: class {
        subscribe() { return () => {}; }
        async open(_sdp, options) { options.onReady?.(); nativeRequests.push('open'); return 'synthetic SDP'; }
        async context() { nativeRequests.push('context'); }
        async text() { nativeRequests.push('text'); }
        async close() { return { helperExited: true }; }
      },
    };
    return originalLoad.call(this, name, ...args);
  };
});
afterEach(async () => {
  await live.stopLiveCalls(); SummaryTree.prototype.call = originalCall; Module._load = originalLoad;
  closeDb(); fs.rmSync(temp, { recursive: true, force: true }); delete process.env.DRAKEN_VOICE_MODE;
});
async function edit(id, text, parent = 'm3') {
  fs.appendFileSync(file, JSON.stringify({ type: 'context_edit', id, parentId: parent,
    timestamp: '2026-01-03T00:00:00.000Z', targetId: 'm0', replacement: text }) + '\n');
  await scanSessions();
}
function metadata(sync) {
  return { items: getDb().prepare('SELECT evidence_json FROM sync_items WHERE sync_id=? ORDER BY rowid').all(sync.id).map(row => row.evidence_json),
    context: getDb().prepare('SELECT context_json FROM syncs WHERE id=?').get(sync.id).context_json };
}
function moveToContext(sync, count = 1) {
  const items = metadata(sync).items.slice(0, count).map((value, index) => ({ ...JSON.parse(value), ref: `C${index + 1}` }));
  for (const item of items) getDb().prepare('DELETE FROM sync_items WHERE sync_id=? AND event_key=?').run(sync.id, item.event_key);
  getDb().prepare('UPDATE syncs SET context_json=? WHERE id=?').run(JSON.stringify(items), sync.id);
  return store.getSync(sync.id);
}
function reduced(item) {
  // Preserve the exact captured pointer; spreading a hydrated Evidence would
  // instead select the catalog's current pointer when next frozen.
  const reader = new EvidenceReader(getDb());
  try { const value = JSON.parse(reader.freeze(item)); delete value.sequence; return reader.read(value); }
  finally { reader.close(); }
}
function seedLeaf(tree, items, background = [], historical = false, { batch = true, ordinal, cite } = {}) {
  const spec = tree.leafSpec({ session: sid, workspace: items[0].cwd, evidence: items, background,
    ...(ordinal === undefined ? {} : { chronological_chunk: ordinal }) }, batch, false);
  const json = JSON.stringify(output(cite || spec.sources[0]));
  getDb().prepare('INSERT OR REPLACE INTO summary_cache VALUES (?,?,?,?,?,?)').run(spec.key, 'chunk', tree.sync.models.summary,
    batch ? LUNA_BATCH.version : 'sync-tree-v2-short-labels', json, new Date().toISOString());
  const leaves = tree.leafStore();
  leaves.save(spec.key, tree.sync.models.summary, tree.leafRecipe(batch), batch, leaves.encode(spec.leafInput, historical), json);
  return { ...spec, summary: JSON.parse(json) };
}
function seedParent(tree, nodes) {
  const spec = tree.reconciliationSpec(nodes, 'Completed root', false, false);
  getDb().prepare('INSERT OR REPLACE INTO summary_cache VALUES (?,?,?,?,?,?)').run(spec.key, 'overview', tree.sync.models.summary, LUNA_BATCH.version, JSON.stringify(output([...spec.allowed][0])), new Date().toISOString());
  getDb().prepare('INSERT OR REPLACE INTO summary_parent_inputs VALUES (?,?,?,?)').run(spec.key, JSON.stringify(spec.children), 0, spec.label);
  return spec;
}
function planRows() { return getDb().prepare('SELECT * FROM summary_leaf_plans ORDER BY rowid').all(); }

test('first complete leaf with omitted-sequence initial C keeps all completed work', async () => {
  await scanSessions(); const sync = moveToContext(store.startSync(), 2), before = metadata(sync);
  const seed = new SummaryTree(sync, 0, signal());
  const leaf = seedLeaf(seed, sync.items, sync.context.map(reduced)); seed.leaves.close();
  await generateReply(sync.id, undefined, undefined, { deferHistory: true });
  assert.deepEqual(calls, ['final'], 'no replacement of the first completed leaf');
  assert.ok(store.getSync(sync.id).tree.nodes.some(node => node.key === leaf.key));
  const plans = planRows();
  // Genuine initial C keeps its captured as-of authority after catalog changes.
  await edit('initial-later-edit', 'Changed current catalog body.');
  getDb().prepare('UPDATE agent_sessions SET cwd=? WHERE id=?').run('/new/catalog', sid); closeDb();
  await generateReply(sync.id, 'Again?', undefined, { deferHistory: true });
  assert.deepEqual(calls, ['final', 'final']); assert.deepEqual(metadata(sync), before); assert.deepEqual(planRows(), plans);
});

for (const initial of ['E', 'C']) test(`same-key no-op pointer remains a durable strict extra beside initial ${initial}`, async () => {
  await scanSessions(); let sync = store.startSync(); if (initial === 'C') sync = moveToContext(sync);
  const before = metadata(sync), captured = initial === 'E' ? sync.items[0] : sync.context[0];
  await edit('same-body-edit', captured.text);
  const current = { ...captured }; delete current.sequence; // deliberately select NEW catalog edit
  const seed = new SummaryTree(store.getSync(sync.id), 0, signal());
  const a = seedLeaf(seed, sync.items.slice(0, 1), sync.context), b = seedLeaf(seed, sync.items.slice(1), [current]);
  const root = seedParent(seed, [a, b]); seed.leaves.close();
  const receipt = JSON.parse(getDb().prepare('SELECT input_json FROM summary_leaf_inputs WHERE key=?').get(b.key).input_json).background[0];
  assert.equal(sourceKey(current), sourceKey(captured));
  assert.equal(receipt.source_pointer.edit.entry_id, 'same-body-edit');
  await generateReply(sync.id, undefined, undefined, { deferHistory: true });
  assert.deepEqual(calls, ['final'], 'valid old leaves/root need zero new inference');
  const after = metadata(sync), context = JSON.parse(after.context), oldContext = JSON.parse(before.context);
  assert.deepEqual(after.items, before.items); assert.deepEqual(context.slice(0, oldContext.length), oldContext);
  assert.equal(context.length, oldContext.length + 1, 'same canonical key still needs a durable extra');
  assert.deepEqual(context.at(-1).source_pointer, receipt.source_pointer);
  assert.equal(context.at(-1).sequence, undefined);
  assert.deepEqual(JSON.parse(getDb().prepare('SELECT refs_json FROM summary_planning_context WHERE sync_id=?').get(sync.id).refs_json), oldContext.map(item => item.ref));
  assert.ok(store.getSync(sync.id).tree.nodes.some(node => node.key === root.key));
  const plans = planRows();
  for (let n = 0; n < 2; n++) {
    closeDb(); await generateReply(sync.id, 'Unchanged retry?', undefined, { deferHistory: true });
    assert.deepEqual(metadata(sync), after, 'no duplicate C/ref churn'); assert.deepEqual(planRows(), plans);
    const retry = new SummaryTree(store.getSync(sync.id), 0, signal());
    assert.equal(retry.sourceMap.get(sourceKey(captured)).ref, captured.ref, 'old E/C remains canonical representative');
  }
  assert.deepEqual(calls, ['final', 'final', 'final']);
  await edit('different-body-edit', 'New edited body is unrelated.', 'same-body-edit'); closeDb();
  const count = calls.length;
  await assert.rejects(generateReply(sync.id, 'What remains?', undefined, { deferHistory: true }), /unavailable|changed|excluded/);
  await assert.rejects(live.createLiveCall(sync.id, signal()), /unavailable|changed|excluded/);
  assert.equal(calls.length, count, 'zero new leaf/parent/final calls');
  assert.equal(probes, 0); assert.deepEqual(nativeRequests, [], 'zero live open/context/text');
  assert.deepEqual(metadata(sync), after); assert.deepEqual(planRows(), plans);
});

for (const conflict of ['sequence', 'workspace', 'body', 'order', 'missing', 'extra', 'pointer'])
  test(`first-context compatibility preserves complete ordered exact selected view: ${conflict}`, async () => {
    await scanSessions(); const sync = moveToContext(store.startSync(), 2);
    let background = sync.context.map(reduced);
    if (conflict === 'sequence') background[0] = { ...background[0], sequence: sync.context[0].sequence + 100 };
    if (conflict === 'workspace') background[0] = { ...background[0], cwd: '/conflicting' };
    if (conflict === 'body' || conflict === 'pointer') {
      await edit('other-pointer', conflict === 'body' ? 'Different body.' : background[0].text);
      background[0] = { ...background[0], text: conflict === 'body' ? 'Different body.' : background[0].text };
    }
    if (conflict === 'order') background.reverse();
    if (conflict === 'missing') background.pop();
    if (conflict === 'extra') background.push(background[0]);
    const seed = new SummaryTree(sync, 0, signal()), leaf = seedLeaf(seed, sync.items, background, true); seed.leaves.close();
    const tree = new SummaryTree(store.getSync(sync.id), 0, signal());
    try {
      const retained = [...(await tree.reusableSpecs()).values()].flat();
      assert.ok(!retained.some(spec => spec.key === leaf.key), 'conflicting first context cannot reuse completed leaf');
    } finally { tree.leaves?.close(); }
    assert.deepEqual(calls, []);
  });

test('shared representation identity permits only directional missing sequence, never another selected pointer', async () => {
  await scanSessions(); const sync = store.startSync(), reader = new EvidenceReader(getDb());
  const captured = JSON.parse(reader.freeze(sync.items[0])); reader.close();
  const [exact, omitted] = evidenceIdentities(captured);
  assert.notEqual(exact, omitted);
  assert.equal(evidenceIdentities({ ...captured, sequence: undefined, ref: 'C99', source_path: '/moved' })[0], omitted);
  for (const changed of [{ sequence: captured.sequence + 1 }, { cwd: '/other' }, { role: 'tool' }, { agent: 'other' },
    { source_key: 'other' }, { source_pointer: { ...captured.source_pointer, text_hash: 'other' } }]) {
    assert.ok(![exact, omitted].includes(evidenceIdentities({ ...captured, ...changed })[0]));
  }
  await edit('noop', sync.items[0].text);
  const fresh = new EvidenceReader(getDb());
  const extra = JSON.parse(fresh.freeze({ ...sync.items[0], sequence: undefined })); fresh.close();
  assert.notEqual(evidenceIdentities(extra)[0], omitted);
  const scope = new EvidenceScope(getDb(), [captured]); scope.assert(extra);
  await edit('conflict', 'Later body.', 'noop');
  scope.assert({ ...captured, sequence: undefined });
  assert.throws(() => scope.assert(extra), /unavailable|changed|excluded/);
});

test('fully overlapping completed leaves cannot discard a distinct same-key background pointer', async () => {
  await scanSessions(); const sync = store.startSync();
  await edit('overlap-noop', sync.items[0].text);
  const seed = new SummaryTree(sync, 0, signal());
  const a = seedLeaf(seed, sync.items), b = seedLeaf(seed, sync.items, [{ ...sync.items[0], sequence: undefined }]);
  const root = seedParent(seed, [a, b]); seed.leaves.close();
  await generateReply(sync.id, undefined, undefined, { deferHistory: true });
  assert.deepEqual(calls, ['final']);
  const result = store.getSync(sync.id);
  assert.equal(result.context.length, 1); assert.ok(result.tree.nodes.some(node => node.key === root.key));
  await edit('overlap-conflict', 'Conflicting body.', 'overlap-noop'); closeDb();
  await assert.rejects(generateReply(sync.id, 'Retry?', undefined, { deferHistory: true }), /unavailable|changed|excluded/);
  assert.deepEqual(calls, ['final']);
});

test('physical old selected edit is verified despite a same-key newer extra', async () => {
  await scanSessions(); await edit('old-selected-edit', 'Captured edited body.');
  const sync = store.startSync(); await edit('noop-selected-edit', sync.items[0].text, 'old-selected-edit');
  const seed = new SummaryTree(sync, 0, signal());
  const a = seedLeaf(seed, sync.items.slice(0, 1)), b = seedLeaf(seed, sync.items.slice(1), [{ ...sync.items[0], sequence: undefined }]);
  seedParent(seed, [a, b]); seed.leaves.close();
  await generateReply(sync.id, undefined, undefined, { deferHistory: true }); assert.deepEqual(calls, ['final']);
  // Alter only the old edit's physical bytes, keeping the newer no-op record intact.
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.split('\n').map(line => line.includes('"id":"old-selected-edit"') ? line.replace('Captured edited body.', 'Tampered edited body.') : line).join('\n'));
  closeDb();
  await assert.rejects(generateReply(sync.id, 'Retry?', undefined, { deferHistory: true }), /unavailable|changed/);
  await assert.rejects(live.createLiveCall(sync.id, signal()), /unavailable|changed/);
  assert.deepEqual(calls, ['final']); assert.deepEqual(nativeRequests, []);
});

function cacheRows() {
  return { outputs: getDb().prepare('SELECT * FROM summary_cache ORDER BY key').all(),
    receipts: getDb().prepare('SELECT * FROM summary_leaf_inputs ORDER BY key').all() };
}

for (const overlapping of [false, true]) test(`primary no-op selected pointer survives briefing, reopen and strict retry (overlap=${overlapping})`, async () => {
  await scanSessions(); const sync = store.startSync(), before = metadata(sync);
  await edit('primary-noop', sync.items[0].text);
  const selected = sync.items.map(item => ({ ...item }));
  const seed = new SummaryTree(store.getSync(sync.id), 0, signal());
  const a = seedLeaf(seed, selected, [], false, { ordinal: overlapping ? 2 : undefined });
  const root = overlapping ? seedParent(seed, [seedLeaf(seed, sync.items, [], false, { ordinal: 1 }), a]) : a;
  seed.leaves.close();
  const cache = cacheRows();
  await generateReply(sync.id, undefined, undefined, { deferHistory: true });
  assert.deepEqual(calls, ['final'], 'all valid completed leaves/root remain free');
  const after = metadata(sync), context = JSON.parse(after.context), plans = planRows();
  assert.deepEqual(after.items, before.items); assert.equal(context.length, 1);
  assert.equal(context[0].source_pointer.edit.entry_id, 'primary-noop');
  assert.deepEqual(cacheRows(), cache, 'cached receipt/output bytes are immutable');
  const result = store.getSync(sync.id);
  assert.equal(result.items.length, sync.items.length); assert.equal(result.tree.run.processed_entries, sync.items.length);
  assert.ok(result.tree.nodes.some(node => node.key === root.key));
  assert.equal(getDb().prepare('SELECT count(*) n FROM sync_coverage').get().n, 0, 'no implicit review');
  for (let n = 0; n < 2; n++) {
    closeDb(); await generateReply(sync.id, 'Unchanged retry?', undefined, { deferHistory: true });
    assert.deepEqual(metadata(sync), after); assert.deepEqual(planRows(), plans); assert.deepEqual(cacheRows(), cache);
  }
  assert.deepEqual(calls, ['final', 'final', 'final']);
  const briefing = store.getSync(sync.id).briefing;
  await edit('primary-conflict', 'Conflicting effective body.', 'primary-noop'); closeDb();
  await assert.rejects(generateReply(sync.id, 'Retry?', undefined, { deferHistory: true }), /unavailable|changed|excluded/);
  await assert.rejects(async () => {
    const call = await live.createLiveCall(sync.id, signal());
    await live.connectLiveCall(call.id, 'synthetic SDP', signal());
    await live.sendLiveText(call.id, 'Retry?', randomUUID());
  }, /unavailable|changed|excluded/);
  assert.deepEqual(calls, ['final', 'final', 'final']); assert.equal(probes, 0); assert.deepEqual(nativeRequests, []);
  assert.deepEqual(cacheRows(), cache); assert.deepEqual(metadata(sync), after); assert.deepEqual(planRows(), plans);
  assert.equal(store.getSync(sync.id).briefing, briefing);
});

for (const primary of [false, true]) test(`canonical final/tree/progress representative is E then first C (E=${primary})`, async () => {
  await scanSessions(); let sync = store.startSync();
  if (!primary) sync = moveToContext(sync);
  else {
    getDb().prepare('UPDATE syncs SET context_json=? WHERE id=?').run(JSON.stringify([{ ...JSON.parse(metadata(sync).items[0]), ref: 'C1' }]), sync.id);
    sync = store.getSync(sync.id);
  }
  const captured = primary ? sync.items[0] : sync.context[0], key = sourceKey(captured);
  await edit('representative-noop', captured.text);
  const extra = { ...captured, sequence: undefined };
  const seed = new SummaryTree(store.getSync(sync.id), 0, signal());
  const a = seedLeaf(seed, sync.items.slice(0, 1), sync.context, false, { cite: primary ? key : sourceKey(sync.context[0]) });
  const b = seedLeaf(seed, sync.items.slice(1), [extra], false, { cite: key });
  seedParent(seed, [a, b]); seed.leaves.close();
  const result = await generateReply(sync.id, undefined, undefined, { deferHistory: true });
  assert.deepEqual(calls, ['final']); assert.equal(result.context.at(-1).sequence, undefined);
  const final = payloads.at(-1);
  assert.equal(final.verification_evidence[0].sequence, captured.sequence);
  assert.equal(final.summary_tree[0].observations[0].evidence[0], final.verification_evidence[0].ref);
  assert.equal(result.briefing, `Unverified [${captured.ref}].`);
  assert.equal(store.getTreeNode(sync.id, a.key).refs[key], captured.ref);
  const tree = new SummaryTree(result, 0, signal());
  assert.equal(tree.sourceMap.get(key).ref, captured.ref);
  assert.equal(tree.dated(output(key), true).observations[0].source_positions[0].sequence, captured.sequence);
  assert.strictEqual(sourceRepresentatives(result.items, result.context).get(key), primary ? result.items[0] : result.context[0]);
  // An explicit lookup can still address the extra; canonical selection must
  // neither remove it nor promote it into the original planning scope.
  assert.ok(result.context.some(item => item.ref !== captured.ref && sourceKey(item) === key));
  await edit('representative-conflict', 'Later conflicting edit.', 'representative-noop'); closeDb();
  await assert.rejects(generateReply(sync.id, 'Retry?', undefined, { deferHistory: true }), /unavailable|changed|excluded/);
  assert.deepEqual(calls, ['final']);
});

for (const alias of ['current', 'legacy', 'both']) for (const boundary of ['cached', 'node'])
  test(`direct ${boundary} cannot rebind invalid ${alias} receipt to default packing`, async () => {
    await scanSessions(); const sync = store.startSync(); await edit('direct-noop', sync.items[0].text);
    const seed = new SummaryTree(sync, 0, signal());
    const original = seedLeaf(seed, sync.items.map(item => ({ ...item })), [], false, { batch: false });
    if (alias !== 'current') {
      getDb().prepare("INSERT INTO summary_cache SELECT ?,kind,model,'sync-tree-v1',output_json,created_at FROM summary_cache WHERE key=?").run(original.legacyKey, original.key);
      getDb().prepare('INSERT INTO summary_leaf_inputs SELECT ?,model,recipe,batch,input_json,output_hash FROM summary_leaf_inputs WHERE key=?').run(original.legacyKey, original.key);
      // Both case deliberately leaves a seemingly good output-only v2 entry.
      getDb().prepare('DELETE FROM summary_leaf_inputs WHERE key=?').run(original.key);
      if (alias === 'legacy') getDb().prepare('DELETE FROM summary_cache WHERE key=?').run(original.key);
    }
    seed.leaves.close(); await edit('direct-conflict', 'Changed body.', 'direct-noop'); closeDb();
    const tree = new SummaryTree(store.getSync(sync.id), 0, signal());
    const fallback = tree.leafSpec({ session: sid, workspace: sync.items[0].cwd, evidence: tree.sync.items, background: [] }, false, false);
    assert.equal(fallback.key, original.key, 'model input key does not prove selected pointer');
    const before = cacheRows();
    try {
      if (boundary === 'cached') assert.throws(() => tree.cached(fallback), /receipt|unavailable|changed/);
      else await assert.rejects(tree.node(fallback, validateSummary), /receipt|unavailable|changed/);
      assert.deepEqual(calls, []); assert.deepEqual(cacheRows(), before);
    } finally { tree.leaves?.close(); }
  });

for (const alias of ['current', 'legacy']) for (const receipt of [false, true]) test(`exact current-pointer ${alias} reuse remains free (receipt=${receipt})`, async () => {
  await scanSessions(); const sync = store.startSync(), tree = new SummaryTree(sync, 0, signal());
  const leaf = seedLeaf(tree, sync.items, [], false, { batch: false });
  const key = alias === 'legacy' ? leaf.legacyKey : leaf.key;
  if (alias === 'legacy') {
    getDb().prepare("UPDATE summary_cache SET key=?,prompt_version='sync-tree-v1' WHERE key=?").run(key, leaf.key);
    getDb().prepare('UPDATE summary_leaf_inputs SET key=? WHERE key=?').run(key, leaf.key);
  }
  if (!receipt) getDb().exec('DELETE FROM summary_leaf_inputs');
  const before = cacheRows();
  const fallback = tree.leafSpec({ ...leaf.leafInput, evidence: leaf.leafInput.evidence.map(item => {
    const reader = new EvidenceReader(getDb());
    try { return reader.read({ ...JSON.parse(reader.freeze(item)), ref: 'C99' }); } finally { reader.close(); }
  }) }, false, false);
  try {
    assert.equal(tree.cached(fallback), true);
    assert.deepEqual(await tree.node(fallback, validateSummary), leaf.summary);
    assert.deepEqual(calls, []);
    if (receipt) assert.equal(JSON.parse(getDb().prepare('SELECT input_json FROM summary_leaf_inputs WHERE key=?').get(key).input_json).evidence[0].ref, sync.items[0].ref);
    if (receipt && alias === 'current') assert.deepEqual(cacheRows(), before, 'ref transport cannot rewrite known receipt bytes');
  } finally { tree.leaves?.close(); }
});

for (const dependency of ['primary', 'background']) test(`restored pending ${dependency} pointer stays strict after briefing and reopen`, async () => {
  await scanSessions(); let sync = store.startSync(); if (dependency === 'background') sync = moveToContext(sync);
  const captured = dependency === 'primary' ? sync.items[0] : sync.context[0], before = metadata(sync);
  await edit('pending-noop', captured.text);
  const pending = SummaryTree.forBackground({ items: sync.items.map(item => ({ ...item })),
    context: sync.context.map(item => ({ ...item })), models: sync.models }, 0, signal());
  const specs = await pending.batchSpecs(); pending.leaves?.close();
  assert.equal(specs.length, 1); assert.equal(cacheRows().receipts.length, 0);
  const plans = planRows();
  await generateReply(sync.id);
  assert.deepEqual(calls, ['chunk', 'final']);
  const after = metadata(sync), extra = JSON.parse(after.context).at(-1), cache = cacheRows();
  assert.equal(extra.source_pointer.edit.entry_id, 'pending-noop');
  assert.equal(JSON.parse(after.context).length, sync.context.length + 1);
  assert.deepEqual(after.items, before.items); assert.deepEqual(JSON.parse(after.context).slice(0, sync.context.length), JSON.parse(before.context));
  assert.equal(cache.receipts.length, 1);
  const input = JSON.parse(cache.receipts[0].input_json);
  assert.equal(input[dependency === 'primary' ? 'evidence' : 'background'][0].source_pointer.edit.entry_id, 'pending-noop');
  assert.deepEqual(JSON.parse(getDb().prepare('SELECT refs_json FROM summary_planning_context WHERE sync_id=?').get(sync.id).refs_json), sync.context.map(item => item.ref));
  const completedPlans = planRows();
  for (let n = 0; n < 2; n++) {
    closeDb(); await generateReply(sync.id, 'Unchanged?', undefined, { deferHistory: true });
    assert.deepEqual(metadata(sync), after); assert.deepEqual(cacheRows(), cache); assert.deepEqual(planRows(), completedPlans);
  }
  assert.deepEqual(planRows().filter(row => plans.some(plan => plan.identity === row.identity)), plans);
  assert.deepEqual(calls, ['chunk', 'final', 'final', 'final']);
  await edit('pending-conflict', 'Different effective body.', 'pending-noop'); closeDb();
  await assert.rejects(async () => {
    const call = await live.createLiveCall(sync.id, signal());
    await live.connectLiveCall(call.id, 'synthetic SDP', signal());
    await live.sendLiveText(call.id, 'Retry?', randomUUID());
  }, /unavailable|changed|excluded/);
  await assert.rejects(generateReply(sync.id, 'Retry?', undefined, { deferHistory: true }), /unavailable|changed|excluded/);
  assert.deepEqual(calls, ['chunk', 'final', 'final', 'final']); assert.equal(probes, 0); assert.deepEqual(nativeRequests, []);
  assert.deepEqual(metadata(sync), after); assert.deepEqual(cacheRows(), cache); assert.deepEqual(planRows(), completedPlans);
});

for (const cached of [false, true]) test(`direct leaf boundary retains ALL actual input representations (cached=${cached})`, async () => {
  await scanSessions(); const sync = store.startSync(); await edit('boundary-noop', sync.items[0].text);
  const tree = new SummaryTree(sync, 0, signal()), selected = sync.items.map(item => ({ ...item }));
  const spec = cached ? seedLeaf(tree, selected) : tree.leafSpec({ session: sid, workspace: selected[0].cwd, evidence: selected, background: [] }, true, false);
  try { await tree.node(spec, validateSummary); } finally { tree.leaves?.close(); }
  assert.deepEqual(calls, cached ? [] : ['chunk']);
  const after = metadata(sync), cache = cacheRows();
  assert.equal(JSON.parse(after.context).length, 1);
  assert.equal(JSON.parse(after.context)[0].source_pointer.edit.entry_id, 'boundary-noop');
  assert.deepEqual(JSON.parse(getDb().prepare('SELECT refs_json FROM summary_planning_context WHERE sync_id=?').get(sync.id).refs_json), []);
  await edit('boundary-conflict', 'Changed body.', 'boundary-noop'); closeDb();
  const retry = new SummaryTree(store.getSync(sync.id), 0, signal());
  await assert.rejects(retry.beforePreparation(), /unavailable|changed|excluded/);
  assert.throws(() => require('../dist/sync/evidence-scope').verifySyncEvidence(getDb(), sync.id), /unavailable|changed|excluded/);
  assert.deepEqual(calls, cached ? [] : ['chunk']); assert.deepEqual(cacheRows(), cache); assert.deepEqual(metadata(sync), after);
});

for (const broken of ['unreadable', 'wrong-key', 'stale-primary']) test(`known completed overlap stops before repacking: ${broken}`, async () => {
  await scanSessions(); const sync = store.startSync(); await edit('overlap-primary-noop', sync.items[0].text);
  const seed = new SummaryTree(sync, 0, signal());
  const leaf = seedLeaf(seed, sync.items.slice(0, 2).map(item => ({ ...item }))); seed.leaves.close();
  getDb().prepare("INSERT INTO sync_tree_nodes(sync_id,key,kind,label,status,children_json,source_count) VALUES (?,?,'chunk','Synthetic','done','[]',2)").run(sync.id, leaf.key);
  if (broken === 'unreadable') getDb().prepare("UPDATE summary_leaf_inputs SET input_json='{' WHERE key=?").run(leaf.key);
  if (broken === 'wrong-key') {
    const input = JSON.parse(getDb().prepare('SELECT input_json FROM summary_leaf_inputs WHERE key=?').get(leaf.key).input_json);
    input.chronological_chunk = 123;
    getDb().prepare('UPDATE summary_leaf_inputs SET input_json=? WHERE key=?').run(JSON.stringify(input), leaf.key);
  }
  if (broken === 'stale-primary') await edit('overlap-primary-conflict', 'Different body.', 'overlap-primary-noop');
  closeDb(); const before = cacheRows();
  await assert.rejects(generateReply(sync.id, undefined, undefined, { deferHistory: true }), /receipt|unavailable|changed/);
  assert.deepEqual(calls, []); assert.deepEqual(cacheRows(), before);
});
