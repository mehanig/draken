require('./fixtures/fake-memory.cjs');
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const express = require('express');
const { getDb, closeDb } = require('../dist/db/schema');
const { EvidenceReader } = require('../dist/db/evidence');
const { frozenEvidence } = require('./fixtures/source-entry.cjs');

test('48 MB of frozen originals never enter sync responses; evidence browsing and reads are bounded and permission checked', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-evidence-http-'));
  t.after(() => { closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
  process.env.DRAKEN_DATA_DIR = root; process.env.DRAKEN_PI_SESSIONS_DIR = path.join(root, 'sessions');
  const db = getDb(), now = new Date().toISOString();
  const id = Number(db.prepare("INSERT INTO syncs(created_at,snapshot_at,briefing,compression_complete,conversation_before) VALUES(?,?,'Briefing [E1]',1,?)").run(now, now, now).lastInsertRowid);
  const put = db.prepare('INSERT INTO sync_items(sync_id,event_key,evidence_json) VALUES(?,?,?)');
  let first, sourceText;
  db.transaction(() => { for (let i = 1; i <= 8000; i++) {
    const text = `Original ${i}: ` + 'retained original text '.repeat(280);
    const item = frozenEvidence(db, process.env.DRAKEN_PI_SESSIONS_DIR, text, { id: i === 1 ? 'large-entry-' + 'x'.repeat(100000) : String(i), ref: `E${i}` });
    put.run(id, item.event_key, JSON.stringify(item));
    if (i === 1) { first = item; sourceText = require('../dist/sync/normalize').cleanText(text, 6000); }
  } })();
  assert.ok(db.prepare('SELECT sum(effective_length) n FROM agent_entries').get().n > 48_000_000);
  db.prepare('UPDATE syncs SET context_json=? WHERE id=?').run(JSON.stringify([{ ...first, ref: 'C1' }]), id);
  const requestId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  db.prepare('INSERT INTO sync_presentations(sync_id,request_id,memory_inputs_json) VALUES(?,?,?)').run(id, requestId, '[]');
  const app = express(); app.use(express.json()); app.use(require('../dist/routes/sync').default);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/syncs/${id}`;
  const read = EvidenceReader.prototype.read; let reads = 0;
  EvidenceReader.prototype.read = function (...args) { reads++; return read.apply(this, args); };
  const json = async (url, options) => { const res = await fetch(url, options); assert.equal(res.status, 200); return res.json(); };
  const changes = db.prepare('SELECT total_changes() n').get().n;
  try {
    for (const suffix of ['', '?evidence=false', '?evidence=true']) {
      const response = await fetch(base + suffix), wire = await response.text(), body = JSON.parse(wire);
      assert.ok(Buffer.byteLength(wire) < 20_000); assert.equal(body.item_count, 8000);
      assert.deepEqual(body.items, []); assert.deepEqual(body.context, []); assert.equal(reads, 0);
    }
    const page = await json(base + '/evidence'); assert.equal(page.items.length, 25); assert.equal(page.total, 8000);
    assert.ok(page.items.every(item => !('text' in item) && !('source_pointer' in item)));
    const next = await json(base + '/evidence?offset=25'); assert.equal(next.items.length, 25);
    assert.ok(next.items.every(item => !page.items.some(old => old.ref === item.ref)));
    assert.equal((await json(base + '/evidence?offset=7990')).items.length, 10);
    assert.equal((await json(base + '/evidence?group=context')).total, 1);
    assert.equal((await json(base + '/evidence?q=E8000')).total, 1); assert.equal(reads, 0);
    const retry = await fetch(base.replace(`/syncs/${id}`, '/syncs/start-chat'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: requestId }) });
    assert.equal(retry.status, 202); assert.deepEqual((await retry.json()).sync.items, []); assert.equal(reads, 0);
    for (const ref of ['E1', 'C1']) {
      const excerpt = await json(base + `/evidence?ref=${ref}`);
      assert.equal(excerpt.item.text, sourceText.slice(0, 4000)); assert.equal(excerpt.total, sourceText.length); assert.ok(excerpt.item.entry_id.length <= 220, 'display metadata is bounded too');
      assert.ok(Buffer.byteLength(JSON.stringify(excerpt)) < 10_000); assert.equal(excerpt.item.source_pointer, undefined);
    }
    assert.equal(reads, 2);
    assert.equal((await json(base + '/evidence?ref=E1&offset=4000')).item.text, sourceText.slice(4000, 8000));
    assert.equal(reads, 3); assert.equal(db.prepare('SELECT total_changes() n').get().n, changes);
    for (const query of ['offset=-1', 'offset=NaN', 'offset=1.5', 'offset=10000001', 'group=all', 'ref=E1,E2', 'ref=../../x', 'q=' + 'x'.repeat(201)]) {
      assert.equal((await fetch(base + '/evidence?' + query)).status, 400);
    }
    assert.equal((await fetch(base + '/evidence?ref=E99999')).status, 404); assert.equal(reads, 3);
    db.prepare('DELETE FROM agent_entries').run();
    assert.equal((await json(base + '/evidence?ref=E1')).item.text, sourceText.slice(0, 4000), 'frozen pointers survive current-row deletion');
    db.prepare('UPDATE agent_sessions SET included=0').run();
    const before = reads; assert.equal((await fetch(base + '/evidence?ref=E1')).status, 403); assert.equal(reads, before);
    db.prepare('UPDATE agent_sessions SET included=1').run();
    fs.renameSync(first.source_path, first.source_path + '.hidden');
    const unavailable = await json(base + '/evidence?ref=E1'); assert.equal(unavailable.item.text, ''); assert.match(unavailable.item.unavailable, /unavailable/);
    assert.deepEqual((await json(base)).items, []);
    const notes = await json(base + '/notes', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions: 'Saved note', carry_forward: '' }) });
    assert.equal(notes.decisions, 'Saved note'); assert.deepEqual(notes.items, []); assert.deepEqual(notes.context, []);
  } finally {
    EvidenceReader.prototype.read = read; await new Promise(resolve => server.close(resolve));
  }
});
