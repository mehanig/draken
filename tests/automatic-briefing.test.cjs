// Regression name retained: automatic indexing must never prepare a briefing.
require('./fixtures/fake-memory.cjs');
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {getDb,closeDb}=require('../dist/db/schema'),store=require('../dist/sync/store'),service=require('../dist/memory/service');
const {activity}=require('../dist/sync/activity');
const {scanSessions}=require('../dist/sync/collector'),{generateReply,cancelReply}=require('../dist/sync/manager');
const {sourceStamps}=require('../dist/memory/stamps');
const {createAutoIndexer,autoIndexSettings,startBackgroundIndexing,stopBackgroundIndexing}=require('../dist/sync/background');
let root,log,control,server,originalPrepare;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-no-auto-briefing-'));fs.mkdirSync(root+'/sessions');const fake=root+'/pi';fs.copyFileSync(path.join(__dirname,'fixtures/fake-pi.cjs'),fake);fs.chmodSync(fake,0o700);log=root+'/calls.jsonl';control=root+'/control.json';fs.writeFileSync(control,'{}');Object.assign(process.env,{DRAKEN_DATA_DIR:root+'/state',DRAKEN_PI_SESSIONS_DIR:root+'/sessions',DRAKEN_PI_BIN:fake,DRAKEN_PI_SUMMARY_MODEL:'test/cheap',DRAKEN_PI_FINAL_MODEL:'test/strong',DRAKEN_TEST_CALL_LOG:log,DRAKEN_FAKE_CONTROL:control,DRAKEN_HOST:'127.0.0.1',DRAKEN_NO_AUTH:'true'});delete process.env.DRAKEN_PI_MAX_INVOCATIONS;originalPrepare=service.prepareHistory;});
afterEach(async()=>{await stopBackgroundIndexing();for(const id of activity.busyIds)cancelReply(id);await until(()=>!activity.busy);if(server)await new Promise(r=>server.close(r));server=null;service.prepareHistory=originalPrepare;assert.equal(activity.busy,false);closeDb();fs.rmSync(root,{recursive:true,force:true});});
function session(n){const id=randomUUID(),timestamp='2026-01-01T00:00:00Z';fs.writeFileSync(root+'/sessions/'+id+'.jsonl',[{type:'session',version:3,id,cwd:'/synthetic/beacon',timestamp},...Array.from({length:n},(_,i)=>({type:'message',id:String(i),parentId:i?String(i-1):null,timestamp,message:{role:i?'assistant':'user',content:'Beacon '+id+' synthetic implementation checkpoint '+i+'; deployment not verified.'}}))].map(JSON.stringify).join('\n')+'\n');return id;}
const calls=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const count=t=>getDb().prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
async function until(check){for(let i=0;i<500;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out waiting for synthetic work');}
async function post(route,body){if(!server){server=require('../dist/server').createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));}const res=await fetch(`http://127.0.0.1:${server.address().port}/api${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await res.json();assert.equal(res.status,202,JSON.stringify(value));return value;}
function scheduler(){let baseline=new Map();return createAutoIndexer({enabled:()=>true,idle:()=>!activity.busy&&!activity.callActive,now:Date.now,scan:scanSessions,stamp:before=>sourceStamps(getDb(),before),baseline:()=>baseline,prepare:async(before,signal)=>{await service.prepareHistory(before,signal,true);baseline=sourceStamps(getDb(),before);},completed:()=>{}});}
const historyTables=['syncs','sync_items','sync_presentations','sync_runs','sync_tree_nodes','summary_cache','sync_recap_cache','sync_messages','sync_coverage','live_calls','voice_calls'];
function history(){return Object.fromEntries(historyTables.map(table=>[table,getDb().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));}
function noSyncs(){for(const table of historyTables)assert.equal(count(table),0,table);assert.deepEqual(calls(),[]);}

// No automatic module is imported: all generation below is explicitly user-owned.
test('an already indexed available backlog is not a briefing trigger; each scan keeps accumulating entries',async()=>{
 session(70);await scanSessions();let indexed=0,now=Date.now(),scans=0;
 const worker=createAutoIndexer({enabled:()=>true,idle:()=>true,now:()=>now,scan:async()=>{scans++;return scanSessions();},stamp:()=>new Map(),baseline:()=>new Map(),prepare:async()=>{indexed++;},completed:()=>{}});
 for(let n=0;n<3;n++){await worker.tick();assert.equal(indexed,0);assert.equal(worker.state.pending_records,0);assert.equal(store.availableCount(),70);noSyncs();}
 session(1);now+=86400000;await worker.tick();assert.equal(scans,4);assert.equal(store.availableCount(),71);assert.equal(indexed,0);noSyncs();
});

for(const ready of [true,false])test(`legacy ${ready?'ready':'cancelled'} automatic snapshots remain ordinary unchanged history, never claimed or resumed`,async t=>{
 session(64);await scanSessions();const legacy=store.startConversationSync(randomUUID()),autoRequest='auto:'+randomUUID();
 getDb().prepare('UPDATE sync_presentations SET request_id=? WHERE sync_id=?').run(autoRequest,legacy.id);
 if(ready)getDb().prepare("UPDATE syncs SET briefing='Legacy prepared briefing [E1]',compression_complete=1 WHERE id=?").run(legacy.id);
 else getDb().prepare("INSERT INTO sync_runs(sync_id,status,summary_model,final_model,max_invocations,total_entries,started_at,completed_at) VALUES (?,'cancelled','test/cheap','test/strong',10,64,?,?)").run(legacy.id,'2026-01-01','2026-01-01');
 // Reconstruct obsolete durable background ownership from the previous release.
 const save=getDb().prepare('INSERT OR REPLACE INTO sync_settings(key,value) VALUES (?,?)');
 save.run('auto_prepare_conversations','true');save.run('auto_preparing_sync',String(legacy.id));save.run('auto_briefing_failed','Legacy provider failure');
 const before=history();closeDb();assert.equal(autoIndexSettings().enabled,true);assert.deepEqual(history(),before);
 for(const key of ['auto_prepare_conversations','auto_preparing_sync','auto_briefing_failed'])assert.equal(getDb().prepare('SELECT value FROM sync_settings WHERE key=?').get(key),undefined);
 t.mock.timers.enable({apis:['setInterval']});
 try{
  startBackgroundIndexing();
  for(let n=0;n<2;n++){t.mock.timers.tick(60000);await until(()=>!['scanning','indexing'].includes(autoIndexSettings().phase));assert.equal(autoIndexSettings().phase,'waiting');assert.ok(autoIndexSettings().last_completed_at);assert.deepEqual(history(),before);assert.deepEqual(calls(),[]);}
 }finally{await stopBackgroundIndexing();t.mock.timers.reset();}
 closeDb();assert.deepEqual(history(),before);
 assert.equal(store.homeOverview().syncs.some(row=>row.id===legacy.id),true);
 assert.equal(store.startConversationSync(autoRequest).id,legacy.id,'only the same request ID reuses a snapshot');
 if(!ready){session(2);await scanSessions();}
 const requestId=randomUUID(),next=store.startConversationSync(requestId);
 assert.notEqual(next.id,legacy.id,'a new user request must not claim even an empty-tail ready snapshot');
 assert.equal(next.items.length,ready?0:2);assert.equal(store.startConversationSync(requestId).id,next.id);
 assert.equal(next.memory[0].sync_id,legacy.id);
 for(const table of ['syncs','sync_items','sync_presentations','sync_runs']){
  const key=table==='syncs'?'id':'sync_id';
  assert.deepEqual(getDb().prepare(`SELECT * FROM ${table} WHERE ${key}=? ORDER BY rowid`).all(legacy.id),before[table]);
 }
 assert.equal(count('sync_coverage'),0);assert.deepEqual(calls(),[]);
});

test('only an explicit Home request creates and generates a complete snapshot; transport retries do not pay twice',async()=>{
 session(70);await scheduler().tick();noSyncs();assert.equal(store.availableCount(),70);
 session(5);await scanSessions();assert.equal(store.availableCount(),75);noSyncs();
 const request_id=randomUUID(),first=await post('/syncs/start-chat',{request_id});
 assert.equal(first.sync.items.length,75);assert.equal((await post('/syncs/start-chat',{request_id})).sync.id,first.sync.id);
 await until(()=>!activity.busy);assert.ok(store.getSync(first.sync.id).briefing);
 assert.equal(count('syncs'),1);assert.equal(count('sync_items'),75);assert.equal(store.availableCount(),0);
 const paid=calls().length;assert.ok(paid>=2);assert.equal(calls().find(call=>call.task==='final_verdict').snapshot.processed_entries,75);
 assert.equal((await post('/syncs/start-chat',{request_id})).sync.id,first.sync.id);assert.equal(calls().length,paid);
 const before=history();await scheduler().tick();assert.deepEqual(history(),before);assert.equal(calls().length,paid);
 for(const table of ['sync_coverage','sync_messages','live_calls','voice_calls'])assert.equal(count(table),0,table);
});

test('cancelled user generation stays cancelled across ticks/restart until an explicit retry',async()=>{
 session(64);await scanSessions();const sync=store.startConversationSync(randomUUID());
 fs.writeFileSync(control,JSON.stringify({delay:3000}));const controller=new AbortController();
 const job=generateReply(sync.id,undefined,undefined,{signal:controller.signal});
 const rejected=assert.rejects(job);await until(()=>activity.busy&&calls().length>0);
 assert.equal(store.homeOverview().busy,true,'all provider job ownership is visible as busy');
 controller.abort();await rejected;assert.equal(store.getSync(sync.id).tree.run.status,'cancelled');
 const before=history(),paid=calls().length;closeDb();await scheduler().tick();await scheduler().tick();
 assert.deepEqual(history(),before);assert.equal(calls().length,paid);
 fs.writeFileSync(control,'{}');await generateReply(sync.id);assert.ok(store.getSync(sync.id).briefing);
 assert.equal(count('syncs'),1);assert.equal(count('sync_coverage'),0);assert.ok(calls().length>paid);
});

test('failed user generation is not retried by indexing; explicit retry reuses the same snapshot',async()=>{
 session(64);await scanSessions();process.env.DRAKEN_PI_MAX_INVOCATIONS='1';const sync=store.startConversationSync(randomUUID());
 await assert.rejects(generateReply(sync.id),/invocations/);assert.equal(store.getSync(sync.id).tree.run.status,'failed');
 assert.deepEqual(calls(),[],'budget preflight rejects before any provider call');
 const before=history();closeDb();await scheduler().tick();await scheduler().tick();assert.deepEqual(history(),before);assert.deepEqual(calls(),[]);
 store.configureModels(sync.id,{...store.getSync(sync.id).models,max_invocations:10});await generateReply(sync.id);
 assert.ok(store.getSync(sync.id).briefing);assert.equal(count('syncs'),1);assert.equal(count('sync_coverage'),0);assert.ok(calls().length>=2);
});

test('a completed user briefing survives local-readiness failure; explicit retry reuses it without paying again',async()=>{
 session(64);await scanSessions();const sync=store.startConversationSync(randomUUID());
 service.prepareHistory=async()=>{throw Error('Synthetic local storage failure');};
 await generateReply(sync.id);
 assert.match(require('../dist/sync/preparation').callReadiness(sync.id).error,/History could not be prepared/);
 assert.ok(store.getSync(sync.id).briefing);const paid=calls().length,before=history();assert.ok(paid>=2);
 closeDb();await scheduler().tick();assert.deepEqual(history(),before);assert.equal(calls().length,paid);
 service.prepareHistory=originalPrepare;await generateReply(sync.id);
 assert.equal(require('../dist/sync/preparation').callReadiness(sync.id).error,'');
 assert.equal(calls().length,paid);assert.equal(count('syncs'),1);assert.equal(count('sync_coverage'),0);
});

test('indexing and restart preserve legacy notes, references, conversations, cached summaries and reviewed coverage',async()=>{
 session(3);await scanSessions();const prior=store.startConversationSync(randomUUID());await generateReply(prior.id);
 await generateReply(prior.id,'What remains unverified?');
 store.completeSync(prior.id,'Explicit owner decision','Carry this forward',true);
 getDb().prepare('UPDATE sync_presentations SET request_id=? WHERE sync_id=?').run('auto:'+randomUUID(),prior.id);
 assert.ok(count('summary_cache')>0);assert.equal(count('sync_messages'),2);assert.equal(count('sync_coverage'),3);
 session(2);await scanSessions();const open=store.startConversationSync(randomUUID());store.saveNotes(open.id,'Keep these open notes','Owner follow-up');
 const before=history();session(70);const worker=scheduler();await worker.tick();await worker.tick();
 assert.deepEqual(history(),before);assert.equal(store.availableCount(),70);
 const paid=calls().length;closeDb();await scheduler().tick();assert.deepEqual(history(),before);assert.equal(calls().length,paid);
 assert.equal(count('live_calls'),0);assert.equal(count('voice_calls'),0);
});

test('excluding a legacy source does not claim or resume it, or block a fresh explicit snapshot',async()=>{
 const source=session(64);await scanSessions();const prior=store.startConversationSync(randomUUID());
 getDb().prepare('UPDATE sync_presentations SET request_id=? WHERE sync_id=?').run('auto:'+randomUUID(),prior.id);
 store.setIncluded(source,false);const before=history();session(2);await scheduler().tick();
 assert.deepEqual(history(),before);assert.deepEqual(calls(),[]);
 const next=store.startConversationSync(randomUUID());assert.notEqual(next.id,prior.id);assert.equal(next.items.length,2);
 assert.ok(next.items.every(item=>item.session_id!==source));assert.deepEqual(calls(),[]);assert.equal(count('sync_coverage'),0);
});
