require('./fixtures/fake-memory.cjs');
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {getDb,closeDb}=require('../dist/db/schema'),store=require('../dist/sync/store');
const {activity}=require('../dist/sync/activity');
const {scanSessions}=require('../dist/sync/collector'),{generateReply,launchRecap,cancelReply}=require('../dist/sync/manager');
const {summarizeRecap}=require('../dist/sync/recap'),{createApp}=require('../dist/server');
let root,control,log,server;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-home-test-'));fs.mkdirSync(path.join(root,'sessions'));const fake=path.join(root,'pi');fs.copyFileSync(path.join(__dirname,'fixtures/fake-pi.cjs'),fake);fs.chmodSync(fake,0o700);control=path.join(root,'control.json');log=path.join(root,'calls.jsonl');fs.writeFileSync(control,'{}');Object.assign(process.env,{DRAKEN_DATA_DIR:path.join(root,'state'),DRAKEN_PI_SESSIONS_DIR:path.join(root,'sessions'),DRAKEN_PI_BIN:fake,DRAKEN_PI_SUMMARY_MODEL:'test/cheap',DRAKEN_PI_FINAL_MODEL:'test/strong',DRAKEN_FAKE_CONTROL:control,DRAKEN_TEST_CALL_LOG:log,DRAKEN_HOST:'127.0.0.1',DRAKEN_NO_AUTH:'true'});delete process.env.DRAKEN_PI_MAX_INVOCATIONS;});
afterEach(async()=>{for(const id of activity.busyIds)cancelReply(id);await waitIdle();if(server)await new Promise(r=>server.close(r));server=null;closeDb();fs.rmSync(root,{recursive:true,force:true});});
function session(count){const id=randomUUID(),timestamp='2026-01-01T00:00:00Z';fs.writeFileSync(path.join(root,'sessions',id+'.jsonl'),[{type:'session',version:3,id,cwd:'/demo',timestamp},...Array.from({length:count},(_,i)=>({type:'message',id:String(i),parentId:i?String(i-1):null,timestamp,message:{role:i?'assistant':'user',content:id+' synthetic check '+i}}))].map(JSON.stringify).join('\n')+'\n');}
async function waitIdle(){const deadline=Date.now()+15000;while(activity.busy){if(Date.now()>deadline)throw Error('Test job did not stop');await new Promise(r=>setTimeout(r,20));}}
const calls=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[];
test('new snapshots reserve all available entries without review; discard releases them and request IDs deduplicate',async()=>{
 session(130);await scanSessions();const key=randomUUID(),first=store.startConversationSync(key);assert.equal(first.items.length,130);assert.equal(store.homeOverview().available,0);assert.equal(store.homeOverview().included_unreviewed,130);assert.equal(store.pendingCount(),130);assert.equal(store.startConversationSync(key).id,first.id);
 session(3);await scanSessions();const second=store.startConversationSync(randomUUID());assert.equal(second.items.length,3);assert.equal(store.getSync(first.id).items.length,130);assert.equal(store.getSync(first.id).status,'open');assert.equal(store.homeOverview().covered,0);
 store.discardSync(first.id);assert.equal(store.homeOverview().available,130);const third=store.startConversationSync(randomUUID());assert.equal(third.items.length,130);assert.equal(store.homeOverview().available,0);
 closeDb();assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM syncs WHERE status='open'").get().n,2,'Restart preserves independently open snapshots');
 store.completeSync(third.id,'','',true);assert.equal(store.homeOverview().covered,130);assert.equal(store.pendingCount(),3);assert.equal(store.getSync(second.id).status,'open');
});
test('prior sync and call history are frozen, summarized cheaply and carried as summaries rather than active quotes',async()=>{
 session(2);await scanSessions();const first=store.startSync();await generateReply(first.id);getDb().prepare('INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES (?,?,?,?)').run(first.id,'user','HISTORICAL_QUESTION: should we ship?','2026-01-02');
 const second=store.startConversationSync(randomUUID());getDb().prepare('INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES (?,?,?,?)').run(first.id,'user','ARRIVED_AFTER_SNAPSHOT','2026-01-03');
 const ready=await generateReply(second.id);assert.ok(ready.memory[0].recap);assert.equal(ready.memory[0].status,'open');assert.equal(ready.items.length,0);assert.equal(store.homeOverview().covered,0);
 const recapCalls=calls().filter(call=>call.task==='sync_recap');assert.ok(recapCalls.length);assert.ok(recapCalls.every(call=>call.model==='test/cheap'));assert.match(JSON.stringify(recapCalls),/HISTORICAL_QUESTION/);assert.doesNotMatch(JSON.stringify(recapCalls),/ARRIVED_AFTER_SNAPSHOT/);
 const native=JSON.parse(require('../dist/voice/live-context').liveEvidence(ready,'',true).text);assert.ok(native.previous_sync_memory[0].recap);assert.equal(native.historical_quotes_not_current_requests,undefined);assert.doesNotMatch(JSON.stringify(native),/HISTORICAL_QUESTION/);
 const lookup=JSON.parse(require('../dist/voice/live-context').liveEvidence({...ready,messages:[{role:'user',content:'NOT THE PREVIOUS SYNC',created_at:'2026-01-04'}]},'What did we discuss in the previous sync?').text);
 assert.ok(lookup.previous_sync_memory[0].recap);assert.deepEqual(lookup.historical_quotes_not_current_requests,[]);assert.match(lookup.historical_quotes_scope,/not exact/);assert.ok(Buffer.byteLength(JSON.stringify(lookup))<=3500);
 assert.notEqual(store.getSync(first.id).recap_state,'ready','Frozen prior memory must not replace a newer conversation recap');
});
test('recaps visit every transcript fragment, keep roles, cache reductions and reject overlong outputs',async()=>{
 const input={sync_id:1,status:'open',snapshot_at:'2026-01-01',briefing:'Reported checks, not independently verified.',decisions:'**Password:** `synthetic-secret-do-not-send`',carry_forward:'',messages:Array.from({length:50},(_,i)=>({role:i%2?'assistant':'user',created_at:'2026-01-02',content:`MESSAGE_${i} `+'x'.repeat(1200)}))};
 const payloads=[];const ask=async value=>{payloads.push(value);return JSON.stringify({lines:['Reported checks; deployment unverified.','Discussion is not a saved agreement.']});};
 const first=await summarizeRecap(input,'test/cheap',ask,new AbortController().signal);assert.ok(payloads.some(p=>p.stage==='reduce'));for(let i=0;i<50;i++)assert.ok(JSON.stringify(payloads).includes(`MESSAGE_${i} `));assert.match(JSON.stringify(payloads),/"role":"user"/);assert.doesNotMatch(JSON.stringify(payloads),/synthetic-secret-do-not-send/);
 assert.equal(await summarizeRecap(input,'test/cheap',async()=>{throw Error('Cache not reused');},new AbortController().signal),first);
 await assert.rejects(summarizeRecap(input,'different/model',async()=>JSON.stringify({lines:['x'.repeat(161)]}),new AbortController().signal),/concise recap/);
});
test('preparation retains content-free recap validation reasons in the existing metric slots',async()=>{
 session(2);await scanSessions();const first=store.startConversationSync(randomUUID());await generateReply(first.id);
 const next=store.startConversationSync(randomUUID());fs.writeFileSync(control,JSON.stringify({badRecap:true}));
 await assert.rejects(generateReply(next.id),/after two responses: Return only the JSON/);
 const run=store.getSync(next.id).tree.run;assert.equal(run.invocations,2);assert.equal(run.metrics.length,2);
 assert.ok(run.metrics.every(m=>m.task==='sync_recap'&&m.status==='completed'&&m.recap_validation.status==='invalid'));
 assert.ok(run.metrics.every(m=>m.recap_validation.reason.includes('JSON')));assert.doesNotMatch(JSON.stringify(run.metrics),/previous_output|Invalid recap|Synthetic report/);
 fs.writeFileSync(control,'{}');await generateReply(next.id);assert.equal(store.getSync(next.id).tree.run.metrics.find(m=>m.task==='sync_recap').recap_validation.status,'valid');
 assert.equal(store.homeOverview().covered,0);
});

