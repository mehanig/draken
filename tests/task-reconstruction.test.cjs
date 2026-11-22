const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {getDb,closeDb}=require('../dist/db/schema');
const {initProcessSchema}=require('../dist/db/process-schema');
const {frozenEvidence}=require('./fixtures/source-entry.cjs');
const {readWorkflowOriginals}=require('../dist/evidence-adapter');
const {saveSummaryProcess,pendingWorkflows}=require('../dist/factory/learning-store');
const {reconstructPendingTasks,readLearningParent,readLearningParents,independentTasks}=require('../dist/factory/episode-store');
const {learnSummaryWorkflows}=require('../dist/factory/learning');
const {readFactory}=require('../dist/factory/service');
const {reconstructTask}=require('../dist/workflow-learning');
let root,db,prior,controller,calls;
beforeEach(()=>{closeDb();prior={...process.env};root=fs.mkdtempSync(path.join(os.tmpdir(),'task-reconstruction-'));fs.mkdirSync(root+'/repo');Object.assign(process.env,{DRAKEN_DATA_DIR:root+'/state',DRAKEN_PI_SESSIONS_DIR:root+'/sessions'});db=getDb();controller=new AbortController();calls=[];});
afterEach(()=>{controller.abort();closeDb();for(const k of Object.keys(process.env))if(!(k in prior))delete process.env[k];Object.assign(process.env,prior);fs.rmSync(root,{recursive:true,force:true});});
async function fragment(label,{session='one',goal='Release 1.2.3',text='Continue the release of 1.2.3.',cwd=root+'/repo',uncited=false,pointer}={}){
 const primary=pointer||frozenEvidence(db,root+'/sessions',text,{session,cwd,role:'user'}),background=Array.from({length:typeof uncited==='number'?uncited:Number(uncited)},()=>frozenEvidence(db,root+'/sessions','Uncited context.',{session,cwd,role:'assistant'}));
 const records=await readWorkflowOriginals([primary,...background],controller.signal);
 const process={summary:goal,fragments:[{key:label,goal,context:'The requested release',state:'partial',refs:['S1'],coverage:{triggerRefs:[],outcomeRefs:[],gaps:['Partial task history']},
  stages:[{key:'work',action:text,normalizedAction:'Perform release work',role:'main',condition:null,claims:[{description:text,basis:'requested',refs:['S1']}],refs:['S1'],tools:[],skills:[]}],dependencies:[],decisions:[],exceptions:[],questions:[],matching:{goal:'Publish a release',context:'A release is requested'}}],limitations:['Historical fragment']};
 assert.equal(saveSummaryProcess(label,'fixture/model',{table:'background_runs',id:1},JSON.stringify({session,workspace:cwd,evidence:[primary],background}),process,records.map(r=>r.ref),records.map(r=>r.role)),true);
 return {primary,background};
}
function decision(input,choose=()=>true){const members=input.fragments.filter(f=>choose(f,input.fragments[0]));return{status:'task',members:members.map(f=>f.id),reason:'Fixture task-instance judgment',coverage:{triggerRefs:[],outcomeRefs:[],gaps:['Partial task history']}};}
const ask=async(input)=>{calls.push(input);if(input.task==='reconstruct_task')return JSON.stringify(decision(input));if(input.task==='select_workflow_candidates')return JSON.stringify({selected:input.candidates.slice(0,1).map(c=>c.id)});return JSON.stringify({relation:'same_workflow_candidate',workflow:{purpose:'Publish a release',method:['Perform release work'],appliesWhen:'A release is requested'},stagePairs:[{left:input.left.stages[0].id,right:input.right.stages[0].id}],reason:'Same procedure, separate task instances',limitations:[]});};
const reconstruct=(callback=ask,run=1)=>reconstructPendingTasks(run,'fixture/model',callback,controller.signal);
const tasks=()=>db.prepare("SELECT id episode,revision FROM work_episodes WHERE assembly='reconciled' AND superseded_by IS NULL ORDER BY rowid").all();

