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
 Object.assign(process.env,{DRAKEN_DATA_DIR:dir,DRAKEN_PI_SESSIONS_DIR:path.join(dir,'sessions'),DRAKEN_NO_AUTH:'true',DRAKEN_HOST:'127.0.0.1',DRAKEN_PI_BIN:'/no-provider',DRAKEN_USERNAME:'test',DRAKEN_PASSWORD:'test-password',DRAKEN_JWT_SECRET:'factory-test-secret'});db=getDb();
});
afterEach(async()=>{if(server){await new Promise(r=>server.close(r));server=undefined;}closeDb();for(const k of Object.keys(process.env))if(!(k in prior))delete process.env[k];Object.assign(process.env,prior);fs.rmSync(dir,{recursive:true,force:true});});
async function seed(){
 const c=examples()[0],parents=[];
 for(const [i,side] of [c.left,c.right].entries()){
  const session='episode-'+i,records=[...side.records,{ref:'X',role:'toolResult',text:'Uncited dependency'}];
  const pointers=records.map(r=>frozenEvidence(db,path.join(dir,'sessions'),r.text,{ref:r.ref,session,role:r.role,timestamp:'2020-01-02T00:00:00.000Z'}));
  const refs={U:'S1',I:'S2',O:'S3'};
  function remap(v,key){if(Array.isArray(v))return v.map(x=>typeof x==='string'&&['refs','triggerRefs','outcomeRefs'].includes(key)?refs[x]:remap(x,key));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,remap(x,k)]));return v;}
  saveSummaryProcess('parent-'+i,'fake/model',{table:'sync_runs',id:1},JSON.stringify({session,workspace:'/demo',evidence:pointers,background:[]}),{summary:'Saved process',fragments:[remap(side.fragment,'')],limitations:[]},pointers.map(p=>p.source_key),records.map(r=>r.role));
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
 assert.ok(!JSON.stringify(result).includes(dir));
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
test('Factory API uses existing authentication, same-origin and no-store policy; GET starts no work',async()=>{
 server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/api/factory`;
 const response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual((await response.json()).proposals,[]);
 assert.equal((await fetch(url+'?before=invalid')).status,400);
 assert.equal((await fetch(url,{headers:{Origin:'https://other.example'}})).status,403);
 process.env.DRAKEN_NO_AUTH='false';assert.equal((await fetch(url)).status,401);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM background_runs').get().n,0);
});