test('standalone recap is asynchronous, cancellable, cached and does not change original sync data',async()=>{
 const sync=store.startSync();const before=getDb().prepare('SELECT * FROM syncs WHERE id=?').get(sync.id);launchRecap(sync.id);assert.equal(store.getSync(sync.id).recap_state,'running');await waitIdle();assert.equal(store.getSync(sync.id).recap_state,'ready');const count=calls().length;launchRecap(sync.id);await waitIdle();assert.equal(calls().length,count);assert.deepEqual(getDb().prepare('SELECT * FROM syncs WHERE id=?').get(sync.id),before);assert.equal(store.homeOverview().covered,0);
 getDb().prepare('UPDATE syncs SET decisions=? WHERE id=?').run('Changed explicit note',sync.id);fs.writeFileSync(control,JSON.stringify({delay:2000}));launchRecap(sync.id);cancelReply(sync.id);await waitIdle();assert.equal(store.getSync(sync.id).recap_state,'failed');assert.equal(store.getSync(sync.id).decisions,'Changed explicit note');
});
test('current redaction is applied to historical indexed text without rewriting its snapshot',async()=>{
 const text='**Password:** `synthetic-legacy-credential`';require('./fixtures/source-entry.cjs').sourceEntry(getDb(),process.env.DRAKEN_PI_SESSIONS_DIR,text,{normalization:1});
 const sync=store.startConversationSync(randomUUID());assert.match(sync.items[0].text,/synthetic-legacy-credential/);await generateReply(sync.id);
 assert.doesNotMatch(JSON.stringify(calls()),/synthetic-legacy-credential/);assert.match(store.getSync(sync.id).items[0].text,/synthetic-legacy-credential/);
});
test('preparation cost covers all aggregation calls and retries, but not questions, calls or standalone recaps',async()=>{
 session(3);await scanSessions();const sync=store.startConversationSync(randomUUID());assert.equal(sync.aggregation_cost,null);
 fs.writeFileSync(control,JSON.stringify({repairableSources:true}));let ready=await generateReply(sync.id);
 let records=calls();assert.ok(records.some(call=>call.repair));assert.equal(ready.aggregation_cost.complete,true);assert.ok(Math.abs(ready.aggregation_cost.usd-records.length*.0031)<1e-12);
 assert.equal(ready.tree.run.metrics.length,records.length);assert.ok(ready.tree.run.metrics.every(metric=>metric.accounting.source==='pi-usage/catalog-pricing'));
 const cost=ready.aggregation_cost;assert.deepEqual(store.homeOverview().syncs[0].aggregation_cost,cost);assert.deepEqual(store.overview().syncs[0].aggregation_cost,cost);
 fs.writeFileSync(control,'{}');ready=await generateReply(sync.id,'What remains unverified?');assert.deepEqual(ready.aggregation_cost,cost);assert.ok(ready.tree.run.metrics.every(metric=>!metric.accounting));
 launchRecap(sync.id);await waitIdle();assert.deepEqual(store.getSync(sync.id).aggregation_cost,cost);
 const before=calls().length;ready=await generateReply(sync.id);assert.equal(calls().length,before,'An already prepared sync makes no new request');assert.deepEqual(ready.aggregation_cost,cost);
 store.configureModels(sync.id,{...ready.models,final:'test/other'});ready=await generateReply(sync.id);assert.equal(calls().length-before,1,'Cached summaries add no new model charges on rebuild');assert.ok(Math.abs(ready.aggregation_cost.usd-cost.usd-.0031)<1e-12);
 store.saveNotes(sync.id,'A new explicit note for the next preparation.','');const second=store.startConversationSync(randomUUID());await generateReply(second.id);const last=store.getSync(second.id).tree.run;assert.ok(last.metrics.every(metric=>metric.accounting));assert.ok(last.metrics.some(metric=>metric.task==='sync_recap'),'Frozen prior recaps made during preparation are accounted');
 assert.equal(store.homeOverview().covered,0);
});
test('missing historical usage stays unavailable; captured retries expose only a partial subtotal',async()=>{
 session(2);await scanSessions();const sync=store.startSync();fs.writeFileSync(control,JSON.stringify({noUsage:true}));let ready=await generateReply(sync.id);assert.deepEqual(ready.aggregation_cost,{usd:null,complete:false});
 getDb().prepare("UPDATE sync_runs SET metrics_json='[]' WHERE sync_id=?").run(sync.id);assert.deepEqual(store.getSync(sync.id).aggregation_cost,{usd:null,complete:false});
 fs.writeFileSync(control,'{}');store.configureModels(sync.id,{...ready.models,final:'test/other'});ready=await generateReply(sync.id);assert.equal(ready.aggregation_cost.complete,false);assert.ok(Math.abs(ready.aggregation_cost.usd-.0031)<1e-12);assert.equal(store.homeOverview().covered,0);
});
test('paid responses rejected by validation remain in aggregation cost',async()=>{
 session(2);await scanSessions();const sync=store.startSync();fs.writeFileSync(control,JSON.stringify({invalidSources:true}));await assert.rejects(generateReply(sync.id));
 const ready=store.getSync(sync.id);assert.ok(!ready.briefing);assert.ok(ready.aggregation_cost.usd>0);assert.equal(ready.aggregation_cost.complete,true);assert.ok(Math.abs(ready.aggregation_cost.usd-calls().length*.0031)<1e-12);assert.equal(store.homeOverview().covered,0);
});
test('usage GETs are metadata-only, strictly bounded and do not scan, infer or change review',async()=>{
 session(2);const db=getDb(),before=db.prepare('SELECT total_changes() n').get().n;
 server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin=`http://127.0.0.1:${server.address().port}`;
 for(const range of ['6h','1d','7d','14d'])for(const bucket of ['1h','6h','24h']){const response=await fetch(origin+`/api/settings/preparation-usage?range=${range}&bucket=${bucket}`);assert.equal(response.status,200);const data=await response.json();assert.equal(data.totals.requests,0);assert.equal(data.totals.completed_batches,0);}
 assert.equal((await fetch(origin+'/api/settings/preparation-usage?range=7d&range=1d')).status,400);
 assert.equal((await fetch(origin+'/api/settings/preparation-usage',{headers:{Origin:'https://other.invalid'}})).status,403);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_sessions').get().n,0);assert.equal(calls().length,0);assert.equal(store.homeOverview().covered,0);
});
test('an active request has one durable timestamped slot, which cancellation completes without duplicating its cost',async()=>{
 session(2);await scanSessions();const sync=store.startSync();fs.writeFileSync(control,JSON.stringify({delay:2000}));
 const pending=generateReply(sync.id).then(()=>null,error=>error);const until=Date.now()+5000;
 while(!store.getProgress(sync.id).run?.metrics.some(m=>m.status==='running')){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10));}
 const active=store.getProgress(sync.id).run;assert.equal(active.invocations,active.metrics.length);assert.ok(active.metrics[0].started_at);assert.equal(active.metrics[0].finished_at,undefined);
 const usage=require('../dist/sync/usage').preparationUsage(getDb(),{},Date.now()+1);assert.equal(usage.active_attempts,1);assert.equal(usage.totals.requests,1);assert.equal(usage.totals.cost.usd,null);
 cancelReply(sync.id);assert.ok(await pending);const stopped=store.getProgress(sync.id).run;assert.equal(stopped.metrics.length,1);assert.equal(stopped.metrics[0].started_at,active.metrics[0].started_at);assert.ok(stopped.metrics[0].finished_at);assert.equal(stopped.metrics[0].status,'cancelled');
});

test('home API is compact, paginated, same-origin protected and one-click preparation is idempotent',async()=>{
 session(4);server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const key=randomUUID(),post=()=>fetch(origin+'/api/syncs/start-call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:key})});
 assert.equal((await fetch(origin+'/api/syncs/start-call',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.invalid'},body:JSON.stringify({request_id:key})})).status,403);
 const response=await post();assert.equal(response.status,202);const created=await response.json();assert.equal(created.sync.items.length,4);assert.equal((await (await post()).json()).sync.id,created.sync.id);await waitIdle();
 const home=await (await fetch(origin+'/api/home')).json();assert.equal(home.syncs.length,1);assert.equal(home.syncs[0].id,created.sync.id);assert.equal(home.syncs[0].briefing,undefined);assert.equal(home.syncs[0].items,undefined);assert.ok(home.syncs[0].preview.length<=600);assert.equal(home.covered,0);
 for(let i=0;i<23;i++)store.startConversationSync(randomUUID());const page=store.homeOverview();assert.equal(page.syncs.length,20);assert.ok(page.next_cursor);assert.equal(store.homeOverview(page.next_cursor).syncs.length,4);
});
