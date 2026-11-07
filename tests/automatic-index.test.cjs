const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {getDb,closeDb}=require('../dist/db/schema');
const {createAutoIndexer,autoIndexSettings,setAutoIndex,startBackgroundIndexing,stopBackgroundIndexing}=require('../dist/memory/automatic');
const {HttpError}=require('../dist/sync/store');
let root,server;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-auto-test-'));fs.mkdirSync(root+'/sessions');Object.assign(process.env,{DRAKEN_DATA_DIR:root+'/state',DRAKEN_PI_SESSIONS_DIR:root+'/sessions',DRAKEN_NO_AUTH:'true',DRAKEN_HOST:'127.0.0.1',DRAKEN_PI_BIN:'/not-a-provider'});});
afterEach(async()=>{await stopBackgroundIndexing();if(server)await new Promise(r=>server.close(r));server=null;closeDb();fs.rmSync(root,{recursive:true,force:true});});
function fixture(size=1){let now=0,on=true,idle=true,scans=0,prepares=0;const rows=new Map(Array.from({length:size},(_,n)=>[String(n),'v1']));
 const ops={enabled:()=>on,idle:()=>idle,now:()=>now,scan:async()=>{scans++;return{warnings:[]};},stamp:()=>new Map(rows),prepare:async()=>{prepares++;}};
 return{worker:createAutoIndexer(ops),ops,rows,get scans(){return scans;},get prepares(){return prepares;},set now(v){now=v;},set on(v){on=v;},set idle(v){idle=v;}};
}
test('off and foreground work perform no scans or embedding; full batches run once and unchanged checks do not infer',async()=>{
 const f=fixture(64);f.on=false;await f.worker.tick();assert.equal(f.scans,0);f.on=true;f.idle=false;await f.worker.tick();assert.equal(f.scans,0);
 f.idle=true;await f.worker.tick();assert.equal(f.prepares,1);assert.equal(f.worker.state.pending_records,0);await f.worker.tick();assert.equal(f.prepares,1);
 f.rows.set('0','edited');await f.worker.tick();assert.equal(f.worker.state.pending_records,1);assert.equal(f.prepares,1);
 f.now=86400000;await f.worker.tick();assert.equal(f.prepares,1,'a single edit does not flush with time');
 for(let n=1;n<64;n++)f.rows.set(String(n),'edited');await f.worker.tick();assert.equal(f.prepares,2);
 f.rows.delete('0');await f.worker.tick();assert.equal(f.worker.state.pending_records,1);f.now=172800000;await f.worker.tick();assert.equal(f.prepares,2);
 f.rows.clear();await f.worker.tick();assert.equal(f.prepares,3,'a full batch of removals also refreshes admission');
});
test('0, 1 and 63 pending records never flush on a timer; the 64th triggers a background batch',async()=>{
 for(const size of [0,1,63]){
  const f=fixture(size);
  for(const now of [0,300000,86400000,30*86400000]){f.now=now;await f.worker.tick();assert.equal(f.prepares,0);assert.equal(f.worker.state.pending_records,size);}
 }
 const f=fixture(63);await f.worker.tick();f.now=86400000;f.rows.set('63','v1');await f.worker.tick();assert.equal(f.prepares,1);assert.equal(f.worker.state.pending_records,0);
 f.rows.set('64','new tail');f.now=30*86400000;await f.worker.tick();assert.equal(f.prepares,1);assert.equal(f.worker.state.pending_records,1);
});
test('only one job runs and disabling during a scan prevents embeddings; shutdown waits for owned work',async()=>{
 const f=fixture(70);let release;f.ops.scan=()=>new Promise(r=>release=r);const running=f.worker.tick();let stopped=false;
 const duplicate=f.worker.tick();f.on=false;const stopping=f.worker.stop().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false);
 release({warnings:[]});await Promise.all([running,duplicate,stopping]);assert.equal(stopped,true);assert.equal(f.prepares,0);assert.equal(f.worker.state.phase,'off');
});
test('cancellation preserves the last successful baseline; retry is bounded and failure messages contain no source data',async()=>{
 const f=fixture(64);let captured;f.ops.prepare=(_before,signal)=>new Promise((resolve,reject)=>{captured=signal;signal.addEventListener('abort',()=>reject(Error('PRIVATE_SOURCE')));});
 const running=f.worker.tick();while(!captured)await Promise.resolve();f.worker.pause();await running;assert.equal(captured.aborted,true);assert.equal(f.worker.state.phase,'paused');assert.equal(f.worker.state.error,'');
 let calls=0;f.ops.prepare=async()=>{calls++;throw Error('PRIVATE_SOURCE');};f.now=60000;await f.worker.tick();assert.equal(calls,1);assert.equal(f.worker.state.phase,'error');assert.doesNotMatch(f.worker.state.error,/PRIVATE_SOURCE/);
 f.now=120000;f.worker.pause();f.now=180000;await f.worker.tick();assert.equal(calls,1,'foreground activity cannot shorten failure backoff');f.now=360000;f.ops.prepare=async()=>{calls++;};await f.worker.tick();assert.equal(calls,2);assert.equal(f.worker.state.pending_records,0);
 for(let n=0;n<64;n++)f.rows.set(String(n),'v2');f.now=960000;f.ops.prepare=async()=>{throw new HttpError(409,'cancelled by foreground');};await f.worker.tick();assert.equal(f.worker.state.phase,'paused');assert.equal(f.worker.state.error,'');
});
test('settings are persistent, validated, read-only on GET, and protected from cross-origin changes',async()=>{
 const {createApp}=require('../dist/server');server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/api/settings/auto-index`;
 const first=await(await fetch(url)).json();assert.equal(first.enabled,false);assert.equal(first.batch_records,64);assert.equal(Object.hasOwn(first,'max_wait_seconds'),false);assert.equal(getDb().prepare("SELECT COUNT(*) n FROM sync_settings WHERE key='auto_index'").get().n,0);
 for(const body of [{enabled:'true'},{enabled:true,summary:true},[],{}])assert.equal((await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,400);
 assert.equal((await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json',Origin:'https://elsewhere.invalid'},body:'{"enabled":true}'})).status,403);
 assert.equal((await(await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{"enabled":true}'})).json()).enabled,true);
 await stopBackgroundIndexing();closeDb();assert.equal(autoIndexSettings().enabled,true);startBackgroundIndexing();assert.equal(autoIndexSettings().phase,'waiting');setAutoIndex(false);assert.equal(autoIndexSettings().enabled,false);
 for(const table of ['agent_sessions','syncs','sync_items','sync_coverage','sync_runs','live_calls'])assert.equal(getDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
});
test('opted-in timer scans and indexes actual synthetic pointers without creating syncs or provider calls',async t=>{
 const Database=require('better-sqlite3'),{HistoryIndex}=require('../dist/memory/index'),service=require('../dist/memory/service');
 fs.mkdirSync(root+'/state/memory',{recursive:true});
 const original=service.prepareHistory,cache=new Database(root+'/state/memory/index.sqlite');let jobs=0,foregroundJobs=0,embeddings=0;
 const now=Date.now(),id='synthetic-auto-session',header={type:'session',version:3,id,cwd:'/synthetic/auto',timestamp:new Date(now-1000).toISOString()};
 const contents=[header,...Array.from({length:70},(_,n)=>({type:'message',id:String(n),parentId:n?String(n-1):null,timestamp:header.timestamp,message:{role:'assistant',content:'Synthetic record '+n+'; deployment not checked.'}}))].map(JSON.stringify).join('\n')+'\n';
 fs.writeFileSync(root+'/sessions/auto.jsonl',contents);const index=new HistoryIndex(cache,getDb(),{fingerprint:'auto-synthetic-only',ready:()=>true,setup:async()=>{},embed:async()=>{embeddings++;const v=new Float32Array(384);v[0]=1;return v;}});
 await index.prepare(); // Fixture-created empty cache has a known empty checkpoint.
 service.prepareHistory=async(before,signal,background=false)=>{assert.equal(signal.aborted,false);if(background)jobs++;else foregroundJobs++;await index.prepare({before},undefined,true);};
 t.mock.timers.enable({apis:['setInterval','Date'],now});
 try{
  startBackgroundIndexing();t.mock.timers.tick(60000);await new Promise(r=>setTimeout(r,20));assert.equal(jobs,0);assert.equal(getDb().prepare('SELECT COUNT(*) n FROM agent_sessions').get().n,0);
  setAutoIndex(true);t.mock.timers.tick(60000);for(let n=0;n<200&&!autoIndexSettings().last_completed_at;n++)await new Promise(r=>setTimeout(r,10));
  assert.ok(autoIndexSettings().last_completed_at);assert.equal(jobs,1);assert.equal(embeddings,70);assert.equal(getDb().prepare('SELECT COUNT(*) n FROM agent_entries').get().n,70);
  t.mock.timers.tick(60000);for(let n=0;n<200&&autoIndexSettings().phase==='scanning';n++)await new Promise(r=>setTimeout(r,10));assert.equal(jobs,1);assert.equal(embeddings,70);
  const tail=JSON.stringify({type:'message',id:'70',parentId:'69',timestamp:header.timestamp,message:{role:'assistant',content:'Small pending tail; deployment not checked.'}})+'\n';fs.appendFileSync(root+'/sessions/auto.jsonl',tail);
  t.mock.timers.tick(3600000);for(let n=0;n<200&&autoIndexSettings().phase==='scanning';n++)await new Promise(r=>setTimeout(r,10));
  assert.ok(autoIndexSettings().pending_records>0&&autoIndexSettings().pending_records<64);assert.equal(jobs,1);assert.equal(embeddings,70,'no automatic small-batch flush after an hour');
  await service.prepareHistory(new Date().toISOString(),new AbortController().signal);assert.equal(foregroundJobs,1);assert.equal(embeddings,71,'foreground call preparation still indexes the small tail');
  for(const table of ['syncs','sync_items','sync_coverage','sync_runs','live_calls','summary_cache'])assert.equal(getDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  assert.equal(fs.readFileSync(root+'/sessions/auto.jsonl','utf8'),contents+tail);
 }finally{await stopBackgroundIndexing();t.mock.timers.reset();service.prepareHistory=original;cache.close();}
});
