require('./fixtures/fake-memory.cjs');
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {getDb,closeDb}=require('../dist/db/schema'),store=require('../dist/sync/store'),service=require('../dist/memory/service');
const {activity}=require('../dist/sync/activity');
const {scanSessions}=require('../dist/sync/collector'),{generateReply,cancelReply}=require('../dist/sync/manager');
const {prepareAutomaticBriefing,pendingAutomaticBriefing,automaticBriefingError,retryAutomaticBriefing}=require('../dist/sync/automatic');
const {createAutoIndexer,setAutoIndex,autoIndexSettings,stopBackgroundIndexing}=require('../dist/sync/background');
let root,log,control,server,originalPrepare;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-auto-briefing-'));fs.mkdirSync(root+'/sessions');const fake=root+'/pi';fs.copyFileSync(path.join(__dirname,'fixtures/fake-pi.cjs'),fake);fs.chmodSync(fake,0o700);log=root+'/calls.jsonl';control=root+'/control.json';fs.writeFileSync(control,'{}');Object.assign(process.env,{DRAKEN_DATA_DIR:root+'/state',DRAKEN_PI_SESSIONS_DIR:root+'/sessions',DRAKEN_PI_BIN:fake,DRAKEN_PI_SUMMARY_MODEL:'test/cheap',DRAKEN_PI_FINAL_MODEL:'test/strong',DRAKEN_TEST_CALL_LOG:log,DRAKEN_FAKE_CONTROL:control,DRAKEN_HOST:'127.0.0.1',DRAKEN_NO_AUTH:'true'});delete process.env.DRAKEN_PI_MAX_INVOCATIONS;originalPrepare=service.prepareHistory;});
afterEach(async()=>{await stopBackgroundIndexing();for(const id of activity.busyIds)cancelReply(id);await until(()=>!activity.busy);if(server)await new Promise(r=>server.close(r));server=null;service.prepareHistory=originalPrepare;assert.equal(activity.busy,false);assert.equal(activity.backgroundId,undefined);closeDb();fs.rmSync(root,{recursive:true,force:true});});
function session(n){const id=randomUUID(),timestamp='2026-01-01T00:00:00Z';fs.writeFileSync(root+'/sessions/'+id+'.jsonl',[{type:'session',version:3,id,cwd:'/synthetic/beacon',timestamp},...Array.from({length:n},(_,i)=>({type:'message',id:String(i),parentId:i?String(i-1):null,timestamp,message:{role:i?'assistant':'user',content:'Beacon '+id+' synthetic implementation checkpoint '+i+'; deployment not verified.'}}))].map(JSON.stringify).join('\n')+'\n');}
const calls=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const count=t=>getDb().prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
async function until(check){for(let i=0;i<500;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out waiting for synthetic work');}
async function post(route,body){if(!server){server=require('../dist/server').createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));}const res=await fetch(`http://127.0.0.1:${server.address().port}/api${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await res.json();assert.equal(res.status,202,JSON.stringify(value));return value;}

test('an already indexed backlog still prepares a briefing; unchanged and smaller tails do not infer',async()=>{
 session(70);await scanSessions();let indexed=0,now=0;
 const worker=createAutoIndexer({enabled:()=>true,idle:()=>!activity.busy,now:()=>now,scan:scanSessions,stamp:()=>new Map(),baseline:()=>new Map(),prepare:async()=>{indexed++;},waiting:store.availableCount,unfinished:()=>pendingAutomaticBriefing()!==undefined,briefing:prepareAutomaticBriefing,problem:automaticBriefingError,completed:()=>{}});
 await worker.tick();assert.equal(indexed,0,'An up-to-date search index cannot hide an unprepared briefing backlog');assert.equal(store.availableCount(),0);assert.equal(count('sync_items'),70);assert.ok(store.getSync(store.automaticSyncId(true)).briefing);assert.equal(count('sync_coverage'),0);assert.equal(count('live_calls'),0);assert.equal(count('sync_messages'),0);const paid=calls().length;assert.ok(paid>=2);
 await worker.tick();assert.equal(calls().length,paid);session(1);await scanSessions();now=86400000;await worker.tick();assert.equal(calls().length,paid);assert.equal(store.availableCount(),1);
});

test('ready automatic snapshots survive restart and Home chat claims them idempotently without another model call',async()=>{
 session(64);await scanSessions();await prepareAutomaticBriefing(new AbortController().signal);const id=store.automaticSyncId(true),snapshot=getDb().prepare('SELECT * FROM syncs WHERE id=?').get(id),paid=calls().length;closeDb();assert.equal(store.automaticSyncId(true),id);
 const request_id=randomUUID();const first=await post('/syncs/start-chat',{request_id});assert.equal(first.sync.id,id);assert.equal((await post('/syncs/start-chat',{request_id})).sync.id,id);assert.equal(calls().length,paid);assert.equal(count('syncs'),1);assert.equal(store.automaticSyncId(true),undefined);assert.deepEqual(getDb().prepare('SELECT * FROM syncs WHERE id=?').get(id),snapshot);assert.equal(count('sync_coverage'),0);
});

test('a foreground tail is a new frozen snapshot, retains previous prepared context and does not reopen old batches',async()=>{
 session(64);await scanSessions();await prepareAutomaticBriefing(new AbortController().signal);const id=store.automaticSyncId(true),before=getDb().prepare('SELECT * FROM syncs WHERE id=?').get(id);session(2);await scanSessions();const next=store.startConversationSync(randomUUID());assert.notEqual(next.id,id);assert.equal(next.items.length,2);assert.equal(next.memory[0].sync_id,id);assert.deepEqual(getDb().prepare('SELECT * FROM syncs WHERE id=?').get(id),before);assert.equal(store.automaticSyncId(true),undefined);assert.equal(count('sync_coverage'),0);
});

test('provider cancellation retains a durable partial batch and restart resumes it, not a duplicate snapshot',async()=>{
 session(64);await scanSessions();fs.writeFileSync(control,JSON.stringify({delay:3000}));const controller=new AbortController(),job=prepareAutomaticBriefing(controller.signal);await until(()=>activity.busy&&calls().length>0);const id=pendingAutomaticBriefing();assert.equal(store.homeOverview().busy,false,'Home can yield owned background work');controller.abort();await assert.rejects(job);assert.equal(automaticBriefingError(),'');assert.equal(pendingAutomaticBriefing(),id);assert.equal(store.getSync(id).tree.run.status,'cancelled');closeDb();fs.writeFileSync(control,'{}');await prepareAutomaticBriefing(new AbortController().signal);assert.equal(count('syncs'),1);assert.equal(store.automaticSyncId(true),id);assert.equal(pendingAutomaticBriefing(),undefined);assert.equal(count('sync_coverage'),0);
});

test('model failures pause paid retries durably; one explicit retry reuses the same snapshot',async()=>{
 session(64);await scanSessions();process.env.DRAKEN_PI_MAX_INVOCATIONS='1';setAutoIndex(true);await assert.rejects(prepareAutomaticBriefing(new AbortController().signal),/invocations/);const id=pendingAutomaticBriefing();assert.ok(automaticBriefingError());assert.equal(calls().length,0,'Budget preflight rejects before a paid call');await stopBackgroundIndexing();closeDb();assert.equal(autoIndexSettings().phase,'error');
 let attempts=0;const worker=createAutoIndexer({enabled:()=>true,idle:()=>true,now:Date.now,scan:scanSessions,stamp:()=>new Map(),baseline:()=>new Map(),prepare:async()=>{},waiting:store.availableCount,unfinished:()=>true,briefing:async()=>{attempts++;},problem:automaticBriefingError,completed:()=>{}});await worker.tick();await worker.tick();assert.equal(attempts,0);
 store.configureModels(id,{...store.getSync(id).models,max_invocations:10});retryAutomaticBriefing();await prepareAutomaticBriefing(new AbortController().signal);assert.equal(count('syncs'),1);assert.equal(store.automaticSyncId(true),id);assert.equal(automaticBriefingError(),'');assert.equal(count('sync_coverage'),0);
});

test('search-readiness failure after the briefing resumes without paying for that briefing twice',async()=>{
 session(64);await scanSessions();service.prepareHistory=async()=>{throw Error('Synthetic local storage failure');};await assert.rejects(prepareAutomaticBriefing(new AbortController().signal));const id=pendingAutomaticBriefing(),paid=calls().length;assert.ok(store.getSync(id).briefing);assert.ok(automaticBriefingError());closeDb();retryAutomaticBriefing();service.prepareHistory=originalPrepare;await prepareAutomaticBriefing(new AbortController().signal);assert.equal(calls().length,paid);assert.equal(pendingAutomaticBriefing(),undefined);assert.equal(count('syncs'),1);
});

test('existing notes, reviewed history and earlier frozen conversations are not rewritten',async()=>{
 session(3);await scanSessions();const prior=store.startConversationSync(randomUUID());await generateReply(prior.id);store.saveNotes(prior.id,'Explicit owner decision','Carry this forward');const before=getDb().prepare('SELECT * FROM syncs WHERE id=?').get(prior.id);session(64);await scanSessions();await prepareAutomaticBriefing(new AbortController().signal);assert.deepEqual(getDb().prepare('SELECT * FROM syncs WHERE id=?').get(prior.id),before);assert.equal(store.getSync(prior.id).items.length,3);assert.equal(count('sync_coverage'),0);assert.equal(count('live_calls'),0);assert.equal(count('voice_calls'),0);
});

test('changed selection blocks automatic resumption and prepared reuse before any additional provider call',async()=>{
 session(64);await scanSessions();await prepareAutomaticBriefing(new AbortController().signal);const id=store.automaticSyncId(true),paid=calls().length;store.setIncluded(store.getSync(id).items[0].session_id,false);assert.throws(()=>store.startConversationSync(randomUUID()),/selection changed/);assert.equal(calls().length,paid);assert.equal(count('sync_coverage'),0);
});

test('a Home start yields the running automatic provider and resumes its same snapshot in the foreground',async t=>{
 session(64);fs.writeFileSync(control,JSON.stringify({delay:3000}));t.mock.timers.enable({apis:['setInterval']});
 try{setAutoIndex(true);t.mock.timers.tick(60000);await until(()=>activity.busy&&calls().length>0);const id=pendingAutomaticBriefing();fs.writeFileSync(control,'{}');const result=await post('/syncs/start-chat',{request_id:randomUUID()});assert.equal(result.sync.id,id);await until(()=>!activity.busy);assert.ok(store.getSync(id).briefing);assert.equal(count('syncs'),1);assert.ok(getDb().prepare("SELECT 1 FROM sync_runs WHERE sync_id=? AND status='cancelled'").get(id));assert.equal(count('sync_coverage'),0);assert.equal(store.automaticSyncId(true),undefined);
 }finally{await stopBackgroundIndexing();t.mock.timers.reset();}
});

test('legacy local-only opt-in does not silently authorize paid preparation; the single new switch does',()=>{
 // Reconstruct pre-combined-consent settings, not a newly initialized 0.4.2 database.
 getDb().exec("DELETE FROM sync_settings WHERE key='auto_prepare_conversations'; UPDATE sync_settings SET value='true' WHERE key='auto_index'");assert.equal(autoIndexSettings().enabled,false);assert.equal(count('syncs'),0);assert.equal(calls().length,0);setAutoIndex(true);assert.equal(autoIndexSettings().enabled,true);setAutoIndex(false);assert.equal(autoIndexSettings().enabled,false);
});
