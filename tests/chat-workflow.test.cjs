require('./fixtures/fake-memory.cjs');
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const {randomUUID}=require('node:crypto'),Database=require('better-sqlite3');
const {getDb,closeDb}=require('../dist/db/schema'),{HistoryIndex}=require('../dist/memory/index');
const {sourceEntry}=require('./fixtures/source-entry.cjs');
const service=require('../dist/memory/service'),{generateReply}=require('../dist/sync/manager'),live=require('../dist/voice/live');
const {readFactory}=require('../dist/factory/service'),{readDiscovery}=require('../dist/factory/discovery');
const {createWorkflowFromHistory}=require('../dist/factory/create-from-history');
const before='2026-01-08T00:00:00.000Z',question='Make a reusable workflow from that parser bug fix, ending at a review-ready PR.';
const signal=()=>new AbortController().signal;
let root,db,cache,index,syncId,prior,read,search,load,native,contexts,control;
class Native {
 constructor(options){this.options=options;native=this;}
 subscribe(fn){this.emit=fn;return()=>{};}
 async open(_sdp,options){options.onReady?.();return 'synthetic SDP';}
 async text(){}
 async context(text){contexts.push(text);}
 async continueAnswer(){this.emit({method:'thread/realtime/transcript/done',params:{role:'assistant',text:'The application supplied the workflow result.'}});}
 async close(){return {helperExited:true};}
}
beforeEach(async()=>{
 closeDb();prior={...process.env};root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-chat-workflow-'));
 const fake=path.join(root,'pi');fs.copyFileSync(path.join(__dirname,'fixtures/fake-pi.cjs'),fake);fs.chmodSync(fake,0o700);
 Object.assign(process.env,{DRAKEN_DATA_DIR:path.join(root,'data'),DRAKEN_PI_SESSIONS_DIR:path.join(root,'sessions'),DRAKEN_PI_BIN:fake,DRAKEN_PI_SUMMARY_MODEL:'fixture/summary',DRAKEN_PI_FINAL_MODEL:'fixture/final',DRAKEN_FAKE_CONTROL:path.join(root,'control.json'),DRAKEN_TEST_CALL_LOG:path.join(root,'calls.jsonl'),DRAKEN_VOICE_MODE:'native'});
 db=getDb();db.prepare("INSERT OR REPLACE INTO sync_settings VALUES('activity_days','null')").run();
 db.prepare("INSERT OR REPLACE INTO sync_settings VALUES('auto_summary_error','Existing extraction failure')").run();
 fs.mkdirSync(path.join(root,'repo'));
 for(const [i,role,text] of [[0,'user','Fix the parser bug; preserve compatibility.'],[1,'assistant','Added parser regression and corrected escaping.'],[2,'toolResult','Parser compatibility tests: 8 passed.'],[3,'assistant','Uncited task context: deployment is unverified.']]){
  sourceEntry(db,process.env.DRAKEN_PI_SESSIONS_DIR,text,{role,session:i<2?'parser-start':'parser-finish',cwd:path.join(root,'repo'),timestamp:`2026-01-07T12:00:0${i}.000Z`});
 }
 cache=new Database(':memory:');index=new HistoryIndex(cache,db,{fingerprint:'workflow-test',ready:()=>true,setup:async()=>{},embed:async()=>{const v=new Float32Array(384);v[0]=1;return v;}});
 await index.prepare({before});
 read=service.readHistory;search=service.searchPreparedHistory;
 service.readHistory=async(ref,offset,_s,cutoff)=>index.read(ref,offset,cutoff);
 service.searchPreparedHistory=async(query)=>index.search(query,undefined,true);
 const now=new Date().toISOString();syncId=Number(db.prepare('INSERT INTO syncs(created_at,snapshot_at,snapshot_version,briefing,compression_complete,conversation_before) VALUES (?,?,2,?,1,?)').run(now,before,'We discussed the parser fix.',before).lastInsertRowid);
 control={evidencePlan:{scope:'project',sessions:[],query:'parser compatibility bug regression',kind:'sources',recent:false,action:'create_workflow'}};
 fs.writeFileSync(process.env.DRAKEN_FAKE_CONTROL,JSON.stringify(control));contexts=[];
 load=Module._load;Module._load=function(name,...args){if(name.endsWith('/voice/realtime/native.mjs'))return{NativeVoice:Native,nativeStatus:async()=>({readyForProbe:true})};return load.call(this,name,...args);};
});
afterEach(async()=>{await live.stopLiveCalls();Module._load=load;service.readHistory=read;service.searchPreparedHistory=search;cache.close();closeDb();for(const k of Object.keys(process.env))if(!(k in prior))delete process.env[k];Object.assign(process.env,prior);fs.rmSync(root,{recursive:true,force:true});});
const calls=()=>fs.existsSync(process.env.DRAKEN_TEST_CALL_LOG)?fs.readFileSync(process.env.DRAKEN_TEST_CALL_LOG,'utf8').split('\n').slice(0,-1).filter(Boolean).map(JSON.parse):[];
async function chat(request=randomUUID()){return generateReply(syncId,question,request);}
function unchanged(){assert.equal(db.prepare("SELECT value FROM sync_settings WHERE key='auto_summary_error'").get().value,'Existing extraction failure');assert.equal(db.prepare('SELECT COUNT(*) n FROM background_runs').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_coverage').get().n,0);assert.equal(fs.existsSync(path.join(process.env.DRAKEN_DATA_DIR,'factory-workspaces')),false);}

test('existing text chat creates one cross-session task workflow, enriches once, links Factory and preserves endpoint',async()=>{
 const request=randomUUID(),result=await chat(request),page=await readFactory(undefined,signal());
 assert.equal(page.proposals.length,1);const p=page.proposals[0];assert.equal(p.decision,null);assert.ok(p.task);assert.equal(p.evidence.length,1);assert.equal(p.enrichment.status,'ready');
 assert.match(p.task.workflow.method.join(' '),/review-ready PR/);assert.match(result.messages.at(-1).content,new RegExp('/factory#workflow-'+p.id));
 assert.match(p.task.request,/parser bug/);assert.equal(db.prepare('SELECT COUNT(*) n FROM process_extractions').get().n,0,'no fake comparison or summary leaf');
 assert.equal(db.prepare('SELECT run_table FROM workflow_enrichments').get().run_table,'sync_runs');
 assert.deepEqual(calls().map(c=>c.task),['plan_evidence','select_evidence','create_workflow_from_history','enrich_workflow']);
 assert.equal(db.prepare('SELECT invocations FROM sync_runs').get().invocations,4);
 assert.ok(JSON.parse(db.prepare('SELECT metrics_json FROM sync_runs').get().metrics_json).every(m=>m.accounting?.complete&&m.accounting.cost_usd>0));
 await chat(request);assert.equal(calls().length,4);assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_discoveries').get().n,1);
 const seen=calls().length;await readFactory(undefined,signal());await readFactory(undefined,signal());assert.equal(calls().length,seen);unchanged();
});
test('another request reuses a suitable workflow without paying for enrichment again',async()=>{
 await chat();await chat();assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_discoveries').get().n,1);
 assert.equal(calls().filter(c=>c.task==='enrich_workflow').length,1);assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,1);
 assert.match(db.prepare("SELECT content FROM sync_messages WHERE role='assistant' ORDER BY id DESC LIMIT 1").get().content,/Reused/);unchanged();
});
test('a materially different workflow is not silently merged with an existing one',async()=>{
 await chat();control.workflowAssessment={relation:'different',workflow:null,stagePairs:[],reason:'Different endpoint and applicability',limitations:[]};fs.writeFileSync(process.env.DRAKEN_FAKE_CONTROL,JSON.stringify(control));
 await chat();assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_discoveries').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_enrichments').get().n,2);
});
test('clarification does not save a workflow, and malformed extraction retains the failed attempt',async()=>{
 control.taskWorkflow={kind:'clarify',message:'Which parser fix do you mean?',process:null,fragment:null,repositoryRef:null,workflow:null};fs.writeFileSync(process.env.DRAKEN_FAKE_CONTROL,JSON.stringify(control));
 const result=await chat();assert.match(result.messages.at(-1).content,/Which parser/);assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_discoveries').get().n,0);
 control.taskWorkflow={invalid:true};fs.writeFileSync(process.env.DRAKEN_FAKE_CONTROL,JSON.stringify(control));await assert.rejects(chat(),/Invalid task discovery/);
 const failed=db.prepare("SELECT raw_output FROM workflow_requests WHERE status='failed'").get();assert.match(failed.raw_output,/invalid/);unchanged();
});
test('enrichment failure retains discovery and paid output, and duplicate delivery does not retry',async()=>{
 control.invalidEnrichment=true;fs.writeFileSync(process.env.DRAKEN_FAKE_CONTROL,JSON.stringify(control));const request=randomUUID();const result=await chat(request);
 assert.match(result.messages.at(-1).content,/enrichment did not complete/);const p=(await readFactory(undefined,signal())).proposals[0];assert.equal(p.enrichment.status,'failed');
 await chat(request);assert.equal(calls().filter(c=>c.task==='enrich_workflow').length,1);assert.ok(db.prepare('SELECT raw_output FROM workflow_enrichments').get().raw_output);
});
test('revoking an uncited original blocks new evidence use but leaves the saved workflow visible',async()=>{
 await chat();const id=db.prepare('SELECT id FROM workflow_discoveries').get().id;
 db.prepare("UPDATE agent_sessions SET included=0 WHERE id='parser-finish'").run();
 assert.equal((await readFactory(undefined,signal())).proposals.length,1);await assert.rejects(readDiscovery(id,signal()));
});
test('legacy requested-workflow permission scopes migrate once without changing saved receipts or paying again',async()=>{
 await chat();const row=db.prepare('SELECT * FROM workflow_discoveries').get(),count=calls().length;assert.ok(JSON.parse(row.source_refs_json).length);
 db.prepare('UPDATE workflow_discoveries SET source_refs_json=NULL,display_json=NULL WHERE id=?').run(row.id);
 const restored=await require('../dist/factory/discovery').readProposal(row.id,signal());
 require('../dist/factory/display-store').saveWorkflowDisplay(restored);
 const saved=await readDiscovery(row.id,signal());assert.equal(db.prepare('SELECT source_refs_json FROM workflow_discoveries').get().source_refs_json,row.source_refs_json);
 const receipt=db.prepare('SELECT source_json,output_json,request_json FROM workflow_discoveries').get();
 const changes=db.prepare('SELECT total_changes() n').get().n;
 assert.deepEqual(await readDiscovery(row.id,signal()),saved);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 assert.deepEqual(db.prepare('SELECT source_json,output_json,request_json FROM workflow_discoveries').get(),receipt);assert.equal(calls().length,count);
});
test('unimported legacy task records still require their original content',async()=>{
 await chat();const beforeCalls=calls().length;
 const files=fs.readdirSync(process.env.DRAKEN_PI_SESSIONS_DIR);for(const file of files){const p=path.join(process.env.DRAKEN_PI_SESSIONS_DIR,file);if(fs.statSync(p).isFile())fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('Uncited task context','Changed task context'));}
 const page=await readFactory(undefined,signal());assert.equal(page.proposals.length,1);await assert.rejects(readDiscovery(page.proposals[0].id,signal()));assert.equal(calls().length,beforeCalls);
});
test('creation cannot substitute a model-supplied turn or accounting owner',async()=>{
 await chat();const run=db.prepare('SELECT id FROM sync_runs').get().id;
 await assert.rejects(createWorkflowFromHistory({syncId,turn:{kind:'text',id:99999},runId:run,model:'fixture',selection:{before,selections:[]},signal:signal(),checkCurrent:()=>{},ask:async()=>{throw Error('must not call');}}),/actual user turn/);
});
test('ordinary conversation does not create workflows or add a classifier call',async()=>{
 delete control.evidencePlan.action;fs.writeFileSync(process.env.DRAKEN_FAKE_CONTROL,JSON.stringify(control));await generateReply(syncId,'What happened with the parser?',randomUUID());
 assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_requests').get().n,0);assert.deepEqual(calls().map(c=>c.task),['plan_evidence','select_evidence','final_verdict']);
});
async function waitForTask(task) {
 const until=Date.now()+5000;while(!calls().some(c=>c.task===task)){if(Date.now()>until)throw Error('Did not reach '+task);await new Promise(r=>setTimeout(r,10));}
}
test('Stop during text reconstruction cancels the owned attempt without creating a workflow',async()=>{
 control.taskDelays={create_workflow_from_history:700};fs.writeFileSync(process.env.DRAKEN_FAKE_CONTROL,JSON.stringify(control));
 const pending=chat();const rejected=assert.rejects(pending);await waitForTask('create_workflow_from_history');require('../dist/sync/manager').cancelReply(syncId);await rejected;
 assert.equal(db.prepare('SELECT status FROM workflow_requests').get().status,'cancelled');assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_discoveries').get().n,0);
 assert.equal(db.prepare('SELECT invocations FROM sync_runs').get().invocations,3);unchanged();
});
test('source revocation while reconstruction is paid prevents saving its output',async()=>{
 control.taskDelays={create_workflow_from_history:300};fs.writeFileSync(process.env.DRAKEN_FAKE_CONTROL,JSON.stringify(control));
 const pending=chat(),rejected=assert.rejects(pending);await waitForTask('create_workflow_from_history');db.prepare("UPDATE agent_sessions SET included=0 WHERE id='parser-finish'").run();await rejected;
 assert.equal(db.prepare('SELECT status FROM workflow_requests').get().status,'failed');assert.ok(db.prepare('SELECT raw_output FROM workflow_requests').get().raw_output);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_discoveries').get().n,0);unchanged();
});
test('voice Stop during enrichment retains the discovery but sends no late saved result',async()=>{
 control.taskDelays={enrich_workflow:700};fs.writeFileSync(process.env.DRAKEN_FAKE_CONTROL,JSON.stringify(control));
 const call=await live.createLiveCall(syncId,signal());await live.connectLiveCall(call.id,'synthetic SDP',signal());
 const pending=live.sendLiveText(call.id,question,randomUUID());await waitForTask('enrich_workflow');
 const progress=await native.options.answer([],signal());assert.match(progress,/preparing the workflow/);assert.equal(calls().length,4);
 await live.interruptLiveCall(call.id);await pending;
 assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_discoveries').get().n,1);assert.equal(db.prepare('SELECT status FROM workflow_enrichments').get().status,'cancelled');
 assert.equal(db.prepare('SELECT status FROM workflow_requests').get().status,'cancelled');assert.ok(!contexts.some(c=>c.includes('workflow_creation_result')));
 assert.equal((await readFactory(undefined,signal())).proposals[0].enrichment.status,'failed');unchanged();
});
test('native actual user turn invokes the same creation service and delivers a separate action result',async()=>{
 const call=await live.createLiveCall(syncId,signal());await live.connectLiveCall(call.id,'synthetic SDP',signal());
 const request=randomUUID();await live.sendLiveText(call.id,question,request);
 const page=await readFactory(undefined,signal());assert.equal(page.proposals.length,1);assert.equal(page.proposals[0].enrichment.status,'ready');
 assert.equal(db.prepare('SELECT turn_key FROM workflow_requests').get().turn_key.startsWith('voice:'),true);
 assert.ok(contexts.some(c=>JSON.parse(c).type==='workflow_creation_result'));
 assert.ok(!contexts.some(c=>c.includes('read_only_context_ready')&&c.includes('Saved')));
 const n=calls().length;await native.options.answer({input:[{role:'user',content:[{type:'input_text',text:'Save a second workflow'}]}]},signal());await live.sendLiveText(call.id,question,request);
 assert.equal(calls().length,n);assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_discoveries').get().n,1);unchanged();
});
