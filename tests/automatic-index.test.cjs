const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {getDb,closeDb}=require('../dist/db/schema');
const {createAutoIndexer,autoIndexSettings,setAutoIndex,startBackgroundIndexing,stopBackgroundIndexing}=require('../dist/sync/background');
const {HttpError}=require('../dist/errors');
let root,server;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-auto-test-'));fs.mkdirSync(root+'/sessions');Object.assign(process.env,{DRAKEN_DATA_DIR:root+'/state',DRAKEN_PI_SESSIONS_DIR:root+'/sessions',DRAKEN_NO_AUTH:'true',DRAKEN_HOST:'127.0.0.1',DRAKEN_PI_BIN:'/not-a-provider'});});
afterEach(async()=>{await stopBackgroundIndexing();if(server)await new Promise(r=>server.close(r));server=null;closeDb();fs.rmSync(root,{recursive:true,force:true});});
function fixture(size=1){let now=0,on=true,idle=true,scans=0,prepares=0,baseline=new Map();const rows=new Map(Array.from({length:size},(_,n)=>[String(n),'v1']));
 const ops={enabled:()=>on,idle:()=>idle,now:()=>now,scan:async()=>{scans++;return{warnings:[]};},stamp:()=>new Map(rows),baseline:()=>baseline,prepare:async()=>{prepares++;baseline=new Map(rows);},completed:()=>{}};
 return{worker:createAutoIndexer(ops),ops,rows,get scans(){return scans;},get prepares(){return prepares;},set now(v){now=v;},set on(v){on=v;},set idle(v){idle=v;}};
}
test('off and foreground work perform no scans or embedding; full batches run once and unchanged checks do not infer',async()=>{
 const f=fixture(64);f.on=false;await f.worker.tick();assert.equal(f.scans,0);f.on=true;f.idle=false;await f.worker.tick();assert.equal(f.scans,0);
 f.idle=true;await f.worker.tick();assert.equal(f.prepares,1);assert.equal(f.worker.state.pending_records,0);await f.worker.tick();assert.equal(f.prepares,1);assert.equal(f.scans,2,'each eligible tick scans even with an unchanged index');
 f.rows.set('0','edited');await f.worker.tick();assert.equal(f.worker.state.pending_records,0);assert.equal(f.prepares,2);
 f.rows.delete('0');await f.worker.tick();assert.equal(f.prepares,3);
 f.rows.clear();await f.worker.tick();assert.equal(f.prepares,4,'removals also refresh admission');
});
test('idle checks prepare even one pending record without a conversation; unchanged checks never repeat work',async()=>{
 for(const size of [0,1,63,64]){
  const f=fixture(size);
  for(const now of [0,60000,86400000]){f.now=now;await f.worker.tick();assert.equal(f.prepares,size ? 1 : 0);assert.equal(f.worker.state.pending_records,0);}
  f.rows.set('tail','new');await f.worker.tick();assert.equal(f.prepares,size ? 2 : 1);
 }
});
test('zero-delta receipt/link recovery is local and bounded without an active conversation',async()=>{
 const f=fixture(0);let stale=true,attempts=0;f.ops.needsPreparation=()=>stale;
 f.ops.prepare=async()=>{attempts++;throw Error('PRIVATE stale receipt recovery failure');};
 await f.worker.tick();assert.equal(attempts,1);
 f.now=60000;await f.worker.tick();assert.equal(attempts,1,'failed recovery retains five-minute local backoff');
 f.now=300000;f.ops.prepare=async()=>{attempts++;stale=false;};await f.worker.tick();assert.equal(attempts,2);assert.equal(f.worker.state.phase,'waiting');
 f.now=360000;await f.worker.tick();assert.equal(attempts,2,'successful recovery is not a timed rewrite');
});
test('discovery, local indexing and escaped model-preparation failures keep distinct labels',async()=>{
 for(const [operation,expected] of [['scan','History discovery'],['prepare','Local indexing'],['prepareSummaries','Model preparation']]){
  const f=fixture(1),errors=[];f.ops.reportError=(operation,error)=>errors.push({operation,error});f.ops[operation]=async()=>{throw Error('PRIVATE_SOURCE /private/session.jsonl');};
  await f.worker.tick();assert.equal(errors[0].operation,expected);assert.match(errors[0].error.message,/PRIVATE_SOURCE/);assert.equal(f.worker.state.phase,'waiting');
  assert.equal(f.worker.state.error,'');
  f.worker.retry();assert.equal(f.worker.state.error_operation,undefined);
 }
});
for(const operation of ['scan','prepare'])test(`${operation} errors and local retry delays do not stop model preparation`,async()=>{
 const f=fixture(1),errors=[];let summaries=0;f.ops[operation]=async()=>{throw Error('local operation failed');};f.ops.reportError=(name,error)=>errors.push([name,error.message]);f.ops.prepareSummaries=async()=>{summaries++;};
 await f.worker.tick();assert.equal(summaries,1);assert.equal(errors.length,1);assert.equal(f.worker.state.phase,'waiting');
 f.now=60000;await f.worker.tick();assert.equal(summaries,2);assert.equal(errors.length,1,'local backoff does not repeat the failed local operation');
});
test('expiry runs even with indexing disabled, foreground admission blocked, or an owned job running',async()=>{
 const f=fixture(1),expired=[];f.ops.expire=now=>expired.push(now);f.on=false;
 await f.worker.tick();f.on=true;f.idle=false;f.now=60000;await f.worker.tick();assert.equal(f.scans,0);
 f.idle=true;f.now=120000;let release;f.ops.scan=()=>new Promise(r=>release=r);const running=f.worker.tick();
 f.now=180000;const duplicate=f.worker.tick();release({warnings:[]});await Promise.all([running,duplicate]);
 assert.deepEqual(expired,[0,60000,120000,180000]);assert.equal(f.prepares,1);
});
test('only one job runs and disabling during a scan prevents embeddings; shutdown waits for owned work',async()=>{
 const f=fixture(70);let release;f.ops.scan=()=>new Promise(r=>release=r);const running=f.worker.tick();let stopped=false;
 const duplicate=f.worker.tick();f.on=false;const stopping=f.worker.stop().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false);
 release({warnings:[]});await Promise.all([running,duplicate,stopping]);assert.equal(stopped,true);assert.equal(f.prepares,0);assert.equal(f.worker.state.phase,'off');
});
test('foreground work arriving during a scan wins before embedding or checkpoint completion',async()=>{
 const f=fixture(64);let release,completed=0;
 f.ops.scan=()=>new Promise(resolve=>release=resolve);f.ops.completed=()=>{completed++;};
 const running=f.worker.tick();f.idle=false;release({warnings:[]});await running;
 assert.equal(f.prepares,0);assert.equal(completed,0);assert.equal(f.worker.state.phase,'paused');
 f.idle=true;f.now=60000;f.ops.scan=async()=>({warnings:[]});await f.worker.tick();assert.equal(f.prepares,1);assert.equal(completed,1);
});
test('connected voice is background-idle only between turns; preemption aborts and awaits the owned local job',async()=>{
 const {activity}=require('../dist/sync/activity');const voice=activity.beginCall(991),f=fixture(1);
 f.ops.idle=()=>activity.backgroundIdle;f.ops.activeConversations=()=>true;
 const prepare=f.ops.prepare;let signal,release,finishTurn;
 try{
  await f.worker.tick();assert.equal(f.scans,0,'voice connection setup is foreground work');
  voice.connected();assert.equal(activity.backgroundIdle,true);
  f.ops.prepare=(_before,s)=>{signal=s;return new Promise(r=>release=r);};const running=f.worker.tick();while(!signal)await Promise.resolve();
  finishTurn=voice.beginTurn();assert.equal(activity.backgroundIdle,false);
  let drained=false;const yielding=f.worker.stop().then(()=>drained=true);await Promise.resolve();
  assert.equal(signal.aborted,true);assert.equal(drained,false,'cancellation request alone is not owned-job completion');
  release();await Promise.all([running,yielding]);assert.equal(drained,true);assert.equal(f.worker.state.last_completed_at,null);
  f.now=60000;await f.worker.tick();assert.equal(f.scans,1,'no mutation is admitted during the voice turn');
  finishTurn();finishTurn=undefined;f.ops.prepare=prepare;await f.worker.tick();assert.equal(f.prepares,1);
 }finally{finishTurn?.();release?.();await f.worker.stop();voice();}
});
test('an incomplete scan never advances the baseline or leaks private scan warnings',async()=>{
 const f=fixture(64);let completed=0;f.ops.completed=()=>{completed++;};
 f.ops.scan=async()=>({warnings:['PRIVATE_SOURCE /private/session.jsonl']});await f.worker.tick();
 assert.equal(f.prepares,0);assert.equal(completed,0);assert.equal(f.worker.state.phase,'waiting');assert.doesNotMatch(f.worker.state.error,/PRIVATE_SOURCE|private\/session/);
 f.now=300000;f.ops.scan=async()=>({warnings:[]});await f.worker.tick();assert.equal(f.prepares,1);assert.equal(completed,1);
});
test('cancellation preserves the last successful baseline; retry is bounded and failure messages contain no source data',async()=>{
 const f=fixture(64);let captured;f.ops.prepare=(_before,signal)=>new Promise((resolve,reject)=>{captured=signal;signal.addEventListener('abort',()=>reject(Error('PRIVATE_SOURCE')));});
 const running=f.worker.tick();while(!captured)await Promise.resolve();f.worker.pause();await running;assert.equal(captured.aborted,true);assert.equal(f.worker.state.phase,'paused');assert.equal(f.worker.state.error,'');
 let calls=0;f.ops.prepare=async()=>{calls++;throw Error('PRIVATE_SOURCE');};f.now=60000;await f.worker.tick();assert.equal(calls,1);assert.equal(f.worker.state.phase,'waiting');assert.doesNotMatch(f.worker.state.error,/PRIVATE_SOURCE/);
 f.now=120000;f.worker.pause();f.now=180000;await f.worker.tick();assert.equal(calls,1,'foreground activity cannot shorten failure backoff');f.now=360000;f.ops.prepare=async()=>{calls++;};await f.worker.tick();assert.equal(calls,2);assert.equal(f.worker.state.pending_records,0);
 for(let n=0;n<64;n++)f.rows.set(String(n),'v2');f.now=960000;f.ops.prepare=async()=>{throw new HttpError(409,'cancelled by foreground');};await f.worker.tick();assert.equal(f.worker.state.phase,'paused');assert.equal(f.worker.state.error,'');
});
test('summary backlog is independent of local embedding changes and paid failures do not erase local progress',async()=>{
 const f=fixture(1);let summaries=0;f.ops.prepareSummaries=async()=>{summaries++;throw Error('PRIVATE_PROVIDER_FAILURE');};
 await f.worker.tick();assert.equal(summaries,1);assert.equal(f.prepares,1);assert.equal(f.worker.state.phase,'waiting');assert.doesNotMatch(f.worker.state.error,/PRIVATE/);
 f.now=300000;for(let n=1;n<64;n++)f.rows.set(String(n),'v1');await f.worker.tick();assert.equal(f.prepares,2);assert.equal(summaries,2);assert.equal(f.worker.state.pending_records,0);assert.ok(f.worker.state.last_completed_at);
 f.idle=false;await f.worker.tick();assert.equal(summaries,2);f.idle=true;
 f.now=600000;f.ops.prepare=async()=>{f.idle=false;};for(let n=0;n<64;n++)f.rows.set(String(n),'v2');await f.worker.tick();assert.equal(summaries,2,'idle admission rechecked after indexing');
});
test('a single owner drains summary work and cancellation cannot be undone by rapid enable',async()=>{
 const f=fixture(0);let signal,release,done=false,calls=0;
 f.ops.prepareSummaries=s=>{signal=s;calls++;return new Promise(r=>release=r);};
 const running=f.worker.tick();while(!signal)await Promise.resolve();
 const stopping=f.worker.stop().then(()=>done=true);f.worker.retry();const duplicate=f.worker.tick();
 assert.equal(signal.aborted,true);await Promise.resolve();assert.equal(done,false);assert.equal(calls,1);
 release();await Promise.all([running,duplicate,stopping]);assert.equal(done,true);
});
test('settings are persistent, validated, read-only on GET, and protected from cross-origin changes',async()=>{
 const {createApp}=require('../dist/server');server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/api/settings/auto-index`;
 const before=getDb().prepare('SELECT total_changes() n').get().n;
 const first=await(await fetch(url)).json();assert.equal(first.enabled,true);assert.equal(first.batch_records,1);assert.equal(Object.hasOwn(first,'max_wait_seconds'),false);assert.equal(getDb().prepare('SELECT total_changes() n').get().n,before);
 for(const key of ['sync_id','ready_sync_id','progress'])assert.equal(Object.hasOwn(first,key),false,`no automatic briefing ${key}`);
 assert.equal((await(await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{"enabled":false}'})).json()).enabled,false);
 for(const body of [{enabled:'true'},{enabled:true,summary:true},{enabled:true,preparation_scope:'index-and-briefing-v1'},{enabled:false,preparation_scope:'index-and-briefing-v1'},[],{}])assert.equal((await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,400);
 assert.equal((await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json',Origin:'https://elsewhere.invalid'},body:'{"enabled":true}'})).status,403);
 assert.equal(autoIndexSettings().enabled,false,'invalid or cross-origin requests cannot change the setting');
 const enabled=await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{"enabled":true}'});assert.equal(enabled.status,200);assert.equal((await enabled.json()).enabled,true);
 assert.equal(getDb().prepare("SELECT value FROM sync_settings WHERE key='auto_index'").get().value,'true');
 const summaryUrl=url.replace('auto-index','auto-summary');
 assert.equal((await(await fetch(summaryUrl)).json()).enabled,true);
 for(const body of [{enabled:'true'},{enabled:true,extra:true},[],{}])assert.equal((await fetch(summaryUrl,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,400);
 assert.equal((await fetch(summaryUrl,{method:'PATCH',headers:{'Content-Type':'application/json',Origin:'https://elsewhere.invalid'},body:'{"enabled":true}'})).status,403);
 setAutoIndex(false);assert.equal((await fetch(summaryUrl,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{"enabled":true}'})).status,409);setAutoIndex(true);
 assert.equal((await(await fetch(summaryUrl,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{"enabled":true}'})).json()).enabled,true);
 assert.equal(autoIndexSettings().summary_enabled,true);
 assert.equal((await(await fetch(summaryUrl,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{"enabled":false}'})).json()).enabled,false);
 for(const key of ['auto_prepare_conversations','auto_preparing_sync','auto_briefing_failed'])assert.equal(getDb().prepare('SELECT value FROM sync_settings WHERE key=?').get(key),undefined);
 const after=getDb().prepare('SELECT total_changes() n').get().n;await fetch(url);assert.equal(getDb().prepare('SELECT total_changes() n').get().n,after);
 await stopBackgroundIndexing();closeDb();assert.equal(autoIndexSettings().enabled,true);startBackgroundIndexing();assert.equal(autoIndexSettings().phase,'waiting');setAutoIndex(false);assert.equal(autoIndexSettings().enabled,false);
 await stopBackgroundIndexing();closeDb();assert.equal(autoIndexSettings().enabled,false,'Explicit opt-out survives initialization on restart');
 for(const table of ['agent_sessions','syncs','sync_items','sync_coverage','sync_runs','live_calls'])assert.equal(getDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
});
test('with summaries explicitly off, the timer indexes originals and small tails without snapshots or provider calls',async t=>{
 getDb().prepare("INSERT INTO sync_settings VALUES('auto_summary','false')").run();
 const fake=path.join(root,'pi');fs.copyFileSync(path.join(__dirname,'fixtures/fake-pi.cjs'),fake);fs.chmodSync(fake,0o700);
 Object.assign(process.env,{DRAKEN_PI_BIN:fake,DRAKEN_PI_SUMMARY_MODEL:'test/cheap',DRAKEN_PI_FINAL_MODEL:'test/strong',DRAKEN_TEST_CALL_LOG:root+'/calls.jsonl',DRAKEN_FAKE_CONTROL:root+'/control.json'});fs.writeFileSync(root+'/control.json','{}');
 const Database=require('better-sqlite3'),{HistoryIndex}=require('../dist/memory/index'),service=require('../dist/memory/service');
 fs.mkdirSync(root+'/state/memory',{recursive:true});
 const original=service.prepareHistory,originalReadiness=service.historyReadiness,cache=new Database(root+'/state/memory/index.sqlite');let jobs=0,foregroundJobs=0,embeddings=0;
 const now=Date.now(),id='synthetic-auto-session',header={type:'session',version:3,id,cwd:'/synthetic/auto',timestamp:new Date(now-1000).toISOString()};
 const contents=[header,...Array.from({length:70},(_,n)=>({type:'message',id:String(n),parentId:n?String(n-1):null,timestamp:header.timestamp,message:{role:'assistant',content:'Synthetic record '+n+'; deployment not checked.'}}))].map(JSON.stringify).join('\n')+'\n';
 fs.writeFileSync(root+'/sessions/auto.jsonl',contents);const index=new HistoryIndex(cache,getDb(),{fingerprint:'auto-synthetic-only',ready:()=>true,setup:async()=>{},embed:async()=>{embeddings++;const v=new Float32Array(384);v[0]=1;return v;}});
 await index.prepare();
 service.historyReadiness=()=>require('../dist/memory/readiness').indexReadiness(cache,getDb());
 service.prepareHistory=async(before,signal,background=false)=>{assert.equal(signal.aborted,false);if(background)jobs++;else foregroundJobs++;await index.prepare({before},undefined,true);};
 t.mock.timers.enable({apis:['setInterval','Date'],now});
 try{
  assert.equal(autoIndexSettings().enabled,true);startBackgroundIndexing();assert.equal(jobs,0);assert.equal(getDb().prepare('SELECT COUNT(*) n FROM agent_sessions').get().n,0);
  t.mock.timers.tick(60000);for(let n=0;n<200&&!autoIndexSettings().last_completed_at;n++)await new Promise(r=>setTimeout(r,10));
  assert.ok(autoIndexSettings().last_completed_at);assert.equal(jobs,1);assert.equal(embeddings,70);assert.equal(getDb().prepare('SELECT COUNT(*) n FROM agent_entries').get().n,70);
  const noSyncs=()=>{for(const table of ['syncs','sync_items','sync_runs','sync_coverage','live_calls','sync_messages','summary_cache'])assert.equal(getDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);assert.equal(fs.existsSync(root+'/calls.jsonl'),false);};
  noSyncs();assert.equal(require('../dist/sync/store').availableCount(),70);
  const ready=()=>require('../dist/memory/readiness').indexReadiness(cache,getDb());
  assert.equal(ready().ready,true,'background work establishes the same call-readiness receipt');
  t.mock.timers.tick(60000);for(let n=0;n<200&&autoIndexSettings().phase==='scanning';n++)await new Promise(r=>setTimeout(r,10));assert.equal(jobs,1);assert.equal(embeddings,70);noSyncs();
  const tail=JSON.stringify({type:'message',id:'70',parentId:'69',timestamp:header.timestamp,message:{role:'assistant',content:'Small pending tail; deployment not checked.'}})+'\n';fs.appendFileSync(root+'/sessions/auto.jsonl',tail);
  t.mock.timers.tick(3600000);for(let n=0;n<200&&autoIndexSettings().phase==='scanning';n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(autoIndexSettings().pending_records,0);assert.equal(jobs,2);assert.equal(embeddings,71,'small tails are indexed without starting a sync');noSyncs();
  assert.equal(require('../dist/sync/store').availableCount(),71,'every scan accumulates entries without reserving them');
  assert.equal(foregroundJobs,0,'no foreground preparation is needed for the tail');
  assert.equal(ready().ready,true);
  noSyncs();assert.equal(require('../dist/sync/store').availableCount(),71);
  assert.equal(fs.readFileSync(root+'/sessions/auto.jsonl','utf8'),contents+tail);
 }finally{await stopBackgroundIndexing();t.mock.timers.reset();service.prepareHistory=original;service.historyReadiness=originalReadiness;cache.close();}
});
test('the production minute timer expires conversations while local indexing is off, without browser or source work',async t=>{
 const now=Date.now(),db=getDb(),created=new Date(now-31*60000).toISOString();
 const id=Number(db.prepare("INSERT INTO syncs(created_at,snapshot_at,status) VALUES(?,?,'open')").run(created,created).lastInsertRowid);
 t.mock.timers.enable({apis:['setInterval','Date'],now});
 try{
  setAutoIndex(false);assert.equal(db.prepare('SELECT conversation_ended_at FROM syncs WHERE id=?').get(id).conversation_ended_at,null);
  t.mock.timers.tick(60000);await Promise.resolve();
  assert.equal(db.prepare('SELECT conversation_ended_at FROM syncs WHERE id=?').get(id).conversation_ended_at,new Date(now+60000).toISOString(),'the timer persists actual expiry time');
  assert.equal(db.prepare('SELECT status FROM syncs WHERE id=?').get(id).status,'open','expiry is not review/completion');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_coverage').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_sessions').get().n,0);
  assert.equal(fs.existsSync(root+'/state/memory'),false);
 }finally{await stopBackgroundIndexing();t.mock.timers.reset();}
});
test('an active production conversation gets a two-record local tail on the next minute, without rewriting its cutoff or snapshot',async t=>{
 getDb().prepare("INSERT INTO sync_settings VALUES('auto_summary','false')").run();
 const Database=require('better-sqlite3'),{HistoryIndex}=require('../dist/memory/index'),service=require('../dist/memory/service');
 const {scanSessions}=require('../dist/sync/collector'),{indexReadiness}=require('../dist/memory/readiness');
 const {markConversationPrepared,captureConversationHistory}=require('../dist/sync/conversation');
 const now=Date.now(),before=new Date(now-1000).toISOString(),at=new Date(now-5000).toISOString(),db=getDb();
 const file=root+'/sessions/live.jsonl',message=(id,parentId,timestamp,text)=>({type:'message',id,parentId,timestamp,message:{role:'assistant',content:text}});
 fs.writeFileSync(file,[{type:'session',version:3,id:'live',cwd:'/synthetic/live',timestamp:at},message('old',null,at,'Original report; acceptance not checked.')].map(JSON.stringify).join('\n')+'\n');
 assert.deepEqual((await scanSessions()).warnings,[]);fs.mkdirSync(root+'/state/memory',{recursive:true});const cache=new Database(root+'/state/memory/index.sqlite');
 let jobs=0,embeddings=0;const index=new HistoryIndex(cache,db,{fingerprint:'synthetic-live-timer',ready:()=>true,setup:async()=>{},embed:async()=>{embeddings++;const v=new Float32Array(384);v[0]=1;return v;}});
 await index.prepare({before},undefined,true);
 const id=Number(db.prepare("INSERT INTO syncs(created_at,snapshot_at,status,briefing) VALUES(?,?,'open','Immutable initial briefing')").run(new Date(now).toISOString(),before).lastInsertRowid);
 markConversationPrepared(id,before);
 const originalPrepare=service.prepareHistory,originalReadiness=service.historyReadiness;
 service.prepareHistory=async(cutoff,signal,background)=>{assert.equal(signal.aborted,false);assert.equal(background,true);jobs++;await index.prepare({before:cutoff},undefined,true);};
 service.historyReadiness=captured=>indexReadiness(cache,db,captured);
 t.mock.method(service,'historyPreparationStatus',()=>indexReadiness(cache,null));
 const saved=JSON.stringify(db.prepare('SELECT * FROM syncs WHERE id=?').get(id));
 t.mock.timers.enable({apis:['setInterval','Date'],now});
 try{
  const later=new Date(now+1000).toISOString();fs.appendFileSync(file,[message('new','old',later,'New implementation report.'),message('qualification','new',later,'Acceptance tests remain pending.')].map(JSON.stringify).join('\n')+'\n');
  startBackgroundIndexing();t.mock.timers.tick(60000);
  for(let n=0;n<200&&!autoIndexSettings().last_completed_at;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(jobs,1);assert.equal(embeddings,3);assert.equal(autoIndexSettings().pending_records,0);assert.equal(indexReadiness(cache,db).ready,true);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM syncs WHERE id=?').get(id)),saved,'background completion does not adopt a conversation cutoff or rewrite its briefing');
  const captured=captureConversationHistory(id);assert.ok(captured>before,'only the next turn adopts the completed cutoff');
  assert.ok((await index.search({question:'implementation',before:captured},undefined,true)).results.some(row=>row.at===later));
  const afterQuery=embeddings;t.mock.timers.tick(60000);for(let n=0;n<200&&autoIndexSettings().phase==='scanning';n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(jobs,1);assert.equal(embeddings,afterQuery,'unchanged live tick has no inference');
  for(const table of ['sync_items','sync_messages','sync_runs','sync_coverage','summary_cache','background_runs','live_calls'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM syncs').get().n,1);
 }finally{await stopBackgroundIndexing();t.mock.timers.reset();service.prepareHistory=originalPrepare;service.historyReadiness=originalReadiness;cache.close();}
});
