// Independent synthetic review: never use live data or providers.
require('./fixtures/fake-memory.cjs');
const {test, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {randomUUID} = require('node:crypto');
const {getDb, closeDb} = require('../dist/db/schema');
const {scanSessions} = require('../dist/sync/collector');
const store = require('../dist/sync/store');
const {SummaryTree} = require('../dist/sync/tree');
const {checkpointIdentity, checkpointContent} = require('../dist/sync/reusable-leaves');
const {LUNA_BATCH} = require('../dist/sync/summary-budget');
const {digest} = require('../dist/sync/normalize');
const preview = require('../dist/sync/preparation-preview');
const {activity} = require('../dist/sync/activity');
let root, calls, server;
const provider = SummaryTree.prototype.call;
beforeEach(async () => {
 root = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-preview-data-'));
 fs.mkdirSync(root+'/sessions');
 Object.assign(process.env, {DRAKEN_DATA_DIR: root+'/state', DRAKEN_PI_SESSIONS_DIR: root+'/sessions', DRAKEN_PI_BIN:'/nonexistent-provider', DRAKEN_PI_SUMMARY_MODEL:'openai/gpt-6-luna',DRAKEN_PI_FINAL_MODEL:'synthetic/final',DRAKEN_NO_AUTH:'true'});
 calls=0; SummaryTree.prototype.call=async()=>{calls++;throw Error('Provider forbidden');};
 const id=randomUUID();
 const rows=[{type:'session',version:3,id,cwd:'/fixture',timestamp:'2026-01-01T00:00:00Z'}, ...Array.from({length:5},(_,n)=>({type:'message',id:'m'+n,parentId:n?'m'+(n-1):null,timestamp:new Date(Date.UTC(2026,0,1,0,n)).toISOString(),message:{role:n?'assistant':'user',content:[{type:'text',text:'Independent source '+n}]}}))];
 fs.writeFileSync(root+'/sessions/'+id+'.jsonl',rows.map(JSON.stringify).join('\n')+'\n');
 await scanSessions();
});
afterEach(async()=>{
 await activity.drainPreview();
 await require('../dist/memory/service').stopHistory();
 if(server){await new Promise(r=>server.close(r));server=undefined;}
 assert.equal(calls,0); SummaryTree.prototype.call=provider;
 closeDb(); fs.rmSync(root,{recursive:true,force:true});
});
const turn=()=>new Promise(r=>setImmediate(r));
async function finish(){const deadline=Date.now()+20000;while(Date.now()<deadline){const v=preview.preparationPreview();if(v.phase!=='checking')return v;await new Promise(r=>setTimeout(r,5));}throw Error('timeout');}
async function verify(){preview.requestPreparationPreview();return finish();}
function brokenReceipt(input) {
 const tree=SummaryTree.forPreview(input,new AbortController().signal);
 try {
  const leaf={session:input.items[0].session_id,workspace:input.items[0].cwd,evidence:[input.items[0],input.items[2]],background:[]};
  const spec=tree.leafSpec(leaf,true), output=JSON.stringify({observations:[],limitations:['Synthetic completed processing']});
  const db=getDb();
  db.prepare('INSERT INTO summary_cache(key,kind,model,prompt_version,output_json,created_at) VALUES (?,?,?,?,?,?)').run(spec.key,'chunk',input.models.summary,LUNA_BATCH.version,output,'2026-01-02T00:00:00Z');
  tree.leafStore().save(spec.key,input.models.summary,tree.leafRecipe(true),true,'{}',output);
  return {key:spec.key,hash:digest(output)};
 } finally {tree.leaves?.close();}
}
test('REGRESSION: background-run provenance changes must invalidate a ready proof',async()=>{
 const input=store.previewSummaryInput(), receipt=brokenReceipt(input);
 const before=await verify(); assert.equal(before.phase,'ready'); assert.equal(before.needs_processing,5);
 getDb().prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,input_key,source_keys_json,cache_receipt_json) VALUES (?,?,?,?,?,?,?,?)`).run(input.models.summary,input.models.final,10,5,'2026-01-01T00:00:00Z','synthetic',JSON.stringify({keys:input.items.map(i=>[checkpointIdentity(i),checkpointContent(i)])}),JSON.stringify([[receipt.key,receipt.hash]]));
 const poll=preview.preparationPreview();
 const post=preview.requestPreparationPreview();
 const fresh=SummaryTree.forPreview(store.previewSummaryInput(),new AbortController().signal);
 await assert.rejects(fresh.previewCounts(), /completed leaf receipt is unavailable/);
 console.log('Independent artifact evidence:',JSON.stringify({poll,post,fresh:'refused unresolved completed receipt'}));
 assert.equal(poll.phase,'stale','GET retained a ready all-uncached count after planner-relevant metadata changed');
});
test('CONTROL: history read GET drains preview before admitting a native read',async()=>{
 const cp=require('node:child_process'), {EventEmitter}=require('node:events'), originalFork=cp.fork;
 let forked=0, release;
 const retirement=new Promise(r=>release=r);
 const worker=require('./fixtures/preview-worker.cjs').install({hold:'before',retirement});
 cp.fork=()=>{forked++;const child=new EventEmitter();child.pid=12345;child.exitCode=null;child.signalCode=null;child.send=(msg,cb)=>{cb?.();setImmediate(()=>child.emit('message',{id:msg.id,value:{text:'synthetic',ref:'H'+'a'.repeat(24)}}));};child.kill=()=>{setImmediate(()=>{child.signalCode='SIGTERM';child.emit('exit',null,'SIGTERM');});return true;};return child;};
 try {
  server=require('../dist/server').createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  preview.requestPreparationPreview();await worker.entered;
  let settled=false;const read=fetch(`http://127.0.0.1:${server.address().port}/api/memory/records/H${'a'.repeat(24)}`).then(r=>{settled=true;return r;});
  await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);assert.equal(forked,0);
  release();const response=await read;assert.equal(response.status,200,await response.text());assert.equal(forked,1);
 }finally {release();worker.release();await activity.drainPreview();worker.restore();await require('../dist/memory/service').stopHistory();cp.fork=originalFork;}
});
test('CONTROL: unchanged scans preserve the proof; actual source disappearance invalidates it',async()=>{
 const ready=await verify();assert.equal(ready.phase,'ready');
 for(let n=0;n<3;n++){await scanSessions();assert.deepEqual(preview.preparationPreview(),ready);}
 for(const file of fs.readdirSync(root+'/sessions'))fs.unlinkSync(root+'/sessions/'+file);
 await scanSessions();assert.equal(preview.preparationPreview().phase,'stale');assert.equal((await verify()).total,0);
});
