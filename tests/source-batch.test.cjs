const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Database=require('better-sqlite3');
const {getDb,closeDb}=require('../dist/db/schema');
const {scanSessions}=require('../dist/sync/collector');
const {startSync}=require('../dist/sync/store');
const {HistoryIndex}=require('../dist/memory/index');
const {sourceStamps,loadSourceCheckpoint}=require('../dist/memory/stamps');
const {createAutoIndexer}=require('../dist/sync/background');
let root,cache,index,model,jobs,embeddings,now;
const at='2020-01-02T00:00:00.000Z';
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-source-batch-'));fs.mkdirSync(root+'/sessions');
 Object.assign(process.env,{DRAKEN_DATA_DIR:root+'/state',DRAKEN_PI_SESSIONS_DIR:root+'/sessions'});
 jobs=embeddings=0;now=Date.now();getDb();
});
afterEach(()=>{cache?.close();cache=index=model=undefined;closeDb();fs.rmSync(root,{recursive:true,force:true});});
function session(id){
 const file=root+'/sessions/'+id+'.jsonl';let count=0;
 fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id,cwd:'/synthetic/'+id,timestamp:at})+'\n');
 return{file,append(n=1){for(let i=0;i<n;i++){
  fs.appendFileSync(file,JSON.stringify({type:'message',id:'m'+count,parentId:count?'m'+(count-1):null,timestamp:at,message:{role:'assistant',content:`Synthetic ${id} activity ${count}; deployment not checked.`}})+'\n');count++;
 }}};
}
function history(){
 if(!index){fs.mkdirSync(root+'/state/memory',{recursive:true});cache=new Database(root+'/state/memory/index.sqlite');
  model={fingerprint:'synthetic-batch-only',ready:()=>true,setup:async()=>{},embed:async()=>{embeddings++;const v=new Float32Array(384);v[0]=1;return v;}};
  index=new HistoryIndex(cache,getDb(),model);}
 return index;
}
function scheduler(){return createAutoIndexer({enabled:()=>true,idle:()=>true,now:()=>now,scan:scanSessions,
 stamp:before=>sourceStamps(getDb(),before),baseline:()=>loadSourceCheckpoint(root+'/state'),
 prepare:async(before,signal)=>{assert.equal(signal.aborted,false);jobs++;await history().prepare({before},undefined,true);},
 waiting:()=>0,unfinished:()=>false,briefing:async()=>{},problem:()=>'',completed:()=>{}});}

test('real collector: 63 source entries plus session metadata never reaches 64, even after 30 days',async()=>{
 const s=session('batch63');s.append(63);const worker=scheduler();
 await worker.tick();assert.equal(worker.state.pending_records,63);assert.equal(jobs,0);assert.equal(embeddings,0);
 assert.equal(fs.existsSync(root+'/state/memory'),false,'small tails create no search DB/model');
 now+=30*86400000;await worker.tick();assert.equal(jobs,0);assert.equal(worker.state.pending_records,63);
 s.append();await worker.tick();assert.equal(jobs,1);assert.equal(embeddings,64);
 const checkpoint=loadSourceCheckpoint(root+'/state');assert.equal(checkpoint.size,64);
 const restarted=scheduler();await restarted.tick();assert.equal(jobs,1,'restart does not admit an unchanged archive');
 s.append();await restarted.tick();assert.equal(restarted.state.pending_records,1);assert.equal(jobs,1);
 await history().prepare();assert.equal(embeddings,65,'foreground handles a one-record tail');
 await scheduler().tick();assert.equal(jobs,1);
});

test('real collector: 32 appends across 32 existing sessions count as 32, not 64',async()=>{
 const sessions=Array.from({length:32},(_,i)=>session('many-'+i));sessions.forEach(s=>s.append());
 await scanSessions();await history().prepare();assert.equal(embeddings,32);
 sessions.forEach(s=>s.append());const worker=scheduler();await worker.tick();assert.equal(worker.state.pending_records,32);assert.equal(jobs,0);
 await scheduler().tick();assert.equal(jobs,0,'restart preserves the smaller pending tail');
 sessions.slice(0,31).forEach(s=>s.append());await worker.tick();assert.equal(worker.state.pending_records,63);assert.equal(jobs,0);
 sessions[31].append();await worker.tick();assert.equal(jobs,1);assert.equal(embeddings,96);
 const before=loadSourceCheckpoint(root+'/state');
 await history().search({question:'synthetic',before:'2020-01-01T00:00:00.000Z'});
 assert.deepEqual(loadSourceCheckpoint(root+'/state'),before,'historical/scoped queries cannot replace the global checkpoint');
 await scheduler().tick();assert.equal(jobs,1);
});

