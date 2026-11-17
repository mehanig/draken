const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const run=promisify(execFile);
const prelude=`
 const assert=require('node:assert/strict');
 const {activity}=require('./dist/sync/activity');
 const preview=require('./dist/sync/preparation-preview');
 const memory=require('./dist/memory/service');
 const {getDb,closeDb}=require('./dist/db/schema');
 const turn=()=>new Promise(r=>setImmediate(r));
 const worker=require('./tests/fixtures/preview-worker.cjs').install();
 const {SummaryTree}=require('./dist/sync/tree');
 SummaryTree.prototype.call=()=>{throw Error('Provider forbidden');};
`;
async function child(code){const root=fs.mkdtempSync(path.join(os.tmpdir(),'independent-owner-'));fs.mkdirSync(root+'/sessions');try{const result=await run(process.execPath,['-e',prelude+code],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DRAKEN_DATA_DIR:root+'/state',DRAKEN_PI_SESSIONS_DIR:root+'/sessions',DRAKEN_PI_BIN:'/no-real-provider',DRAKEN_PI_SUMMARY_MODEL:'synthetic/summary',DRAKEN_PI_FINAL_MODEL:'synthetic/final'},timeout:10000});if(result.stdout)console.log(result.stdout);}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('independent ownership: aborted native memory request must exit before preview plans; shutdown waits too',()=>child(`
 const cp=require('node:child_process'),{EventEmitter}=require('node:events');
 let native, dispatched=0;
 cp.fork=()=>{native=new EventEmitter();native.pid=123;native.exitCode=null;native.signalCode=null;native.send=(msg,cb)=>{dispatched++;cb?.();};native.kill=()=>true;return native;};
 (async()=>{
  const ctrl=new AbortController();
  const request=memory.readHistory('H'+'a'.repeat(24),0,ctrl.signal).catch(e=>e);
  assert.equal(dispatched,1);ctrl.abort();assert.equal((await request).status,409);
  assert.equal(memory.historyProgress().active,false);
  let snapshots=0;const store=require('./dist/sync/store'),original=store.previewSummaryInput;
  store.previewSummaryInput=()=>{snapshots++;return original();};
  assert.equal(preview.requestPreparationPreview().phase,'checking');
  for(let i=0;i<5;i++)await turn();assert.equal(snapshots,0);assert.equal(worker.workers.length,0);
  let stopped=false;const stop=activity.shutdown().then(()=>stopped=true);
  for(let i=0;i<5;i++)await turn();assert.equal(stopped,false);
  native.signalCode='SIGTERM';native.emit('exit',null,'SIGTERM');
  await stop;assert.equal(snapshots,0);assert.notEqual(preview.preparationPreview().phase,'ready');closeDb();
 })().catch(e=>{console.error(e);process.exitCode=1;});
`));
test('independent ownership: generic POST retains admission after response disconnect and shutdown until handler exits',()=>child(`
 const {route}=require('./dist/routes/http'),{EventEmitter}=require('node:events');
 (async()=>{
  let release,entered;const gate=new Promise(r=>release=r),entry=new Promise(r=>entered=r);
  const response=new EventEmitter();let errors=[];
  route(async()=>{entered();await gate;})({method:'POST',path:'/synthetic-mutation'},response,e=>errors.push(e));
  await entry;response.emit('close');
  assert.equal(preview.requestPreparationPreview().phase,'paused');assert.equal(activity.previewIdle,false);
  let stopped=false;const stop=activity.shutdown().then(()=>stopped=true);
  await turn();assert.equal(stopped,false);release();await stop;assert.deepEqual(errors,[]);closeDb();
 })().catch(e=>{console.error(e);process.exitCode=1;});
`));
test('recovery: cancelled preview waits for foreground ownership, then becomes stale',()=>child(`
 (async()=>{
  worker.restore();
  const held=require('./tests/fixtures/preview-worker.cjs').install({hold:'before'});
  assert.equal(preview.requestPreparationPreview().phase,'checking');await held.entered;
  const releaseMutation=activity.beginMutation();const drain=activity.drainPreview();
  assert.equal(preview.preparationPreview().phase,'paused');await drain;
  assert.equal(require('node:fs').existsSync(held.workers[0].previewDirectory),false);
  assert.equal(preview.preparationPreview().phase,'paused');releaseMutation();
  assert.equal(preview.preparationPreview().phase,'stale');
  held.restore();
  assert.equal(preview.requestPreparationPreview().phase,'checking');
  while(preview.preparationPreview().phase==='checking')await turn();
  assert.equal(preview.preparationPreview().phase,'ready');closeDb();
 })().catch(e=>{console.error(e);process.exitCode=1;});
`));
test('recovery: idle metadata permits POST but native retirement drains before originals',()=>child(`
 const cp=require('node:child_process'),{EventEmitter}=require('node:events');let native;
 cp.fork=()=>{native=new EventEmitter();native.pid=123;native.exitCode=null;native.signalCode=null;native.send=(msg,cb)=>cb?.();native.kill=()=>true;return native;};
 (async()=>{
  const ctrl=new AbortController();
  const request=memory.prepareHistory(new Date().toISOString(),ctrl.signal,true).catch(e=>e);
  assert.equal(preview.requestPreparationPreview().phase,'paused');
  ctrl.abort();await request;
  assert.equal(memory.historyProgress().active,false);assert.equal(activity.previewIdle,true);
  assert.equal(preview.preparationPreview().phase,'stale');
  const store=require('./dist/sync/store'),original=store.previewSummaryInput;let reads=0;
  store.previewSummaryInput=()=>{reads++;return original();};
  assert.equal(preview.requestPreparationPreview().phase,'checking');
  for(let i=0;i<5;i++)await turn();assert.equal(reads,0);assert.equal(worker.workers.length,0);
  assert.equal(preview.preparationPreview().phase,'checking');
  native.signalCode='SIGTERM';native.emit('exit',null,'SIGTERM');
  while(preview.preparationPreview().phase==='checking')await turn();
  assert.equal(preview.preparationPreview().phase,'ready');assert.equal(reads,0);
  assert.equal(worker.events.filter(e=>e.previewTest==='input').length,1);closeDb();
 })().catch(e=>{console.error(e);process.exitCode=1;});
`));
test('independent protocol: background-memory completion makes paused GET stale without starting work',()=>child(`
 (async()=>{
  let busy=true,queued=0;memory.historyProgress=()=>({active:busy,queued,background:true});
  const store=require('./dist/sync/store'),original=store.previewSummaryInput;let snapshots=0;
  store.previewSummaryInput=()=>{snapshots++;return original();};
  assert.equal(preview.requestPreparationPreview().phase,'paused');
  for(let i=0;i<5;i++){await turn();assert.equal(preview.preparationPreview().phase,'paused');}
  assert.equal(preview.requestPreparationPreview().phase,'paused'); // UI's one early retry
  busy=false;queued=1;assert.equal(preview.preparationPreview().phase,'paused');queued=0;
  for(let i=0;i<5;i++){await turn();assert.equal(preview.preparationPreview().phase,'stale');}
  assert.equal(snapshots,0);assert.equal(worker.workers.length,0); // recovery GET is still metadata only
  assert.equal(activity.previewIdle,true);assert.equal(preview.requestPreparationPreview().phase,'checking');
  while(preview.preparationPreview().phase==='checking')await turn();
  assert.equal(preview.preparationPreview().phase,'ready');closeDb();
 })().catch(e=>{console.error(e);process.exitCode=1;});
`));
