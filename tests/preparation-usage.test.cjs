const { test } = require('node:test');
const assert = require('node:assert/strict'), Database = require('better-sqlite3');
const { preparationUsage } = require('../dist/sync/usage');
const now = Date.parse('2026-02-01T12:00:00.000Z');
const at = hour => `2026-02-01T${String(hour).padStart(2, '0')}:00:00.000Z`;
const metric = (hour, cost) => ({ started_at: at(hour), status: 'completed', accounting: { source: 'pi-usage/catalog-pricing', cost_usd: cost, complete: true } });
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sync_runs(id INTEGER PRIMARY KEY,sync_id INTEGER,question TEXT,status TEXT,started_at TEXT,completed_at TEXT,invocations INTEGER,metrics_json TEXT,total_entries INTEGER);
    CREATE TABLE background_runs(id INTEGER PRIMARY KEY,status TEXT,started_at TEXT,completed_at TEXT,invocations INTEGER,metrics_json TEXT,total_entries INTEGER,failure_events_json TEXT NOT NULL DEFAULT '[]');`);
  return db;
}
test('background cost, failures, missing accounting and active requests are visible without inflating explicit-sync completion counts', () => {
  const db = fixture();
  try {
    db.prepare('INSERT INTO sync_runs VALUES (1,1,NULL,?,?,?,?,?,64)').run('completed', at(7), at(8), 1, JSON.stringify([metric(7, .1)]));
    const insert = db.prepare('INSERT INTO background_runs VALUES (?,?,?,?,?,?,?,?)');
    insert.run(1, 'completed', at(6), at(7), 1, JSON.stringify([metric(6, .2)]), 192, '[]');
    insert.run(2, 'failed', at(8), at(9), 2, JSON.stringify([metric(8, .3)]), 256, JSON.stringify([{ status: 'failed', at: at(9) }]));
    insert.run(3, 'running', at(10), null, 1, JSON.stringify([{ started_at: at(10), status: 'running' }]), 320, '[]');
    insert.run(4, 'interrupted', at(9), at(10), 0, '[]', 384, JSON.stringify([{ status: 'interrupted', at: at(10) }]));
    const before = db.prepare('SELECT total_changes() n').get().n;
    const result = preparationUsage(db, { range: '6h', bucket: '1h' }, now);
    assert.equal(result.totals.requests, 5); assert.ok(Math.abs(result.totals.cost.usd - .6) < 1e-10);
    assert.equal(result.totals.cost.complete, false); assert.equal(result.totals.incomplete_pricing, 2); assert.equal(result.totals.approximate_timing, 1);
    assert.equal(result.active_attempts, 1); assert.equal(result.totals.failed_attempts, 2);
    assert.equal(result.totals.completed_batches, 1); assert.equal(result.totals.entries, 64);
    assert.equal(result.buckets.reduce((total, bin) => total + bin.requests, 0), 5);
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
    db.prepare("UPDATE background_runs SET metrics_json='{}' WHERE id=1").run();
    assert.throws(() => preparationUsage(db, {}, now), /metadata could not be read/);
  } finally { db.close(); }
});
test('resuming one ledger row retains earlier cancelled and interrupted paid failures without double counting its terminal failure', () => {
  const db = fixture();
  try {
    const metrics = [{ started_at: at(6), finished_at: at(7), status: 'cancelled' }, { started_at: at(8), status: 'running' }, metric(10, .25)];
    db.prepare('INSERT INTO background_runs VALUES (1,?,?,?,?,?,192,?)').run('completed', at(6), at(11), 3, JSON.stringify(metrics),
      JSON.stringify([{ status: 'cancelled', at: at(7) }, { status: 'interrupted', at: at(9) }]));
    let result = preparationUsage(db, { range: '6h' }, now);
    assert.equal(result.totals.requests, 3); assert.equal(result.totals.failed_attempts, 2); assert.equal(result.active_attempts, 0);
    metrics[2] = { started_at: at(10), finished_at: at(11), status: 'failed' };
    db.prepare("UPDATE background_runs SET status='failed',metrics_json=?,failure_events_json=json_insert(failure_events_json,'$[#]',json(?)) WHERE id=1")
      .run(JSON.stringify(metrics), JSON.stringify({ status: 'failed', at: at(11) }));
    result = preparationUsage(db, { range: '6h' }, now); assert.equal(result.totals.failed_attempts, 3, 'terminal failed request is not counted twice');
  } finally { db.close(); }
});
test('corrupt attempt-event accounting fails visibly instead of inventing a zero failure count', () => {
  const db = fixture();
  try {
    db.prepare("INSERT INTO background_runs VALUES (1,'completed',?,?,0,'[]',64,'[]')").run(at(6), at(7));
    for (const invalid of ['{}', '[null]', JSON.stringify([{ status: 'cancelled', at: 'not-a-time' }])]) {
      db.prepare('UPDATE background_runs SET failure_events_json=?').run(invalid);
      assert.throws(() => preparationUsage(db, {}, now), /metadata could not be read/);
    }
  } finally { db.close(); }
});

test('resumed background metrics retain original per-call timing across reporting windows', () => {
  const db = fixture();
  try {
    db.prepare('INSERT INTO background_runs VALUES (1,?,?,?,?,?,192,?)').run('completed', '2026-01-01T00:00:00.000Z', at(11), 2,
      JSON.stringify([{ ...metric(6, 100), started_at: '2026-01-01T00:00:00.000Z' }, metric(10, .25)]),
      JSON.stringify([{ status: 'interrupted', at: '2026-01-01T01:00:00.000Z' }, { status: 'cancelled', at: at(11) }]));
    const result = preparationUsage(db, { range: '6h' }, now);
    assert.equal(result.totals.requests, 1); assert.equal(result.totals.cost.usd, .25); assert.equal(result.totals.failed_attempts, 1);
    assert.equal(result.totals.entries, 0); assert.equal(result.totals.completed_batches, 0);
  } finally { db.close(); }
});
