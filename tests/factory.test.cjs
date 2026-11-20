const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {getDb,closeDb}=require('../dist/db/schema');
const {frozenEvidence}=require('./fixtures/source-entry.cjs');
const {examples}=require('./fixtures/workflow-identity-cases.cjs');
const {saveSummaryProcess,readProcessParent,learningInputKey,workflowComparisonPayload,COMPARISON_FORMAT}=require('../dist/factory/learning-store');
const {CONTRACT_MATCH_PROMPT,decideContractMatch}=require('../dist/workflow-learning');
const {digest}=require('../dist/sync/normalize');
const {readFactory}=require('../dist/factory/service');
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
 const deps={format:COMPARISON_FORMAT,phase:'match',parents,identities:sides.map(s=>s.identity),pair:[0,1]},payload=workflowComparisonPayload(sides.map(s=>s.input));
 db.prepare("INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,output_json,created_at) VALUES (?,'comparison',?,?,?,'completed',?,?,?)")
  .run(id,learningInputKey(deps,payload,model),recipe,model,JSON.stringify(deps),JSON.stringify(decision),new Date().toISOString());
 return {id,parents};
}
test('Factory reads verified saved proposals without syncs, provider calls or new work',async()=>{
 await seed();const before=db.prepare('SELECT COUNT(*) n FROM process_extractions').get().n;
 const result=await readFactory(undefined,signal());assert.equal(result.learning,'enabled');assert.equal(result.proposals.length,1);assert.equal(result.proposals[0].decision.sameWorkflow,true);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM process_extractions').get().n,before);
 for(const table of ['syncs','sync_runs','background_runs'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 assert.equal(result.proposals[0].location.path,path.join(dir,'work'));
 assert.equal(result.proposals[0].location.kind,'folder');
 assert.ok(!JSON.stringify(result).includes(path.join(dir,'sessions')));
});
test('enrichment uses verified proposals and rejects uncited source revocation during inference',async()=>{
 const {discoveryFromProposal,proposeFactoryEnrichment}=require('../dist/factory/enrichment');
 const {id}=await seed(),discovery=discoveryFromProposal((await readFactory(undefined,signal())).proposals[0]);
 const policy={id:'test',revision:'v1',locationKey:discovery.locationKey,discoveryRevision:discovery.revision,endpoint:'Tested patch',inputCheck:'input',prepare:'prepare',completionCheck:'complete',allowedCapabilities:[],allowedEffects:[],maxAttempts:1,timeoutMs:1000};
 let calls=0;const incomplete=await proposeFactoryEnrichment(id,policy,[],async()=>{calls++;return '{"bindings":[]}';},signal());assert.equal(incomplete.ready,false);assert.equal(calls,1);
 await assert.rejects(proposeFactoryEnrichment(id,policy,[],async()=>{db.prepare("UPDATE agent_entries SET active=0 WHERE session_id='episode-0' AND entry_id='4'").run();return '{"bindings":[]}';},signal()));
 const count=db.prepare('SELECT COUNT(*) n FROM process_extractions').get().n;await readFactory(undefined,signal());assert.equal(db.prepare('SELECT COUNT(*) n FROM process_extractions').get().n,count);
});
test('real enrichment entry point enforces its existing model-call owner allowance',async()=>{
 const {discoveryFromProposal,enrichFactoryWithModel}=require('../dist/factory/enrichment');const {id}=await seed(),d=discoveryFromProposal((await readFactory(undefined,signal())).proposals[0]);
 const policy={id:'test',revision:'v1',locationKey:d.locationKey,discoveryRevision:d.revision,endpoint:'Tested patch',inputCheck:'input',prepare:'prepare',completionCheck:'complete',allowedCapabilities:[],allowedEffects:[],maxAttempts:1,timeoutMs:1000};
 const runId=Number(db.prepare("INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,input_key,invocations) VALUES ('fake','fake',1,0,?,'enrichment',1)").run(new Date().toISOString()).lastInsertRowid);
 await assert.rejects(enrichFactoryWithModel(id,policy,[],{table:'background_runs',runId,models:{summary:'fake',final:'fake',max_invocations:500}},signal()),/Invocation budget/);
 db.prepare("UPDATE background_runs SET status='completed' WHERE id=?").run(runId);
 await assert.rejects(enrichFactoryWithModel(id,policy,[],{table:'background_runs',runId,models:{summary:'fake',final:'fake',max_invocations:1}},signal()),/not running/);
 assert.equal(db.prepare('SELECT invocations FROM background_runs WHERE id=?').get(runId).invocations,1);
});
test('old saved comparisons cannot expose a workflow spanning different folders',async()=>{
 const a=path.join(dir,'one'),b=path.join(dir,'two');fs.mkdirSync(a);fs.mkdirSync(b);await seed([a,b]);
 const result=await readFactory(undefined,signal());assert.equal(result.proposals.length,0);assert.equal(result.unavailable,1);
});
test('changing a recorded folder into a repository withholds its old proposal',async()=>{
 await seed();require('node:child_process').execFileSync('git',['init','-q',path.join(dir,'work')]);
 const result=await readFactory(undefined,signal());assert.equal(result.proposals.length,0);assert.equal(result.unavailable,1);
});
test('revoking an uncited original withholds the complete proposal',async()=>{
 await seed();db.prepare("UPDATE agent_entries SET active=0 WHERE session_id='episode-0' AND entry_id='4'").run();
 const result=await readFactory(undefined,signal());assert.equal(result.proposals.length,0);assert.equal(result.unavailable,1);
});
for(const column of ['input_key','recipe_version','model'])test(`Factory rejects changed comparison ${column}`,async()=>{
 const {id}=await seed();db.prepare(`UPDATE process_extractions SET ${column}='changed' WHERE id=?`).run(id);
 const result=await readFactory(undefined,signal());assert.equal(result.proposals.length,0);assert.equal(result.unavailable,1);
});
test('Factory checks the saved comparison input, not just the current validity of its parents',async()=>{
 const {id}=await seed(),row=db.prepare('SELECT source_dependencies_json FROM process_extractions WHERE id=?').get(id),deps=JSON.parse(row.source_dependencies_json);
 deps.parents.reverse();deps.identities.reverse();db.prepare('UPDATE process_extractions SET source_dependencies_json=? WHERE id=?').run(JSON.stringify(deps),id);
 const result=await readFactory(undefined,signal());assert.equal(result.proposals.length,0);assert.equal(result.unavailable,1);
});
test('session exclusion withholds derived workflow content',async()=>{
 await seed();db.prepare("UPDATE agent_sessions SET included=0 WHERE id='episode-1'").run();assert.equal((await readFactory(undefined,signal())).proposals.length,0);
});
test('changed original bytes withhold the proposal',async()=>{
 await seed();const file=path.join(dir,'sessions','episode-0.jsonl');const text=fs.readFileSync(file,'utf8');fs.writeFileSync(file,text.replace('Uncited dependency','Altered dependency'));
 const result=await readFactory(undefined,signal());assert.equal(result.proposals.length,0);assert.equal(result.unavailable,1);
});
test('Factory does not follow legacy external experiment database paths',async()=>{
 const {id}=await seed();db.prepare('UPDATE process_extractions SET source_dependencies_json=? WHERE id=?').run(JSON.stringify({sources:[{kind:'historical',store:'/external.sqlite'}]}),id);
 assert.equal((await readFactory(undefined,signal())).proposals.length,0);
});
test('changed parent output is rejected even when references remain valid',async()=>{
 const {parents}=await seed();const r=db.prepare('SELECT output_json FROM process_extractions WHERE id=?').get(parents[0].extraction),v=JSON.parse(r.output_json);v.fragments[0].goal='Different job';db.prepare('UPDATE process_extractions SET output_json=? WHERE id=?').run(JSON.stringify(v),parents[0].extraction);assert.equal((await readFactory(undefined,signal())).proposals.length,0);
});
test('shared subprocedures are not promoted by a saved identity flag',async()=>{
 const {id}=await seed();const row=db.prepare('SELECT output_json FROM process_extractions WHERE id=?').get(id),v=JSON.parse(row.output_json);v.assessment.relation='shared_subprocedure';v.sameWorkflow=true;db.prepare('UPDATE process_extractions SET output_json=? WHERE id=?').run(JSON.stringify(v),id);
 const result=await readFactory(undefined,signal());assert.equal(result.proposals.length,0);assert.equal(result.unavailable,0);
});
test('Factory rejects invalid cursors and cancellation without returning content',async()=>{
 for(const cursor of [0,-1,NaN,1.5])await assert.rejects(readFactory(cursor,signal()),/cursor/);
 const c=new AbortController();c.abort();await assert.rejects(readFactory(undefined,c.signal));
});
test('execution reads saved progress without invoking a model and withholds it after source exclusion',async()=>{
 const {id}=await seed();const {readDiscovery}=require('../dist/factory/enrichment');const {readExecution,startExecution}=require('../dist/factory/execution');
 const discovery=await readDiscovery(id,signal());Object.assign(process.env,{DRAKEN_FACTORY_PROPOSAL_ID:id,DRAKEN_DOCKER_BIN:'/not-invoked',DRAKEN_DOCKER_HOST:'unix:///test.sock',DRAKEN_FACTORY_IMAGE:'sha256:'+'a'.repeat(64)});
 const requestId='12345678-1234-4234-8234-123456789abc',run=path.join(dir,'factory-runs',requestId);fs.mkdirSync(path.join(run,'work'),{recursive:true});
 fs.writeFileSync(path.join(run,'request.json'),JSON.stringify({id:requestId,version:'0.10.0',proposalId:id,revision:discovery.revision,regenerate:false,createdAt:new Date().toISOString()}));
 fs.writeFileSync(path.join(run,'work','result.json'),JSON.stringify({status:'completed',detail:'Verified fixture',modelCalls:0}));
 fs.writeFileSync(path.join(run,'work','events.jsonl'),'{"type":"requested","capability":"registry"}\n{"type":"result","capability":"registry","outcome":{"ok":true}}\n');
 const state=await readExecution(signal());assert.equal(state.runs[0].status,'completed');assert.equal(state.runs[0].steps[0].status,'passed');
 assert.equal((await startExecution({requestId,version:'0.10.0',regenerate:false},'test-token',signal())).id,requestId);
 await assert.rejects(startExecution({requestId,version:'0.11.0',regenerate:false},'test-token',signal()),/already used/);
 for(const table of ['sync_runs','background_runs'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 db.prepare("UPDATE agent_sessions SET included=0 WHERE id='episode-1'").run();await assert.rejects(readExecution(signal()));
});
test('agent workspace results and logs require fresh workflow source access, including uncited dependencies',async()=>{
 require('node:child_process').execFileSync('git',['init','-q',path.join(dir,'work')]);const {id}=await seed();const {readDiscovery}=require('../dist/factory/enrichment');const {readWorkspaces,workspaceLog,startWorkspace}=require('../dist/factory/workspace');const discovery=await readDiscovery(id,signal());
 Object.assign(process.env,{DRAKEN_WORKSPACE_REPO:path.join(dir,'work'),DRAKEN_WORKSPACE_ALLOWED_IMAGES:'["approved"]',DRAKEN_DOCKER_BIN:'/not-called',DRAKEN_DOCKER_HOST:'unix:///not-called',DRAKEN_FACTORY_PI_SDK:__filename,DRAKEN_FACTORY_AGENT_MODEL:'fixture/test'});
 const requestId='12345678-1234-4234-8234-123456789abc',run=path.join(dir,'factory-workspaces',requestId);fs.mkdirSync(path.join(run,'work'),{recursive:true});
 fs.writeFileSync(path.join(run,'request.json'),JSON.stringify({id:requestId,ref:'HEAD',propose:false,workflowId:id,revision:discovery.revision,task:'Repair the parser',location:discovery.locationKey,createdAt:new Date().toISOString()}));
 fs.writeFileSync(path.join(run,'work/result.json'),JSON.stringify({status:'completed',modelCalls:2,sessionId:'fixture'}));fs.writeFileSync(path.join(run,'work/events.jsonl'),JSON.stringify({type:'stage-result',name:'Test',code:0,stdout:'Verified fixture output'})+'\n');
 assert.equal((await readWorkspaces()).runs[0].workflowId,id);assert.match((await workspaceLog(requestId)).text,/fixture output/);
 assert.equal((await startWorkspace({requestId,ref:'HEAD',workflowId:id,task:'Repair the parser'},'fixture-token')).id,requestId);
 db.prepare("UPDATE agent_entries SET active=0 WHERE session_id='episode-0' AND entry_id='4'").run();assert.deepEqual((await readWorkspaces()).runs,[]);await assert.rejects(workspaceLog(requestId),/source changed|unavailable/);
 for(const table of ['sync_runs','background_runs'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
});
test('execution refuses invalid input, unauthenticated starts and unknown cancellations',async()=>{
 const {startExecution,cancelExecution}=require('../dist/factory/execution');
 await assert.rejects(startExecution({requestId:'../../escape',version:'0.10.0',regenerate:true},'token',signal()),/request ID/);
 await assert.rejects(cancelExecution('../../escape'),/Invalid run ID/);
 await assert.rejects(cancelExecution('12345678-1234-4234-8234-123456789abc'),/no longer active/);
 assert.equal(fs.existsSync(path.join(dir,'factory-runs')),false);
});
test('Factory API uses existing authentication, same-origin and no-store policy; GET starts no work',async()=>{
 server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/api/factory`;
 const response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual((await response.json()).proposals,[]);
 assert.equal((await fetch(url+'?before=invalid')).status,400);
 assert.equal((await fetch(url,{headers:{Origin:'https://other.example'}})).status,403);
 assert.equal((await fetch(url+'/execution')).status,200);
 assert.equal((await fetch(url+'/execution/runs',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'})).status,403);
 process.env.DRAKEN_NO_AUTH='false';assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url+'/execution')).status,401);
 assert.equal((await fetch(url+'/execution/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM background_runs').get().n,0);
});