test('frozen aliases coalesce with originals; edits/removals occupy one slot each, not metadata rows',async()=>{
 const s=session('frozen');s.append(63);await scanSessions();
 const before=sourceStamps(getDb(),new Date(now).toISOString());assert.equal(before.size,63);
 const frozen=startSync();assert.equal(frozen.items.length,63);
 assert.deepEqual(sourceStamps(getDb(),new Date(now).toISOString()),before,'freezing does not multiply source records');
 await history().prepare();
 getDb().prepare("UPDATE agent_sessions SET modified_at='2099-01-01',byte_offset=byte_offset+1 WHERE id='frozen'").run();
 assert.deepEqual(sourceStamps(getDb(),new Date(now).toISOString()),before,'file invalidation metadata is not an activity record');
 getDb().prepare("UPDATE agent_sessions SET included=0 WHERE id='frozen'").run();
 const removed=sourceStamps(getDb(),new Date(now).toISOString());assert.equal(removed.size,0);
 assert.equal([...before.keys()].filter(key=>!removed.has(key)).length,63,'one removal per original, not per frozen alias');
});

test('real source rewrites count each edited record once; failed preparation keeps the durable checkpoint',async()=>{
 const s=session('edits');s.append(64);await scanSessions();await history().prepare();
 const before=loadSourceCheckpoint(root+'/state');
 const lines=fs.readFileSync(s.file,'utf8').trim().split('\n').map(JSON.parse);
 for(let i=1;i<=63;i++)lines[i].message.content+=' Corrected; still unverified.';
 fs.writeFileSync(s.file,lines.map(JSON.stringify).join('\n')+'\n');
 const worker=scheduler();await worker.tick();assert.equal(worker.state.pending_records,63);assert.equal(jobs,0);
 lines[64].message.content+=' Corrected; still unverified.';fs.writeFileSync(s.file,lines.map(JSON.stringify).join('\n')+'\n');
 const embed=model.embed;model.embed=async()=>{throw Error('Synthetic model failure');};
 await worker.tick();assert.equal(worker.state.phase,'error');assert.deepEqual(loadSourceCheckpoint(root+'/state'),before);
 model.embed=embed;await scheduler().tick();assert.equal(jobs,2);assert.equal(embeddings,128);
});

test('an interrupted first preparation retains a known empty checkpoint and can retry after restart',async()=>{
 const s=session('first-failure');s.append(64);history();
 const embed=model.embed;model.embed=async()=>{throw Error('Synthetic setup failure');};
 const worker=scheduler();await worker.tick();assert.equal(worker.state.phase,'error');assert.equal(jobs,1);
 assert.equal(loadSourceCheckpoint(root+'/state').size,0);
 model.embed=embed;await scheduler().tick();assert.equal(jobs,2);assert.equal(embeddings,64);
 assert.equal(loadSourceCheckpoint(root+'/state').size,64);
});

test('combined preparation establishes a missing older checkpoint and unchanged checks do not repeat work',async()=>{
 const s=session('upgrade');s.append(64);await scanSessions();await history().prepare();
 assert.equal(embeddings,64);
 cache.prepare("DELETE FROM meta WHERE key='background-source-stamps-v1'").run(); // Prior-release cache.
 const worker=scheduler();await worker.tick();assert.equal(jobs,1);assert.equal(embeddings,64,'compatible vectors are reused while establishing the checkpoint');
 assert.equal(worker.state.error,'');
 assert.equal(loadSourceCheckpoint(root+'/state').size,64);
 const writes=cache.prepare('SELECT total_changes() n').get().n;await history().prepare();
 assert.equal(cache.prepare('SELECT total_changes() n').get().n,writes,'unchanged preparation retains zero derived writes');
 await scheduler().tick();assert.equal(jobs,1);
 const value=cache.prepare("SELECT value FROM meta WHERE key='background-source-stamps-v1'").get().value;
 assert.doesNotMatch(value,/Synthetic|deployment|upgrade|\/synthetic/,'checkpoint retains only hashes');
});
