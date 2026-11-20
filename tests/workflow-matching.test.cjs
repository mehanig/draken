const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Database=require('better-sqlite3');
const {examples}=require('./fixtures/workflow-identity-cases.cjs');
const {examples:legacyExamples}=require('./fixtures/matching-v3-cases.cjs');
const {contractMatchInput,validateContractAssessment,decideContractMatch,validateProcess,validateProcessEvidence}=require('../dist/workflow-learning');
const {loadMatchingCases,evaluateMatchingCase}=require('../dist/workflow-pilot/matching');
const {initProcessSchema}=require('../dist/db/process-schema');
const {getDb,closeDb}=require('../dist/db/schema');
const {sourceEntry}=require('./fixtures/source-entry.cjs');
const {capturePilot}=require('../dist/workflow-pilot/evidence-host');
function assessment(){
 return {relation:'same_workflow_candidate',workflow:{purpose:'Repair a parser defect',method:['Reproduce the defect with a failing regression test','Correct the parser and run the regression and compatibility tests'],appliesWhen:'A parser defect must be fixed without changing the documented format'},stagePairs:[{left:'S1',right:'S1'},{left:'S2',right:'S2'}],reason:'Same purpose and method, different implementation tools',limitations:[]};
}
const inputs=()=>[examples()[0].left,examples()[0].right].map(s=>contractMatchInput(s.fragment));
test('a match needs a concrete workflow description and supporting stage references',()=>{
 const x=inputs(),a=assessment();assert.equal(decideContractMatch(a,x).relation,'same_workflow_candidate');
 for(const mutate of [a=>a.workflow=null,a=>a.workflow.method=[],a=>a.stagePairs=[]]){
  const b=structuredClone(a);mutate(b);assert.throws(()=>decideContractMatch(b,x));
 }
 const generic={...a,relation:'common_practice',workflow:null};assert.equal(decideContractMatch(generic,x).sameWorkflow,false);
});
test('recognition never upgrades a reported or requested result into an observed success',()=>{
 for(const basis of ['reported','requested','unknown']){
  const x=inputs();x[1].facts.find(f=>f.id==='S2.C1').basis=basis;x[1].complete=false;x[1].gaps=['Result not verified'];
  const result=decideContractMatch(assessment(),x);assert.equal(result.sameWorkflow,true);
  assert.equal(result.coverage[1].complete,false);assert.deepEqual(result.coverage[1].gaps,['Result not verified']);
  assert.equal(x[1].facts.find(f=>f.id==='S2.C1').basis,basis);
 }
});
test('incomplete episode coverage is separate from workflow identity',()=>{
 const x=inputs();x[1].complete=false;x[1].gaps=['Initiating message missing'];
 const result=decideContractMatch(assessment(),x);assert.equal(result.relation,'same_workflow_candidate');
 assert.equal(result.coverage[1].complete,false);
 const a=assessment();a.relation='shared_subprocedure';const shared=decideContractMatch(a,x);
 assert.equal(shared.relation,'shared_subprocedure');assert.equal(shared.sameWorkflow,false);
});
test('recovery results can establish entry without making recovery an ordinary shared step',()=>{
 const f=examples()[0].left.fragment;f.stages[0].role='recovery';f.stages[0].condition={description:'An earlier retrieval failed',basis:'observed',refs:['I']};
 const x=[contractMatchInput(f),contractMatchInput(f)],a=assessment();a.stagePairs=[{left:'S2',right:'S2'}];
 assert.ok(!x[0].stages.some(s=>s.id==='S1'));assert.equal(x[0].facts.find(f=>f.id==='S1.C1').role,'recovery');
 assert.equal(decideContractMatch(a,x).sameWorkflow,true);
 a.stagePairs=[{left:'S1',right:'S1'}];
 assert.throws(()=>decideContractMatch(a,x),/main stages/);
});
test('model output cannot invent evidence or override coverage metadata',()=>{
 const x=inputs();
 for(const mutate of [a=>a.sameWorkflow=true,a=>a.coverage=[],a=>a.relation='approved',a=>a.stagePairs[0].left='missing',a=>a.workflow.method=[]]){
  const a=assessment();mutate(a);assert.throws(()=>validateContractAssessment(JSON.stringify(a),x));
 }
});
test('tool/skill changes do not change primary evidence or identity',()=>{
 const [a,b]=inputs();assert.deepEqual({...a,secondary:[]},{...b,secondary:[]});assert.notDeepEqual(a.secondary,b.secondary);
 assert.equal(decideContractMatch(assessment(),[a,b]).sameWorkflow,true);
});
test('controlled fixtures follow the same process contract; expected labels are separate',()=>{
 for(const c of [...examples(),...legacyExamples()])for(const s of [c.left,c.right])validateProcessEvidence(validateProcess(JSON.stringify({summary:'Fixture',fragments:[s.fragment],limitations:['Synthetic']}),s.records.map(r=>r.ref)),s.records);
 assert.equal(examples().length,8);
});
test('complete episode coverage does not turn an observed failed attempt into success',()=>{
 const c=examples()[3],x=[c.left,c.right].map(s=>contractMatchInput(s.fragment));
 assert.equal(x[1].complete,true);assert.match(x[1].facts.find(f=>f.id==='S2.C1').description,/crashed/);
 assert.equal(decideContractMatch(assessment(),x).sameWorkflow,true);
});
test('a request with no known main steps cannot support an invented workflow match',()=>{
 const c=examples()[7],x=[c.left,c.right].map(s=>contractMatchInput(s.fragment));
 assert.equal(x[1].stages.length,0);assert.throws(()=>decideContractMatch(assessment(),x),/main stages/);
});
let dir,store,file,prior;
beforeEach(()=>{
 closeDb();dir=fs.mkdtempSync(path.join(os.tmpdir(),'matching-v3-'));file=path.join(dir,'cases.json');
 prior={DRAKEN_DATA_DIR:process.env.DRAKEN_DATA_DIR,DRAKEN_PI_SESSIONS_DIR:process.env.DRAKEN_PI_SESSIONS_DIR};
 Object.assign(process.env,{DRAKEN_DATA_DIR:dir,DRAKEN_PI_SESSIONS_DIR:path.join(dir,'sessions')});
 store=new Database(path.join(dir,'matching.sqlite'));store.pragma('foreign_keys=ON');initProcessSchema(store);
});
afterEach(()=>{store.close();closeDb();fs.rmSync(dir,{recursive:true,force:true});for(const [k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
function save(cases=[examples()[0]]){fs.writeFileSync(file,JSON.stringify({cases}));return loadMatchingCases(file).hash;}
const signal=()=>new AbortController().signal;
test('evaluation does not send expectations/case names and resumes without inference',async()=>{
 const hash=save();let calls=0;const ask=async(raw,request)=>{
  calls++;const body=JSON.parse(raw);assert.equal(body.expected,undefined);assert.equal(body.name,undefined);
  assert.ok(!raw.includes(examples()[0].name));assert.equal(body.left.facts[0].refs,undefined);
  request.onAccounting({cost_usd:0.01});return JSON.stringify(assessment());
 };
 const first=await evaluateMatchingCase(store,file,hash,0,'fake/model',ask,signal());assert.equal(first.passed,true);
 const second=await evaluateMatchingCase(store,file,hash,0,'fake/model',ask,signal());assert.equal(second.cached,true);assert.equal(calls,1);
 const row=store.prepare('SELECT * FROM process_extractions').get();assert.equal(row.status,'completed');assert.ok(row.usage_json);assert.deepEqual(JSON.parse(row.source_dependencies_json).expected,examples()[0].expected);
});
test('manifest changes during inference are rejected, with spent accounting retained',async()=>{
 const hash=save();await assert.rejects(evaluateMatchingCase(store,file,hash,0,'fake/model',async()=>{save([examples()[1]]);return JSON.stringify(assessment());},signal()),/manifest changed/);
 assert.equal(store.prepare('SELECT status FROM process_extractions').get().status,'failed');
});
test('failed attempts do not retry and cancellation prevents admission',async()=>{
 const hash=save();let calls=0;const controller=new AbortController();
 await assert.rejects(evaluateMatchingCase(store,file,hash,0,'fake/model',async()=>{calls++;controller.abort();return JSON.stringify(assessment());},controller.signal));
 await assert.rejects(evaluateMatchingCase(store,file,hash,0,'fake/model',async()=>{calls++;return '{}';},signal()),/no automatic retry/);
 assert.equal(calls,1);assert.equal(store.prepare('SELECT status FROM process_extractions').get().status,'cancelled');
});
test('only sixteen lifetime attempts across two models; another manifest cannot reset the store',async()=>{
 const base=examples()[0];const cases=Array.from({length:8},(_,i)=>{const c=structuredClone(base);c.name='case-'+i;c.left.fragment.matching.context+=' '+i;return c;});const hash=save(cases);let calls=0;
 for(let i=0;i<8;i++)await evaluateMatchingCase(store,file,hash,i,'fake/model',async()=>{calls++;return JSON.stringify(assessment());},signal());
 for(let i=0;i<8;i++)await evaluateMatchingCase(store,file,hash,i,'another/model',async()=>{calls++;return JSON.stringify(assessment());},signal());
 await assert.rejects(evaluateMatchingCase(store,file,hash,0,'third/model',async()=>{calls++;return JSON.stringify(assessment());},signal()),/sixteen invocations/);
 const changed=save([examples()[1]]);await assert.rejects(evaluateMatchingCase(store,file,changed,0,'fake/model',async()=>{calls++;return '{}';},signal()),/different frozen/);assert.equal(calls,16);
});
test('historical parent permissions and uncited originals are checked after model work',async()=>{
 const db=getDb();for(const [role,text] of [['user','Repair the parser without changing the documented format'],['toolResult','The regression reproduces the parser defect'],['toolResult','The corrected parser passes regression and compatibility tests'],['toolResult','Uncited background fact']])sourceEntry(db,path.join(dir,'sessions'),text,{timestamp:'2026-11-18T00:00:00.000Z',role});
 const capture=capturePilot(db,'session-a',4,'2026-11-19T00:00:00.000Z');const ids=capture.originals.map(o=>o.ref);const mapping={U:ids[0],I:ids[1],O:ids[2]};
 const parent=new Database(path.join(dir,'parent.sqlite'));initProcessSchema(parent);const f=examples()[0].left.fragment;
 function remap(v,key){if(Array.isArray(v))return v.map(x=>typeof x==='string'&&['refs','triggerRefs','outcomeRefs'].includes(key)?mapping[x]:remap(x,key));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,remap(x,k)]));return v;}
 const output={summary:'Parent',fragments:[remap(f,'')],limitations:['Test parent']};
 parent.prepare("INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,output_json,created_at) VALUES ('parent','summary','input','recipe','fake','completed',?,?,?)").run(JSON.stringify({source:db.name,captures:[capture]}),JSON.stringify(output),new Date().toISOString());parent.close();
 const c=examples()[0];c.left={kind:'historical',store:path.join(dir,'parent.sqlite'),extraction:'parent',fragment:'example'};const hash=save([c]);let calls=0;
 await assert.rejects(evaluateMatchingCase(store,file,hash,0,'fake/model',async()=>{calls++;db.prepare('UPDATE agent_entries SET active=0 WHERE id=?').run(capture.originals[3].id);return JSON.stringify(assessment());},signal()),/available/);
 assert.equal(calls,1);assert.equal(store.prepare('SELECT status FROM process_extractions').get().status,'failed');
 db.prepare('UPDATE agent_sessions SET included=0').run();
 await assert.rejects(evaluateMatchingCase(store,file,hash,0,'fake/model',async()=>{calls++;return '{}';},signal()));assert.equal(calls,1);
});
