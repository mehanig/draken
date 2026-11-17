require('./fixtures/fake-memory.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const memory = require('../dist/memory/service');
const { getDb, closeDb } = require('../dist/db/schema');
const { conversationStatus, captureConversationHistory } = require('../dist/sync/conversation');
const { callReadiness } = require('../dist/sync/preparation');
const { activity } = require('../dist/sync/activity');

test('status polls and prepared turn admission never scan history; initial preparation is not New info ready', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-polling-'));
  process.env.DRAKEN_DATA_DIR = root;
  const ready = memory.historyReadiness, status = memory.historyPreparationStatus;
  let release;
  try {
    const before = new Date().toISOString(), db = getDb();
    const id = Number(db.prepare("INSERT INTO syncs(created_at,snapshot_at,briefing,compression_complete,conversation_before) VALUES(?,?,'briefing',1,?)").run(before,before,before).lastInsertRowid);
    memory.historyPreparationStatus = () => ({ ready: true, before });
    memory.historyReadiness = () => { throw Error('Full history verification boundary'); };
    const changes = db.prepare('SELECT total_changes() n').get().n;
    for (let n=0;n<100;n++) { assert.equal(conversationStatus(id).update_state,'up_to_date'); assert.equal(callReadiness(id).ready,true); }
    assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
    assert.equal(captureConversationHistory(id),before);
    db.prepare("UPDATE syncs SET briefing='',compression_complete=0,conversation_before=NULL WHERE id=?").run(id);
    release = activity.beginJob(id,new AbortController());
    assert.equal(conversationStatus(id).update_state,'preparing'); assert.equal(callReadiness(id).ready,false);
  } finally { release?.(); memory.historyReadiness=ready; memory.historyPreparationStatus=status; closeDb(); fs.rmSync(root,{recursive:true,force:true}); }
});

test('checkpoint-only status reads no corpus tables; actual readiness retains source validation', () => {
  const { indexReadiness } = require('../dist/memory/readiness');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');
    const put=db.prepare('INSERT INTO meta VALUES(?,?)'), before=new Date().toISOString();
    put.run('schema','history-index-v3-contentless'); put.run('model','synthetic');
    put.run('call-history-ready-v1',JSON.stringify({version:2,before,stamp:'0'.repeat(64),model:'synthetic'}));
    assert.deepEqual(indexReadiness(db,null),{ready:true,before});
    assert.deepEqual(indexReadiness(db,db),{ready:false,before:null},'A marker alone cannot authorize actual use; missing corpus tables fail closed');
    db.prepare("UPDATE meta SET value='invalid' WHERE key='call-history-ready-v1'").run();
    assert.deepEqual(indexReadiness(db,null),{ready:false,before:null});
  } finally { db.close(); }
});
