require('./fixtures/fake-memory.cjs');
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {getDb,closeDb}=require('../dist/db/schema');
const {scanSessions}=require('../dist/sync/collector');
const store=require('../dist/sync/store');
const {generateReply}=require('../dist/sync/manager');
const {warmSummaryCache}=require('../dist/sync/summary-preparation');
const {createAutoIndexer,setAutoSummary,stopBackgroundIndexing}=require('../dist/sync/background');
const {readFactory}=require('../dist/factory/service');
const {pendingWorkflows}=require('../dist/factory/learning-store');
const {examples}=require('./fixtures/workflow-identity-cases.cjs');
let root,controlFile,log,prior,controller;
const fixture=()=>({summary:'Parser repair process',fragments:[examples()[0].left.fragment],limitations:[]});
const controls=value=>fs.writeFileSync(controlFile,JSON.stringify({workflowProcess:fixture(),...value}));
const calls=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const warm=()=>warmSummaryCache(controller.signal);
const factory=()=>readFactory(undefined,new AbortController().signal);
beforeEach(()=>{
 closeDb();prior={...process.env};root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-background-'));fs.mkdirSync(root+'/sessions');
 const fake=root+'/pi';fs.copyFileSync(path.join(__dirname,'fixtures/fake-pi.cjs'),fake);fs.chmodSync(fake,0o700);controlFile=root+'/control.json';log=root+'/calls.jsonl';
 Object.assign(process.env,{DRAKEN_DATA_DIR:root+'/state',DRAKEN_PI_SESSIONS_DIR:root+'/sessions',DRAKEN_PI_BIN:fake,DRAKEN_FAKE_CONTROL:controlFile,DRAKEN_TEST_CALL_LOG:log,DRAKEN_PI_SUMMARY_MODEL:'openai/gpt-6-luna',DRAKEN_PI_FINAL_MODEL:'openai/gpt-6-astra'});
 delete process.env.DRAKEN_PI_MAX_INVOCATIONS;delete process.env.DRAKEN_PI_TIMEOUT_MS;
 getDb().prepare("INSERT INTO sync_settings VALUES('activity_days','null')").run();controller=new AbortController();controls({});
});
afterEach(async()=>{controller.abort();await stopBackgroundIndexing();closeDb();for(const k of Object.keys(process.env))if(!(k in prior))delete process.env[k];Object.assign(process.env,prior);fs.rmSync(root,{recursive:true,force:true});});
function history(count=2){
 const records=[...examples()[0].left.records,{ref:'X',role:'toolResult',text:'Uncited context'}];
 for(let s=0;s<count;s++){
  const session='job-'+s,rows=[{type:'session',version:3,id:session,cwd:'/synthetic/workflow',timestamp:'2026-01-01T00:00:00.000Z'}];
  records.forEach((r,i)=>rows.push({type:'message',id:session+'-'+i,parentId:i?session+'-'+(i-1):null,timestamp:new Date(Date.UTC(2026,0,1,s,i)).toISOString(),message:{role:r.role,content:r.text+' Instance '+session}}));
  fs.writeFileSync(root+'/sessions/'+session+'.jsonl',rows.map(JSON.stringify).join('\n')+'\n');
 }
}
async function waitFor(predicate){for(let i=0;i<500;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Timed out waiting for background work');}
function noSync(){for(const table of ['syncs','sync_runs','sync_items','sync_coverage','sync_messages'])assert.equal(getDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);}
test('normal background tick saves process records with summaries and detects a Factory proposal without a sync or page visit',async()=>{
 history();await scanSessions();
 const worker=createAutoIndexer({enabled:()=>true,idle:()=>true,now:Date.now,scan:scanSessions,stamp:()=>new Map(),baseline:()=>new Map(),prepare:async()=>assert.fail('No new indexing is needed'),completed:()=>{},prepareSummaries:warmSummaryCache});
 await worker.tick();await worker.stop();
 const db=getDb(),run=db.prepare('SELECT * FROM background_runs ORDER BY id DESC LIMIT 1').get();assert.equal(run.status,'completed');
 assert.equal(run.invocations,calls().length);assert.ok(calls().every(c=>c.model==='openai/gpt-6-luna'));
 const chunks=calls().filter(c=>c.task==='summarize'&&c.stage==='chunk');assert.equal(chunks.length,2);
 assert.ok(chunks.every(c=>c.system.includes('process property alongside observations')));
 assert.equal(db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE kind='summary' AND status='completed'").get().n,2);
 assert.equal(calls().filter(c=>c.task==='select_workflow_candidates').length,1);assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,1);
 assert.equal(pendingWorkflows(),false);noSync();
 const count=calls().length;const page=await factory();assert.equal(page.learning,'enabled');assert.equal(page.proposals.length,1);assert.equal(page.proposals[0].decision.sameWorkflow,true);assert.equal(calls().length,count);
 for(const row of db.prepare("SELECT source_dependencies_json FROM process_extractions WHERE kind='summary'").all()){assert.ok(row.source_dependencies_json.includes('source_pointer'));assert.doesNotMatch(row.source_dependencies_json,/"text":/);}
 await warm();assert.equal(calls().length,count,'unchanged ticks do not repeat paid work');
});
test('resummarizing the same originals with another model is not a second workflow example',async()=>{
 history(1);await scanSessions();await warm();process.env.DRAKEN_PI_SUMMARY_MODEL='synthetic/new-summary';await warm();
 assert.equal(getDb().prepare("SELECT COUNT(*) n FROM process_extractions WHERE kind='summary' AND status='completed'").get().n,2);
 assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,0);assert.equal((await factory()).proposals.length,0);
});
test('background summarization opt-out stops learning; enabling it works on already-ingested data',async()=>{
 history();await scanSessions();setAutoSummary(false);await warm();assert.equal(calls().length,0);assert.equal((await factory()).learning,'paused');
 setAutoSummary(true);await warm();assert.equal((await factory()).proposals.length,1);noSync();
});
test('shared subprocedures remain different parent workflows',async()=>{
 history();await scanSessions();controls({workflowAssessment:{relation:'shared_subprocedure',workflow:{purpose:'Validate parser compatibility',method:['Run compatibility checks'],appliesWhen:'A parser change needs verification'},stagePairs:[{left:'S2',right:'S2'}],reason:'Only a shared part',limitations:[]}});
 await warm();assert.equal((await factory()).proposals.length,0);assert.equal(pendingWorkflows(),false);
 const row=getDb().prepare("SELECT output_json FROM process_extractions WHERE json_extract(source_dependencies_json,'$.phase')='match'").get();assert.equal(JSON.parse(row.output_json).sameWorkflow,false);
});
test('failed process extraction does not replace or break the ordinary summary and is visible on Factory',async()=>{
 history(1);await scanSessions();controls({invalidProcess:true});await warm();
 const db=getDb();assert.equal(db.prepare('SELECT status FROM background_runs').get().status,'completed');assert.ok(db.prepare('SELECT COUNT(*) n FROM summary_cache').get().n>0);
 assert.equal((await factory()).failedExtractions,1);assert.equal((await factory()).proposals.length,0);
 const count=calls().length;await warm();assert.equal(calls().length,count);
});
test('source revocation during candidate inference prevents admission and further matching',async()=>{
 history();await scanSessions();controls({taskDelays:{select_workflow_candidates:400}});
 const done=warm();await waitFor(()=>calls().some(c=>c.task==='select_workflow_candidates'));
 getDb().prepare("UPDATE agent_sessions SET included=0 WHERE id='job-0'").run();await done;
 assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,0);assert.equal((await factory()).proposals.length,0);
 const count=calls().length;await warm();assert.equal(calls().length,count);
});
test('uncited originals and unselected candidate dependencies are revalidated before Factory display',async()=>{
 history(3);await scanSessions();await warm();const page=await factory();assert.equal(page.proposals.length,2);
 const db=getDb(),row=db.prepare("SELECT source_dependencies_json FROM process_extractions WHERE json_extract(source_dependencies_json,'$.phase')='match' ORDER BY rowid DESC LIMIT 1").get(),deps=JSON.parse(row.source_dependencies_json);
 assert.equal(deps.parents.length,3);assert.ok(!deps.pair.includes(2));
 const parent=db.prepare('SELECT source_dependencies_json FROM process_extractions WHERE id=?').get(deps.parents[2].extraction),input=JSON.parse(parent.source_dependencies_json).input;
 db.prepare('UPDATE agent_entries SET active=0 WHERE session_id=? AND entry_id=?').run(input.session,input.evidence[3].entry_id);
 const after=await factory();assert.equal(after.proposals.length,0);assert.equal(after.unavailable,2);
});
test('cancelled matching retains accounting and resumes with cached summaries and candidate selection',async()=>{
 history();await scanSessions();controls({taskDelays:{compare_workflow_identity:1000}});
 const done=warm();await waitFor(()=>calls().some(c=>c.task==='compare_workflow_identity'));controller.abort();await done;
 const db=getDb(),before=db.prepare('SELECT * FROM background_runs').get();assert.equal(before.status,'cancelled');assert.equal((await factory()).proposals.length,0);
 const summaries=calls().filter(c=>c.task==='summarize').length,selections=calls().filter(c=>c.task==='select_workflow_candidates').length;
 controller=new AbortController();controls({});await warm();
 assert.equal(db.prepare('SELECT COUNT(*) n FROM background_runs').get().n,1);assert.equal(db.prepare('SELECT invocations FROM background_runs').get().invocations,before.invocations+1);
 assert.equal(calls().filter(c=>c.task==='summarize').length,summaries);assert.equal(calls().filter(c=>c.task==='select_workflow_candidates').length,selections);assert.equal((await factory()).proposals.length,1);
});
test('foreground summarization feeds background learning even when the open conversation holds all pending history',async()=>{
 history();await scanSessions();setAutoSummary(false);
 const sync=store.startConversationSync('workflow-foreground');await generateReply(sync.id,undefined,undefined,{deferHistory:true});
 assert.equal(store.previewSummaryInput().items.length,0);assert.equal(pendingWorkflows(),true);
 assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,0);
 setAutoSummary(true);await warm();assert.equal((await factory()).proposals.length,1);assert.equal(pendingWorkflows(),false);
 const count=calls().length;await warm();assert.equal(calls().length,count);
});
test('workflow comparisons cannot exceed the summarization job invocation allowance',async()=>{
 history();await scanSessions();process.env.DRAKEN_PI_MAX_INVOCATIONS='3';await warm();
 const run=getDb().prepare('SELECT * FROM background_runs ORDER BY id DESC LIMIT 1').get();
 assert.ok(run.invocations<=3);assert.equal(run.status,'failed');assert.equal((await factory()).proposals.length,0);
 const count=calls().length;await warm();assert.equal(calls().length,count);
});
test('original-byte changes during leaf inference prevent retaining procedural claims',async()=>{
 history(1);await scanSessions();controls({taskDelays:{summarize:400}});
 const done=warm();await waitFor(()=>calls().some(c=>c.task==='summarize'));
 const file=root+'/sessions/job-0.jsonl';fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('Uncited context','Changed context'));
 await done;const db=getDb();assert.equal(db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE kind='summary' AND status='completed'").get().n,0);
 assert.equal((await factory()).proposals.length,0);
});
test('failed matching is not automatically retried; explicit preparation retry retains earlier receipts',async()=>{
 history();await scanSessions();controls({failStage:'workflow_match'});await warm();
 const db=getDb();assert.equal(db.prepare('SELECT status FROM background_runs').get().status,'failed');const count=calls().length;await warm();assert.equal(calls().length,count);
 controls({});setAutoSummary(true);await warm();assert.equal((await factory()).proposals.length,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE status='failed'").get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM background_runs').get().n,2);
});
