const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {getDb,closeDb}=require('../dist/db/schema');
const {frozenEvidence}=require('./fixtures/source-entry.cjs');
const {examples}=require('./fixtures/workflow-identity-cases.cjs');
const {saveSummaryProcess,readProcessParent,learningInputKey,workflowComparisonPayload,COMPARISON_FORMAT}=require('../dist/factory/learning-store');
const {CONTRACT_MATCH_PROMPT,decideContractMatch}=require('../dist/workflow-learning');
const {digest}=require('../dist/sync/normalize');
const {readFactory}=require('../dist/factory/service');
const {readDiscovery}=require('../dist/factory/discovery');
const {saveWorkflowDisplay,saveMissingWorkflowDisplays}=require('../dist/factory/display-store');
async function storedButNotValidEvidence(){const result=await readFactory(undefined,signal());assert.equal(result.proposals.length,1);assert.equal(result.unavailable,0);await assert.rejects(readDiscovery(result.proposals[0].id,signal()));}
const {createApp}=require('../dist/server');
let dir,db,prior,server;
const signal=()=>new AbortController().signal;
beforeEach(()=>{
 closeDb();dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-'));prior={...process.env};
 Object.assign(process.env,{DRAKEN_DATA_DIR:dir,DRAKEN_PI_SESSIONS_DIR:path.join(dir,'sessions'),DRAKEN_NO_AUTH:'true',DRAKEN_HOST:'127.0.0.1',DRAKEN_PI_BIN:'/no-provider',DRAKEN_USERNAME:'test',DRAKEN_PASSWORD:'test-password',DRAKEN_JWT_SECRET:'factory-test-secret'});db=getDb();fs.mkdirSync(path.join(dir,'work'));
});
afterEach(async()=>{if(server){await new Promise(r=>server.close(r));server=undefined;}closeDb();for(const k of Object.keys(process.env))if(!(k in prior))delete process.env[k];Object.assign(process.env,prior);fs.rmSync(dir,{recursive:true,force:true});});
async function seed(locations=[]){
 const c=examples()[0],parents=[];
 for(const [i,side] of [c.left,c.right].entries()){
  const session='episode-'+i,records=[...side.records,{ref:'X',role:'toolResult',text:'Uncited dependency'}];
  const pointers=records.map(r=>frozenEvidence(db,path.join(dir,'sessions'),r.text,{ref:r.ref,session,cwd:locations[i]||path.join(dir,'work'),role:r.role,timestamp:'2020-01-02T00:00:00.000Z'}));
  const refs={U:'S1',I:'S2',O:'S3'};
  function remap(v,key){if(Array.isArray(v))return v.map(x=>typeof x==='string'&&['refs','triggerRefs','outcomeRefs'].includes(key)?refs[x]:remap(x,key));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,remap(x,k)]));return v;}
  saveSummaryProcess('parent-'+i,'fake/model',{table:'sync_runs',id:1},JSON.stringify({session,workspace:locations[i]||path.join(dir,'work'),evidence:pointers,background:[]}),{summary:'Saved process',fragments:[remap(side.fragment,'')],limitations:[]},pointers.map(p=>p.source_key),records.map(r=>r.role));
  const row=db.prepare("SELECT id FROM process_extractions WHERE json_extract(source_dependencies_json,'$.leaf')=?").get('parent-'+i);
  parents.push({extraction:row.id,fragment:'example'});
 }
 const sides=[];for(const parent of parents)sides.push(await readProcessParent(parent,signal()));
 const model='fake/model',recipe=digest(CONTRACT_MATCH_PROMPT),id=digest('Factory fixture');
 const assessment={relation:'same_workflow_candidate',workflow:{purpose:'Repair a parser defect',method:['Reproduce the defect with a failing regression test','Correct the parser and run the regression and compatibility tests'],appliesWhen:'A parser defect must be fixed without changing the documented format'},stagePairs:[{left:'S1',right:'S1'},{left:'S2',right:'S2'}],reason:'Same purpose and method',limitations:[]};
 const decision=decideContractMatch(assessment,sides.map(s=>s.input));
 const deps={format:COMPARISON_FORMAT,phase:'match',parents,identities:sides.map(s=>s.identity),pair:[0,1],location:sides[0].location},payload=workflowComparisonPayload(sides.map(s=>s.input));
 db.prepare("INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,output_json,created_at) VALUES (?,'comparison',?,?,?,'completed',?,?,?)")
  .run(id,learningInputKey(deps,payload,model),recipe,model,JSON.stringify(deps),JSON.stringify(decision),new Date().toISOString());
 saveWorkflowDisplay({id,model,createdAt:new Date().toISOString(),location:sides[0].location,decision,evidence:sides.map(s=>s.input)});
 return {id,parents};
}
test('Factory reads stored proposals without syncs, provider calls or new work',async()=>{
 await seed();const before=db.prepare('SELECT COUNT(*) n FROM process_extractions').get().n;
 const result=await readFactory(undefined,signal());assert.equal(result.learning,'enabled');assert.equal(result.proposals.length,1);assert.equal(result.proposals[0].decision.sameWorkflow,true);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM process_extractions').get().n,before);
 for(const table of ['syncs','sync_runs','background_runs'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 assert.equal(result.proposals[0].location.path,path.join(dir,'work'));
 assert.equal(result.proposals[0].location.kind,'folder');
 assert.ok(!JSON.stringify(result).includes(path.join(dir,'sessions')));
});
test('display migration uses stored results and repeated page reads neither read originals nor write data',async()=>{
 const {id}=await seed();db.prepare('UPDATE workflow_discoveries SET display_json=NULL WHERE id=?').run(id);fs.rmSync(path.join(dir,'sessions'),{recursive:true});saveMissingWorkflowDisplays();
 const original=fs.readFileSync;let reads=0;fs.readFileSync=(...args)=>{reads++;throw Error('Factory must read the database only')};
 try{const changes=db.prepare('SELECT total_changes() n').get().n;for(let i=0;i<3;i++)assert.equal((await readFactory(undefined,signal())).proposals.length,1);assert.equal(reads,0);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);}finally{fs.readFileSync=original;}
 await assert.rejects(readDiscovery(id,signal()));
});
test('enrichment rejects uncited source revocation after its accounted planning callback',async()=>{
 const {readDiscovery}=require('../dist/factory/discovery'),{proposeEnrichment}=require('../dist/factory-enrichment');const {id}=await seed(),d=await readDiscovery(id,signal());let calls=0;
 await assert.rejects(proposeEnrichment(d,{assertCurrent:async s=>{if((await readDiscovery(id,s)).revision!==d.revision)throw Error('Changed');},ask:async()=>{calls++;db.prepare("UPDATE agent_entries SET active=0 WHERE session_id='episode-0' AND entry_id='4'").run();return '{}';}},signal()));assert.equal(calls,1);
});
test('Factory reads pending workflows without inference; preparation persists reusable source/policy-scoped enrichment',async()=>{
 const {id}=await seed(),{readDiscovery}=require('../dist/factory/discovery'),{prepareEnrichment,requireEnrichment}=require('../dist/factory/enrichment'),{sessionPlan}=require('../dist/factory-enrichment');
 const d=await readDiscovery(id,signal());assert.equal((await readFactory(undefined,signal())).proposals[0].enrichment.status,'pending');assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_enrichments').get().n,0);let calls=0;
 const ask=async()=>{calls++;return JSON.stringify(require('./fixtures/workflow-enrichment.cjs')(d).guidance);};const saved=await prepareEnrichment(id,{table:'background_runs',id:0},'fixture',ask,signal());
 assert.deepEqual(await readDiscovery(id,signal()),d);assert.deepEqual((await readFactory(undefined,signal())).proposals[0].enrichment.value,saved);
 assert.deepEqual(await prepareEnrichment(id,{table:'background_runs',id:1},'another-model',ask,signal()),saved);assert.equal(calls,1);
 for(const task of ['Fix integers','Fix escaped strings'])assert.deepEqual(sessionPlan(d,task,d.locationKey,await requireEnrichment(id,signal())).enrichment,saved);
 assert.equal(calls,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_enrichments').get().n,1);
 db.prepare("UPDATE workflow_enrichments SET policy_version='old-policy'").run();assert.equal((await readFactory(undefined,signal())).proposals[0].enrichment.status,'ready');await assert.rejects(requireEnrichment(id,signal()),/not ready/);
});
test('invalid enrichment retains the paid output and needs explicit retry; background does not retry it',async()=>{
 const {id}=await seed(),{readDiscovery}=require('../dist/factory/discovery'),{prepareEnrichment,prepareDiscoveredEnrichments}=require('../dist/factory/enrichment');let calls=0;
 await assert.rejects(prepareEnrichment(id,{table:'background_runs',id:0},'fixture',async()=>{calls++;return '{"steps":[]}';},signal()),/enrichment/);
 assert.equal(db.prepare('SELECT raw_output FROM workflow_enrichments').get().raw_output,'{"steps":[]}');assert.equal((await readFactory(undefined,signal())).proposals[0].enrichment.status,'failed');
 const d=await readDiscovery(id,signal()),ask=async()=>{calls++;return JSON.stringify(require('./fixtures/workflow-enrichment.cjs')(d).guidance);};
 await prepareDiscoveredEnrichments(1,'fixture',ask,signal());await assert.rejects(prepareEnrichment(id,{table:'background_runs',id:1},'fixture',ask,signal()),/explicit/);assert.equal(calls,1);
 await prepareEnrichment(id,{table:'background_runs',id:1},'fixture',ask,signal(),true);assert.equal(calls,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_enrichments').get().n,2);
});
function enrichmentOwners() {
 const now=new Date().toISOString();
 const sync=Number(db.prepare('INSERT INTO syncs(created_at) VALUES (?)').run(now).lastInsertRowid);
 const chat=Number(db.prepare("INSERT INTO sync_runs(sync_id,summary_model,final_model,max_invocations,total_entries,started_at) VALUES (?,'fixture/summary','fixture/final',1,0,?)").run(sync,now).lastInsertRowid);
 const background=Number(db.prepare("INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,input_key,status) VALUES ('fixture/summary','fixture/final',1,0,?,'unrelated-preparation','failed')").run(now).lastInsertRowid);
 assert.equal(chat,background,'exercise overlapping IDs in the two accounting tables');
 return {chat,background};
}
test('enrichment belongs to the existing sync owner, not a background job with the same ID',async()=>{
 const {id}=await seed(),{chat,background}=enrichmentOwners();
 const {readDiscovery}=require('../dist/factory/discovery'),{prepareEnrichment,savedEnrichment}=require('../dist/factory/enrichment');
 const discovery=await readDiscovery(id,signal()),before=db.prepare('SELECT * FROM background_runs WHERE id=?').get(background);
 let calls=0;
 const saved=await prepareEnrichment(id,{table:'sync_runs',id:chat},'fixture/final',async()=>{
  calls++;assert.equal(savedEnrichment(discovery).status,'running');
  assert.deepEqual(db.prepare('SELECT run_table,run_id FROM workflow_enrichments').get(),{run_table:'sync_runs',run_id:chat});
  return JSON.stringify(require('./fixtures/workflow-enrichment.cjs')(discovery).guidance);
 },signal());
 assert.equal(calls,1);assert.deepEqual(savedEnrichment(discovery).value,saved);
 assert.deepEqual(db.prepare('SELECT * FROM background_runs WHERE id=?').get(background),before);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM background_runs').get().n,1);
});
test('sync enrichment uses the existing final-model allowance and does not pay twice for saved guidance',async()=>{
 const {id}=await seed(),{chat}=enrichmentOwners(),{prepareEnrichment}=require('../dist/factory/enrichment'),{modelCall}=require('../dist/sync/model-call');
 const fake=path.join(dir,'pi');fs.copyFileSync(path.join(__dirname,'fixtures/fake-pi.cjs'),fake);fs.chmodSync(fake,0o700);
 process.env.DRAKEN_PI_BIN=fake;process.env.DRAKEN_TEST_CALL_LOG=path.join(dir,'calls.jsonl');
 const models={summary:'fixture/summary',final:'fixture/final',max_invocations:1},owner={table:'sync_runs',id:chat};
 const ask=(payload,system)=>modelCall(payload,system,{models,runId:chat,final:true,signal:signal()});
 const saved=await prepareEnrichment(id,owner,models.final,ask,signal());
 assert.deepEqual(await prepareEnrichment(id,owner,models.final,ask,signal()),saved);
 const run=db.prepare('SELECT invocations,metrics_json FROM sync_runs WHERE id=?').get(chat),metrics=JSON.parse(run.metrics_json);
 assert.equal(run.invocations,1);assert.equal(metrics.length,1);assert.equal(metrics[0].model,models.final);assert.equal(metrics[0].task,'enrich_workflow');assert.equal(metrics[0].status,'completed');
 assert.equal(fs.readFileSync(process.env.DRAKEN_TEST_CALL_LOG,'utf8').trim().split('\n').length,1);
 db.prepare("UPDATE workflow_enrichments SET policy_version='previous-policy'").run();
 await assert.rejects(prepareEnrichment(id,owner,models.final,ask,signal()),/Invocation budget/);
 assert.equal(db.prepare('SELECT invocations FROM sync_runs WHERE id=?').get(chat).invocations,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM workflow_enrichments WHERE status='failed'").get().n,1);
 assert.equal(fs.readFileSync(process.env.DRAKEN_TEST_CALL_LOG,'utf8').trim().split('\n').length,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM background_runs').get().n,1);
});
test('stopped sync ownership cannot be mistaken for an active background enrichment',async()=>{
 const {id}=await seed(),{chat,background}=enrichmentOwners(),{readDiscovery}=require('../dist/factory/discovery'),{prepareEnrichment,savedEnrichment}=require('../dist/factory/enrichment');
 const discovery=await readDiscovery(id,signal()),controller=new AbortController();
 await assert.rejects(prepareEnrichment(id,{table:'sync_runs',id:chat},'fixture',async()=>{
  db.prepare("UPDATE sync_runs SET status='cancelled' WHERE id=?").run(chat);
  db.prepare("UPDATE background_runs SET status='running' WHERE id=?").run(background);
  assert.equal(savedEnrichment(discovery).status,'failed');
  controller.abort();return JSON.stringify(require('./fixtures/workflow-enrichment.cjs')(discovery).guidance);
 },controller.signal));
 const row=db.prepare('SELECT status,raw_output,run_table,run_id FROM workflow_enrichments').get();
 assert.equal(row.status,'cancelled');assert.ok(row.raw_output);assert.equal(row.run_table,'sync_runs');assert.equal(row.run_id,chat);
 assert.equal(savedEnrichment(discovery).status,'failed');
});
test('sync-owned enrichment retains invalid paid output and cannot bypass source revocation',async()=>{
 const {id}=await seed(),{chat}=enrichmentOwners(),{prepareEnrichment}=require('../dist/factory/enrichment');
 const owner={table:'sync_runs',id:chat};let calls=0;
 await assert.rejects(prepareEnrichment(id,owner,'fixture',async()=>{calls++;return '{"steps":[]}';},signal()),/enrichment/);
 assert.equal(db.prepare('SELECT raw_output FROM workflow_enrichments').get().raw_output,'{"steps":[]}');
 await assert.rejects(prepareEnrichment(id,owner,'fixture',async()=>{calls++;return '{}';},signal()),/explicit/);
 assert.equal(calls,1);
 await assert.rejects(prepareEnrichment(id,owner,'fixture',async()=>{
  calls++;db.prepare("UPDATE agent_entries SET active=0 WHERE session_id='episode-0' AND entry_id='4'").run();return '{}';
 },signal(),true));
 assert.equal(calls,2);await storedButNotValidEvidence();
 assert.equal(db.prepare("SELECT COUNT(*) n FROM workflow_enrichments WHERE status='failed'").get().n,2);
});
test('existing enrichment receipts keep their background ownership across the additive migration',async()=>{
 const {id}=await seed(),{readDiscovery}=require('../dist/factory/discovery'),{prepareEnrichment}=require('../dist/factory/enrichment');
 const discovery=await readDiscovery(id,signal());
 await prepareEnrichment(id,{table:'background_runs',id:7},'fixture',async()=>JSON.stringify(require('./fixtures/workflow-enrichment.cjs')(discovery).guidance),signal());
 const before=db.prepare('SELECT * FROM workflow_enrichments').get();
 db.exec('ALTER TABLE workflow_enrichments DROP COLUMN run_table');
 const {initProcessSchema}=require('../dist/db/process-schema');initProcessSchema(db);initProcessSchema(db);
 assert.deepEqual(db.prepare('SELECT * FROM workflow_enrichments').get(),before);
});
test('preparation rejects cross-folder evidence without hiding a saved workflow',async()=>{
 const a=path.join(dir,'one'),b=path.join(dir,'two');fs.mkdirSync(a);fs.mkdirSync(b);await seed([a,b]);await storedButNotValidEvidence();
});
test('changing a recorded folder affects preparation, not the saved display',async()=>{
 await seed();require('node:child_process').execFileSync('git',['init','-q',path.join(dir,'work')]);await storedButNotValidEvidence();
});
test('revoking an uncited original affects preparation, not the saved display',async()=>{
 await seed();db.prepare("UPDATE agent_entries SET active=0 WHERE session_id='episode-0' AND entry_id='4'").run();await storedButNotValidEvidence();
});
for(const column of ['input_key','recipe_version','model'])test(`preparation rejects changed comparison ${column}`,async()=>{
 const {id}=await seed();db.prepare(`UPDATE process_extractions SET ${column}='changed' WHERE id=?`).run(id);await storedButNotValidEvidence();
});
test('preparation checks comparison inputs without recomputing the saved display',async()=>{
 const {id}=await seed(),row=db.prepare('SELECT source_dependencies_json FROM process_extractions WHERE id=?').get(id),deps=JSON.parse(row.source_dependencies_json);
 deps.parents.reverse();deps.identities.reverse();db.prepare('UPDATE process_extractions SET source_dependencies_json=? WHERE id=?').run(JSON.stringify(deps),id);await storedButNotValidEvidence();
});
test('session exclusion prevents new evidence use without deleting the saved workflow',async()=>{
 await seed();db.prepare("UPDATE agent_sessions SET included=0 WHERE id='episode-1'").run();await storedButNotValidEvidence();
});
test('changed original bytes affect preparation, not the saved workflow',async()=>{
 await seed();const file=path.join(dir,'sessions','episode-0.jsonl');const text=fs.readFileSync(file,'utf8');fs.writeFileSync(file,text.replace('Uncited dependency','Altered dependency'));await storedButNotValidEvidence();
});
test('stored display ignores legacy external paths while preparation rejects them',async()=>{
 const {id}=await seed();db.prepare('UPDATE process_extractions SET source_dependencies_json=? WHERE id=?').run(JSON.stringify({sources:[{kind:'historical',store:'/external.sqlite'}]}),id);
 await storedButNotValidEvidence();
});
test('changed parent output is rejected even when references remain valid',async()=>{
 const {parents}=await seed();const r=db.prepare('SELECT output_json FROM process_extractions WHERE id=?').get(parents[0].extraction),v=JSON.parse(r.output_json);v.fragments[0].goal='Different job';db.prepare('UPDATE process_extractions SET output_json=? WHERE id=?').run(JSON.stringify(v),parents[0].extraction);await storedButNotValidEvidence();
});
test('shared subprocedures are not promoted by a saved identity flag',async()=>{
 const {id}=await seed();const row=db.prepare('SELECT output_json FROM process_extractions WHERE id=?').get(id),v=JSON.parse(row.output_json);v.assessment.relation='shared_subprocedure';v.sameWorkflow=true;db.prepare('UPDATE process_extractions SET output_json=? WHERE id=?').run(JSON.stringify(v),id);
 const result=await readFactory(undefined,signal());assert.equal(result.proposals.length,1);assert.equal(result.unavailable,0);await assert.rejects(readDiscovery(id,signal()));
});
test('Factory rejects invalid cursors and cancellation without returning content',async()=>{
 for(const cursor of [0,-1,NaN,1.5])await assert.rejects(readFactory(cursor,signal()),/cursor/);
 const c=new AbortController();c.abort();await assert.rejects(readFactory(undefined,c.signal));
});
test('saved workspace results and logs remain readable without revisiting original evidence',async()=>{
 require('node:child_process').execFileSync('git',['init','-q',path.join(dir,'work')]);const {id}=await seed();const {readDiscovery}=require('../dist/factory/discovery');const {readWorkspaces,workspaceLog,startWorkspace}=require('../dist/factory/workspace');const discovery=await readDiscovery(id,signal());
 Object.assign(process.env,{DRAKEN_WORKSPACE_REPO:path.join(dir,'work'),DRAKEN_WORKSPACE_ALLOWED_IMAGES:'["approved"]',DRAKEN_DOCKER_BIN:'/not-called',DRAKEN_DOCKER_HOST:'unix:///not-called',DRAKEN_FACTORY_PI_SDK:__filename,DRAKEN_PI_FINAL_MODEL:'fixture/test'});
 await assert.rejects(startWorkspace({requestId:'22345678-1234-4234-8234-123456789abc',ref:'HEAD',workflowId:id,inputs:{}},'fixture-token'),/enrichment is not ready/);
 assert.equal(fs.existsSync(path.join(dir,'factory-workspaces')),false);
 const enrichment=await require('../dist/factory/enrichment').prepareEnrichment(id,{table:'background_runs',id:0},'fixture',async()=>JSON.stringify(require('./fixtures/workflow-enrichment.cjs')(discovery).guidance),signal()),task=require('../dist/factory-enrichment').workflowRequest(enrichment,{}).task;
 const requestId='12345678-1234-4234-8234-123456789abc',run=path.join(dir,'factory-workspaces',requestId);fs.mkdirSync(path.join(run,'work'),{recursive:true});
 fs.writeFileSync(path.join(run,'request.json'),JSON.stringify({id:requestId,ref:'HEAD',propose:false,workflowId:id,revision:discovery.revision,task,inputs:{},location:discovery.locationKey,createdAt:new Date().toISOString()}));
 fs.writeFileSync(path.join(run,'work/result.json'),JSON.stringify({status:'completed',modelCalls:2,sessionId:'fixture'}));fs.writeFileSync(path.join(run,'work/events.jsonl'),JSON.stringify({type:'stage-result',name:'Test',code:0,stdout:'Verified fixture output'})+'\n');
 fs.mkdirSync(path.join(run,'work/agent'));fs.writeFileSync(path.join(run,'work/agent/enrichment.json'),JSON.stringify({guidance:{review:['Private task review']},requirements:['Do not publish']}));
 assert.equal((await readWorkspaces()).runs[0].workflowId,id);assert.match((await workspaceLog(requestId)).text,/fixture output/);assert.match((await workspaceLog(requestId)).text,/Private task review/);
 assert.equal((await startWorkspace({requestId,ref:'HEAD',workflowId:id,inputs:{}},'fixture-token')).id,requestId);
 await assert.rejects(startWorkspace({requestId,ref:'HEAD',workflowId:id,inputs:{task:'A different task'}},'fixture-token'),/Unexpected workflow input/);
 await assert.rejects(startWorkspace({requestId,ref:'HEAD',workflowId:id,task:'A different task'},'fixture-token'),/request ID/);
 require('../dist/factory/workspace').saveExecutionSettings({maxCalls:24});assert.equal((await readWorkspaces()).maxCalls,24);
 await assert.rejects(startWorkspace({requestId,ref:'HEAD',workflowId:id,inputs:{}},'fixture-token'),/already used/);
 require('../dist/factory/workspace').saveExecutionSettings({maxCalls:16});
 await assert.rejects(startWorkspace({requestId,ref:'HEAD',workflowId:id,inputs:{}}),/authenticated/);
 db.prepare("UPDATE agent_entries SET active=0 WHERE session_id='episode-0' AND entry_id='4'").run();assert.equal((await readWorkspaces()).runs.length,1);assert.match((await workspaceLog(requestId)).text,/fixture output/);await assert.rejects(readDiscovery(id,signal()));
 for(const table of ['sync_runs','background_runs'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
});
test('execution settings persist and reject invalid call allowances',async()=>{
 const {saveExecutionSettings,readWorkspaces}=require('../dist/factory/workspace');
 for(const value of [0,65,-1,1.5,'32',null])assert.throws(()=>saveExecutionSettings({maxCalls:value}),/integer/);
 assert.throws(()=>saveExecutionSettings({maxCalls:32,extra:true}),/integer/);
 saveExecutionSettings({maxCalls:32});assert.equal((await readWorkspaces()).maxCalls,32);assert.equal(db.prepare("SELECT value FROM sync_settings WHERE key='factory_max_calls'").get().value,'32');
});
test('execution refuses invalid input, unauthenticated starts and unknown cancellations',async()=>{
 const {startWorkspace,cancelWorkspace}=require('../dist/factory/workspace');
 await assert.rejects(startWorkspace({requestId:'../../escape',ref:'HEAD'}),/request ID/);
 assert.throws(()=>cancelWorkspace('../../escape'),/Invalid/);
 assert.throws(()=>cancelWorkspace('12345678-1234-4234-8234-123456789abc'),/no longer running/);
 assert.equal(fs.existsSync(path.join(dir,'factory-workspaces')),false);
});
test('Factory API uses existing authentication, same-origin and no-store policy; GET starts no work',async()=>{
 server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/api/factory`;
 const response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual((await response.json()).proposals,[]);
 assert.equal((await fetch(url+'?before=invalid')).status,400);
 assert.equal((await fetch(url,{headers:{Origin:'https://other.example'}})).status,403);
 assert.equal((await fetch(url+'/workspaces')).status,200);
 assert.equal((await fetch(url+'/workspaces/settings',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{"maxCalls":32}'})).status,403);
 assert.equal((await fetch(url+'/'+'a'.repeat(64)+'/enrichment',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(url+'/workspaces',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'})).status,403);
 process.env.DRAKEN_NO_AUTH='false';assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url+'/'+'a'.repeat(64)+'/enrichment',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal((await fetch(url+'/workspaces')).status,401);
 assert.equal((await fetch(url+'/workspaces/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"maxCalls":32}'})).status,401);
 assert.equal((await fetch(url+'/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM background_runs').get().n,0);
});