test('three disjoint chunks of one task assemble once and cannot form three recurrent workflow pairs',async()=>{
 await fragment('request',{text:'Release 1.2.3.'});await fragment('implementation');await fragment('verification',{text:'Continue by verifying the published 1.2.3.'});
 await learnSummaryWorkflows(1,'fixture/model',ask,controller.signal);
 assert.equal(tasks().length,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM episode_memberships').get().n,3);
 assert.deepEqual(calls.map(c=>c.task),['reconstruct_task']);assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_discoveries').get().n,0);assert.equal(pendingWorkflows(),false);
 const saved=await readLearningParent(tasks()[0],controller.signal);assert.equal(saved.input.stages.length,3);assert.equal(saved.input.complete,false);assert.equal(new Set(saved.input.stages.map(s=>s.id)).size,3);
 await learnSummaryWorkflows(1,'fixture/model',ask,controller.signal);assert.equal(calls.length,1);
});
test('different task IDs without a recorded distinction cannot establish recurrence',async()=>{
 await fragment('first',{session:'a',goal:'Release 1.2.3'});await reconstruct();const first=tasks()[0];
 db.prepare("UPDATE agent_sessions SET included=0 WHERE id='a'").run();await fragment('second',{session:'b',goal:'Release 1.2.4'});await reconstruct(ask,2);
 db.prepare("UPDATE agent_sessions SET included=1 WHERE id='a'").run();const second=tasks()[1];assert.equal(independentTasks(first,second),false);
 const before=calls.length;await learnSummaryWorkflows(3,'fixture/model',ask,controller.signal);assert.equal(calls.length,before);assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_discoveries').get().n,0);
 await fragment('continuation',{session:'b',goal:'Release 1.2.4'});
 const separate=async input=>input.task==='reconstruct_task'?(calls.push(input),JSON.stringify(decision(input,(f,current)=>f.process.goal===current.process.goal))):ask(input);
 await learnSummaryWorkflows(4,'fixture/model',separate,controller.signal);assert.equal(independentTasks(tasks()[0],tasks()[1]),true);assert.equal((await readFactory(undefined,controller.signal)).proposals.length,1);
});
test('a task continuing across sessions is still one task',async()=>{
 await fragment('start',{session:'first',text:'Release 1.2.3.'});await fragment('continuation',{session:'second',text:'Continue the 1.2.3 release from the other session.'});await reconstruct();
 assert.equal(tasks().length,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM episode_memberships').get().n,2);assert.equal(calls.length,1);
});
test('different release instances in one session remain separate despite identical generic methods',async()=>{
 await fragment('first',{goal:'Release 1.2.3',text:'Release 1.2.3.'});await fragment('second',{goal:'Release 1.2.4',text:'Now release 1.2.4.'});
 const separate=async input=>input.task==='reconstruct_task'?(calls.push(input),JSON.stringify(decision(input,(f,first)=>f.process.goal===first.process.goal))):ask(input);
 await learnSummaryWorkflows(1,'fixture/model',separate,controller.signal);
 assert.equal(tasks().length,2);assert.equal(calls.filter(c=>c.task==='compare_workflow_identity').length,1);
 assert.equal((await readFactory(undefined,controller.signal)).proposals.length,1);
 assert.equal(independentTasks(...tasks()),true);
});
test('one initiating record can describe independently requested task instances',async()=>{
 const pointer=frozenEvidence(db,root+'/sessions','Two independent release tasks: publish 1.2.3, and separately publish 2.0.0.',{session:'one',cwd:root+'/repo',role:'user'});
 await fragment('one',{pointer,goal:'Publish 1.2.3',text:'Publish 1.2.3.'});await fragment('two',{pointer,goal:'Publish 2.0.0',text:'Publish 2.0.0.'});
 const separate=async input=>input.task==='reconstruct_task'?(calls.push(input),JSON.stringify(decision(input,(f,current)=>f.process.goal===current.process.goal))):ask(input);
 await learnSummaryWorkflows(1,'fixture/model',separate,controller.signal);assert.equal(tasks().length,2);assert.equal((await readFactory(undefined,controller.signal)).proposals.length,1);
});
test('assembled task matching retains distinct stage and fact identifiers across chunks',async()=>{
 for(const goal of ['Release 1.2.3','Release 1.2.4'])for(const part of ['start','finish'])await fragment(goal+'-'+part,{goal,text:part+' '+goal});
 const separate=async input=>input.task==='reconstruct_task'?(calls.push(input),JSON.stringify(decision(input,(f,current)=>f.process.goal===current.process.goal))):ask(input);
 await learnSummaryWorkflows(1,'fixture/model',separate,controller.signal);assert.equal(tasks().length,2);
 const comparison=calls.find(c=>c.task==='compare_workflow_identity');for(const input of [comparison.left,comparison.right]){assert.equal(input.stages.length,2);assert.equal(new Set(input.stages.map(s=>s.id)).size,2);assert.ok(input.facts.every(f=>!f.stage||input.stages.some(s=>s.id===f.stage)));}
 assert.equal((await readFactory(undefined,controller.signal)).proposals.length,1);
});
test('separately requested work on the same artifact is not forced into one task',async()=>{
 await fragment('release',{goal:'Publish 1.2.3',text:'Publish 1.2.3.'});await fragment('audit',{goal:'Independently audit published 1.2.3',text:'The release is finished. Now independently audit its security; do not publish another release.'});
 await reconstruct(async input=>JSON.stringify(decision(input,(f,current)=>f.process.key===current.process.key)));assert.equal(tasks().length,2);assert.equal(independentTasks(...tasks()),true);
});
test('appended task fragments revise the same task and leave earlier source-backed revisions readable',async()=>{
 await fragment('first');await fragment('second');await reconstruct();const old=tasks()[0],before=await readLearningParent(old,controller.signal);
 await fragment('third');await reconstruct(ask,2);const current=tasks()[0];assert.equal(current.episode,old.episode);assert.equal(current.revision,2);
 assert.deepEqual(await readLearningParent(old,controller.signal),before);assert.equal((await readLearningParent(current,controller.signal)).input.stages.length,3);assert.equal(independentTasks(old,current),false);
});
test('assembly preserves the model-supported historical order rather than putting the new fragment first',async()=>{
 await fragment('first',{text:'Start release 1.2.3.'});await reconstruct();await fragment('last',{text:'Finish release 1.2.3.'});
 await reconstruct(async input=>JSON.stringify({...decision(input),members:input.fragments.map(f=>f.id).reverse()}),2);
 const input=(await readLearningParent(tasks()[0],controller.signal)).input;
 assert.deepEqual(input.facts.filter(f=>f.stage).map(f=>f.description),['Start release 1.2.3.','Finish release 1.2.3.']);
});
test('uncertain continuity is retained, not counted as a task or retried without new evidence',async()=>{
 await fragment('unclear');const uncertain=async input=>{calls.push(input);return JSON.stringify({status:'uncertain',members:[],reason:'Cannot establish task identity',coverage:{triggerRefs:[],outcomeRefs:[],gaps:['Need a task boundary']}});};
 await reconstruct(uncertain);assert.equal(tasks().length,0);assert.equal(pendingWorkflows(),false);await reconstruct(uncertain);assert.equal(calls.length,1);
 await fragment('clarification');await reconstruct(ask,2);assert.equal(tasks().length,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM episode_memberships').get().n,2);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM episode_reconstructions WHERE json_extract(output_json,'$.status')='uncertain'").get().n,1);
});
test('malformed output is retained and cannot automatically replay within the same owner',async()=>{
 await fragment('first');let count=0;await assert.rejects(reconstruct(async()=>{count++;return '{broken';}));
 const failed=db.prepare('SELECT * FROM episode_reconstructions').get();assert.equal(failed.status,'failed');assert.equal(failed.raw_output,'{broken');assert.ok(failed.error);assert.equal(tasks().length,0);
 await assert.rejects(reconstruct(async()=>{count++;return '{}';}),/explicit retry/);assert.equal(count,1);
 await reconstruct(ask,2);assert.equal(tasks().length,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM episode_reconstructions WHERE status='failed'").get().n,1);
});
for(const change of ['uncited','unselected','bytes','location','cancel'])test(`${change} changes during reconstruction prevent admission and retain the paid response`,async()=>{
 const a=await fragment('first',{uncited:true});await fragment('other',{session:'other',goal:'Release 9.9.9'});
 await assert.rejects(reconstruct(async input=>{
  const output=JSON.stringify(decision(input,f=>f.id==='F0'));
  if(change==='uncited')db.prepare('UPDATE agent_entries SET active=0 WHERE entry_id=? AND session_id=?').run(a.background[0].entry_id,a.background[0].session_id);
  if(change==='unselected')db.prepare("UPDATE agent_sessions SET included=0 WHERE id='other'").run();
  if(change==='bytes'){const p=root+'/sessions/one.jsonl';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('Continue','Abandon '));}
  if(change==='location')require('node:child_process').execFileSync('git',['init','-q',root+'/repo']);
  if(change==='cancel')controller.abort();
  return output;
 }));
 assert.equal(tasks().length,0);const row=db.prepare('SELECT * FROM episode_reconstructions').get();assert.equal(row.status,change==='cancel'?'cancelled':'failed');assert.ok(row.raw_output);assert.ok(row.error);
});
test('originals omitted from the model excerpt still require fresh permission checks',async()=>{
 const source=await fragment('first',{uncited:20});
 await assert.rejects(reconstruct(async input=>{assert.equal(input.fragments[0].records.length,12);assert.equal(input.fragments[0].omittedRecords,9);const hidden=source.background.at(-1);db.prepare('UPDATE agent_entries SET active=0 WHERE entry_id=? AND session_id=?').run(hidden.entry_id,hidden.session_id);return JSON.stringify(decision(input));}));
 assert.equal(tasks().length,0);assert.equal(db.prepare('SELECT status FROM episode_reconstructions').get().status,'failed');
});
test('shared reconstruction dependencies are read once per batch, never cached across reads',async()=>{
 const source=await fragment('first',{uncited:true});await fragment('second',{session:'other'});await reconstruct(async input=>JSON.stringify(decision(input,f=>f.id==='F0')));
 const adapter=require('../dist/evidence-adapter'),original=adapter.readWorkflowOriginals;let batches=0,records=0;
 adapter.readWorkflowOriginals=async(pointers,signal)=>{batches++;records+=pointers.length;return original(pointers,signal);};
 try{
  assert.equal((await readLearningParents(tasks(),controller.signal)).length,2);assert.equal(batches,1);assert.equal(records,3);
  await readLearningParents(tasks(),controller.signal);assert.equal(batches,2);assert.equal(records,6);
  db.prepare('UPDATE agent_entries SET active=0 WHERE entry_id=? AND session_id=?').run(source.background[0].entry_id,source.background[0].session_id);
  await assert.rejects(readLearningParents(tasks(),controller.signal));assert.equal(batches,3);
 }finally{adapter.readWorkflowOriginals=original;}
});
test('a task revision binds its saved prompt rather than requiring the newest prompt text',async()=>{
 await fragment('first');await reconstruct();const row=db.prepare('SELECT * FROM episode_reconstructions').get(),deps=JSON.parse(row.source_dependencies_json);
 const {digest}=require('../dist/sync/normalize'),{learningInputKey}=require('../dist/factory/process-store');deps.prompt+='\nEarlier compatible prompt wording.';
 db.prepare('UPDATE episode_reconstructions SET source_dependencies_json=?,recipe_version=?,input_key=? WHERE id=?').run(JSON.stringify(deps),digest(deps.prompt),learningInputKey(deps,calls[0],row.model),row.id);
 await readLearningParent(tasks()[0],controller.signal);
 db.prepare("UPDATE episode_reconstructions SET recipe_version='wrong' WHERE id=?").run(row.id);await assert.rejects(readLearningParent(tasks()[0],controller.signal),/input changed/);
});
test('a completed assembly still checks uncited originals on every read',async()=>{
 const source=await fragment('first',{uncited:true});await reconstruct();const task=tasks()[0];await readLearningParent(task,controller.signal);
 db.prepare('UPDATE agent_entries SET active=0 WHERE entry_id=? AND session_id=?').run(source.background[0].entry_id,source.background[0].session_id);
 await assert.rejects(readLearningParent(task,controller.signal));
});
test('reconstruction does not cross repository or folder identities',async()=>{
 fs.mkdirSync(root+'/other');await fragment('first');await fragment('second',{session:'other',cwd:root+'/other'});await reconstruct();assert.equal(tasks().length,2);assert.ok(calls.every(c=>c.fragments.length===1));
});
test('new continuity evidence can join earlier task identities without deleting their revisions',async()=>{
 await fragment('first',{session:'a'});await fragment('second',{session:'b'});
 await reconstruct(async input=>JSON.stringify(decision(input,f=>f.id==='F0')));const old=tasks();assert.equal(old.length,2);
 await fragment('link',{session:'c',text:'These are continuations of the same 1.2.3 release.'});await reconstruct(ask,2);
 assert.equal(tasks().length,1);assert.equal(tasks()[0].episode,old[0].episode);assert.equal(independentTasks(old[0],old[1]),false);
 await readLearningParent(old[0],controller.signal);await readLearningParent(old[1],controller.signal);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM episode_memberships WHERE episode_id=?').get(tasks()[0].episode).n,3);
});
test('a partial selection cannot silently split an existing reconstructed task',async()=>{
 await fragment('first');await fragment('second');await reconstruct();const before=tasks();await fragment('third');
 await assert.rejects(reconstruct(async input=>JSON.stringify({...decision(input),members:['F0','F1']}),2),/split an existing task/);assert.deepEqual(tasks(),before);
});
test('migration does not replay completed legacy fragments or rewrite old extraction receipts',async()=>{
 await fragment('legacy');db.prepare("UPDATE work_episodes SET learning_status='completed'").run();const before=db.prepare('SELECT * FROM process_extractions').all();initProcessSchema(db);initProcessSchema(db);await reconstruct();
 assert.equal(calls.length,0);assert.deepEqual(db.prepare('SELECT * FROM process_extractions').all(),before);assert.equal(db.pragma('foreign_key_check').length,0);
});
test('consolidation drafts stay hidden; activation preserves originals and old-ID aliases with fresh source checks',async()=>{
 await fragment('one',{goal:'Release 1.2.3'});await fragment('two',{goal:'Release 1.2.4',session:'other'});
 const separate=async input=>input.task==='reconstruct_task'?JSON.stringify(decision(input,(f,current)=>f.process.goal===current.process.goal)):ask(input);
 await learnSummaryWorkflows(1,'fixture/model',separate,controller.signal);
 const {readProposal,discoveryFromProposal}=require('../dist/factory/discovery'),{consolidationBatchId,consolidatedWorkflowId}=require('../dist/factory/consolidation');
 const original=(await readFactory(undefined,controller.signal)).proposals[0],parents=tasks(),loaded=await readLearningParents(parents,controller.signal);
 const source={format:'workflow-consolidation-v1',proposals:[{id:original.id,revision:discoveryFromProposal(original).revision,tasks:parents}],tasks:parents.map((p,i)=>({...p,identity:loaded[i].identity}))};
 const batch={run_id:1,model:'fixture/model',source_json:JSON.stringify(source),request:'Consolidate the current workflows.',created_at:new Date().toISOString(),output_json:JSON.stringify({groups:[{members:[original.id],workflow:original.decision.assessment.workflow,reason:'Same procedure, retaining the original source evidence'}]})};batch.id=consolidationBatchId(batch);
 db.prepare("INSERT INTO workflow_consolidation_batches(id,run_id,model,status,source_json,output_json,request,created_at) VALUES (?,?,?,'running',?,?,?,?)").run(batch.id,1,batch.model,batch.source_json,batch.output_json,batch.request,batch.created_at);
 const parentJson=JSON.stringify(parents),id=consolidatedWorkflowId(batch,0,parentJson);
 db.prepare("INSERT INTO workflow_discoveries(id,origin,model,created_at) VALUES (?,'requested',?,?)").run(id,batch.model,batch.created_at);
 db.prepare('INSERT INTO workflow_consolidations VALUES (?,?,?,?)').run(id,batch.id,0,parentJson);
 assert.deepEqual((await readFactory(undefined,controller.signal)).proposals.map(p=>p.id),[original.id]);
 const draft=await readProposal(id,controller.signal);assert.equal(draft.task.exampleCount,2);assert.deepEqual(draft.aliases,[original.id]);
 db.transaction(()=>{db.prepare("UPDATE workflow_consolidation_batches SET status='completed' WHERE id=?").run(batch.id);db.prepare('INSERT INTO workflow_consolidation_members VALUES (?,?)').run(original.id,id);})();
 assert.deepEqual((await readFactory(undefined,controller.signal)).proposals.map(p=>p.id),[id]);assert.equal(discoveryFromProposal(await readProposal(original.id,controller.signal)).revision,source.proposals[0].revision);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_discoveries').get().n,2);assert.equal(db.pragma('foreign_key_check').length,0);
 db.prepare("UPDATE agent_sessions SET included=0 WHERE id='other'").run();await assert.rejects(readProposal(id,controller.signal));assert.equal((await readFactory(undefined,controller.signal)).proposals.length,0);
});
test('consolidation must cover every workflow exactly once and cannot invent source IDs',()=>{
 const {CONSOLIDATION_PROMPT,consolidatedWorkflows}=require('../dist/workflow-learning');assert.match(CONSOLIDATION_PROMPT,/not execution/);
 const good={groups:[{members:['A','B'],workflow:{purpose:'Publish the requested release',method:['Check, publish and verify the release'],appliesWhen:'A release is requested'},reason:'Same method and endpoint'}]};assert.equal(consolidatedWorkflows(JSON.stringify(good),['A','B']).length,1);
 for(const change of [v=>v.groups[0].members.pop(),v=>v.groups[0].members.push('C'),v=>v.groups.push(v.groups[0]),v=>v.groups[0].workflow.method=[],v=>v.groups[0].extra=true]){const bad=structuredClone(good);change(bad);assert.throws(()=>consolidatedWorkflows(JSON.stringify(bad),['A','B']));}
});
test('public task contract rejects unknown members, duplicate members and boundary refs from unselected fragments',async()=>{
 await fragment('first');await fragment('second',{session:'other'});
 await reconstruct(async input=>{
  const valid=decision(input,f=>f.id==='F0');assert.deepEqual(reconstructTask(JSON.stringify(valid),input.fragments),valid);
  for(const change of [v=>v.members.push('F99'),v=>v.members.push('F0'),v=>v.coverage.triggerRefs=[input.fragments[1].records[0].ref],v=>v.extra=true,v=>{v.status='uncertain';v.members=[];v.coverage.gaps=[];}]){const bad=structuredClone(valid);change(bad);assert.throws(()=>reconstructTask(JSON.stringify(bad),input.fragments));}
  return JSON.stringify(decision(input));
 });
});
