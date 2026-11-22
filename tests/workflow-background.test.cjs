require('./fixtures/fake-memory.cjs');
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {getDb,closeDb}=require('../dist/db/schema');
const {scanSessions}=require('../dist/sync/collector');
const store=require('../dist/sync/store');
const {generateReply}=require('../dist/sync/manager');
const {warmSummaryCache,prepareWorkflowEnrichment}=require('../dist/sync/summary-preparation');
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
function history(count=2,locations=[]){
 fs.mkdirSync(root+'/work',{recursive:true});
 const records=[...examples()[0].left.records,{ref:'X',role:'toolResult',text:'Uncited context'}];
 for(let s=0;s<count;s++){
  const session='job-'+s,rows=[{type:'session',version:3,id:session,cwd:locations[s]||root+'/work',timestamp:'2026-01-01T00:00:00.000Z'}];
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
 assert.equal(run.invocations,calls().length);assert.ok(calls().every(c=>c.model===(c.task==='enrich_workflow'?'openai/gpt-6-astra':'openai/gpt-6-luna')));assert.equal(calls().filter(c=>c.task==='enrich_workflow').length,1);
 const chunks=calls().filter(c=>c.task==='summarize'&&c.stage==='chunk');assert.equal(chunks.length,2);
 assert.ok(chunks.every(c=>c.system.includes('process property alongside observations')));
 assert.equal(db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE kind='summary' AND status='completed'").get().n,2);
 assert.equal(calls().filter(c=>c.task==='reconstruct_task').length,2);
 assert.ok(JSON.parse(run.metrics_json).filter(m=>m.task==='reconstruct_task').every(m=>m.accounting.complete));
 assert.equal(calls().filter(c=>c.task==='select_workflow_candidates').length,1);assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,1);
 assert.equal(pendingWorkflows(),false);noSync();
 const count=calls().length;const page=await factory();assert.equal(page.learning,'enabled');assert.equal(page.proposals.length,1);assert.equal(page.proposals[0].decision.sameWorkflow,true);assert.equal(page.proposals[0].enrichment.status,'ready');assert.equal(calls().length,count);
 for(const row of db.prepare("SELECT source_dependencies_json FROM process_extractions WHERE kind='summary'").all()){assert.ok(row.source_dependencies_json.includes('source_pointer'));assert.doesNotMatch(row.source_dependencies_json,/"text":/);}
 await warm();assert.equal(calls().length,count,'unchanged ticks do not repeat paid work');
});
test('explicit enrichment retries retain failed paid output and do not reset the background learning error',async()=>{
 history();await scanSessions();await warm();const db=getDb(),id=(await factory()).proposals[0].id;db.prepare('DELETE FROM workflow_enrichments').run();
 db.prepare("INSERT OR REPLACE INTO sync_settings VALUES ('auto_summary_error','Existing learning failure')").run();controls({invalidEnrichment:true});
 const requestId='12345678-1234-4234-8234-123456789abc',before=calls().length;
 await assert.rejects(prepareWorkflowEnrichment(id,{requestId,retry:false},controller.signal),/enrichment/);assert.equal(calls().length,before+1);
 const row=db.prepare('SELECT * FROM workflow_enrichments').get();assert.equal(row.status,'failed');assert.ok(row.raw_output);assert.equal(db.prepare('SELECT invocations FROM background_runs WHERE id=?').get(row.run_id).invocations,1);
 await assert.rejects(prepareWorkflowEnrichment(id,{requestId,retry:false},controller.signal),/not ready/);assert.equal(calls().length,before+1);
 controls({});await prepareWorkflowEnrichment(id,{requestId:'22345678-1234-4234-8234-123456789abc',retry:true},controller.signal);assert.equal(calls().length,before+2);
 assert.equal((await factory()).proposals[0].enrichment.status,'ready');assert.equal(db.prepare("SELECT value FROM sync_settings WHERE key='auto_summary_error'").get().value,'Existing learning failure');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_enrichments').get().n,2);const count=calls().length;await factory();await warm();assert.equal(calls().length,count);
});
test('task reconstruction shares the existing allowance and cannot automatically retry a paid failure',async()=>{
 history();await scanSessions();process.env.DRAKEN_PI_MAX_INVOCATIONS='3';await warm();const db=getDb(),run=db.prepare('SELECT * FROM background_runs').get();
 assert.equal(run.status,'failed');assert.equal(run.invocations,3);assert.equal(calls().filter(c=>c.task==='reconstruct_task').length,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM episode_reconstructions WHERE status='completed'").get().n,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM episode_reconstructions WHERE status='failed'").get().n,1);
 const count=calls().length;await warm();assert.equal(calls().length,count);assert.equal((await factory()).proposals.length,0);
});
test('cancelling reconstruction retains the owner and remaining allowance on resume',async()=>{
 history(1);await scanSessions();controls({taskDelays:{reconstruct_task:1000}});const done=warm();await waitFor(()=>calls().some(c=>c.task==='reconstruct_task'));controller.abort();await done;
 const db=getDb(),before=db.prepare('SELECT * FROM background_runs').get();assert.equal(before.status,'cancelled');assert.equal(db.prepare('SELECT status FROM episode_reconstructions').get().status,'cancelled');
 controller=new AbortController();controls({});await warm();const after=db.prepare('SELECT * FROM background_runs').get();assert.equal(after.id,before.id);assert.equal(after.max_invocations,before.max_invocations);assert.equal(after.invocations,before.invocations+1);assert.equal(after.status,'completed');
});
test('enrichment uses the remaining shared preparation allowance, not a new budget',async()=>{
 history();await scanSessions();process.env.DRAKEN_PI_MAX_INVOCATIONS='6';await warm();const db=getDb(),run=db.prepare('SELECT * FROM background_runs').get();assert.equal(run.invocations,6);assert.equal(calls().filter(c=>c.task==='enrich_workflow').length,0);assert.equal((await factory()).proposals[0].enrichment.status,'failed');assert.equal(run.status,'failed');
});
test('uncited source revocation during enrichment prevents publication and retains the attempt',async()=>{
 history();await scanSessions();controls({taskDelays:{enrich_workflow:500}});const done=warm();await waitFor(()=>calls().some(c=>c.task==='enrich_workflow'));
 const db=getDb(),entries=db.prepare("SELECT entry_id FROM agent_entries WHERE session_id='job-0'").all();db.prepare("UPDATE agent_entries SET active=0 WHERE session_id='job-0' AND entry_id=?").run(entries.at(-1).entry_id);await done;
 assert.equal((await factory()).proposals.length,0);assert.equal(db.prepare('SELECT status FROM workflow_enrichments').get().status,'failed');assert.ok(db.prepare('SELECT raw_output FROM workflow_enrichments').get().raw_output);
});
test('different repositories never reach candidate selection or workflow matching',async()=>{
 const {execFileSync}=require('node:child_process');const a=root+'/a',b=root+'/b';
 for(const p of [a,b])execFileSync('git',['init','-q',p]);history(2,[a,b]);await scanSessions();await warm();
 assert.equal(calls().filter(c=>['select_workflow_candidates','compare_workflow_identity'].includes(c.task)).length,0);
 assert.equal((await factory()).proposals.length,0);
});
test('different non-Git folders never reach candidate selection',async()=>{
 const a=root+'/a',b=root+'/b';for(const p of [a,b])fs.mkdirSync(p);history(2,[a,b]);await scanSessions();await warm();
 assert.equal(calls().filter(c=>c.task==='select_workflow_candidates').length,0);assert.equal((await factory()).proposals.length,0);
});
test('subdirectories of the same repository can produce a proposal',async()=>{
 require('node:child_process').execFileSync('git',['init','-q',root+'/repo']);const a=root+'/repo/a',b=root+'/repo/b';
 for(const p of [a,b])fs.mkdirSync(p);history(2,[a,b]);await scanSessions();await warm();
 const page=await factory();assert.equal(page.proposals.length,1);assert.equal(page.proposals[0].location.path,root+'/repo');assert.equal(page.proposals[0].location.kind,'repository');
});
test('other folders cannot crowd same-folder candidates out of the 24-record selection',async()=>{
 const a=root+'/a',b=root+'/b';for(const p of [a,b])fs.mkdirSync(p);
 history(2,[a,b]);await scanSessions();await warm();const db=getDb();
 const original=db.prepare("SELECT id,output_json FROM process_extractions WHERE kind='summary' AND json_extract(source_dependencies_json,'$.input.workspace')=?").get(b);
 const fragment=JSON.parse(original.output_json).fragments[0];
 for(let i=0;i<25;i++){
  const id='other-folder-'+i;
  db.prepare(`INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,output_json,usage_json,created_at,completed_at)
    SELECT ?,kind,input_key,recipe_version,model,status,source_dependencies_json,output_json,usage_json,created_at,completed_at FROM process_extractions WHERE id=?`).run(id,original.id);
  db.prepare("INSERT INTO work_episodes(id,state,description_json,learning_status) VALUES (?,'partial',?,'completed')").run(id,JSON.stringify(fragment));
  db.prepare('INSERT INTO episode_extractions(episode_id,extraction_id,fragment_key) VALUES (?,?,?)').run(id,id,fragment.key);
 }
 history(3,[a,b,a]);await scanSessions();await warm();
 const page=await factory();assert.equal(page.proposals.length,1);assert.equal(page.proposals[0].location.path,a);
 assert.equal(calls().filter(c=>c.task==='select_workflow_candidates').length,1);
});
test('repository changes during extraction do not relabel the resulting process record',async()=>{
 history(1);await scanSessions();controls({taskDelays:{summarize:400}});
 const done=warm();await waitFor(()=>calls().some(c=>c.task==='summarize'));
 require('node:child_process').execFileSync('git',['init','-q',root+'/work']);await done;
 const db=getDb();assert.equal(db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE kind='summary' AND status='completed'").get().n,0);
 assert.match(JSON.parse(db.prepare("SELECT output_json FROM process_extractions WHERE status='failed'").get().output_json).failure.message,/Repository or folder changed/);
});
test('repository changes during selection stop matching',async()=>{
 history();await scanSessions();controls({taskDelays:{select_workflow_candidates:400}});
 const done=warm();await waitFor(()=>calls().some(c=>c.task==='select_workflow_candidates'));
 require('node:child_process').execFileSync('git',['init','-q',root+'/work']);await done;
 assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,0);assert.equal((await factory()).proposals.length,0);
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
const nonMatch={relation:'different',workflow:null,stagePairs:[],reason:'Different supported methods',limitations:[]};
for(const invalid of ['not JSON',{relation:'same_workflow_candidate',workflow:{purpose:'Parser fix',method:['Repair parser'],appliesWhen:'Parser defects'},stagePairs:[{left:'S999',right:'S1'}],reason:'Invalid stage ID',limitations:[]}])test(`invalid comparison gets one accounted correction and preparation finishes (${typeof invalid})`,async()=>{
 history();await scanSessions();controls({workflowAssessment:invalid,workflowRepairAssessment:nonMatch});await warm();
 const db=getDb(),matches=calls().filter(c=>c.task==='compare_workflow_identity');assert.equal(matches.length,2);assert.ok(matches[1].repair);
 const row=db.prepare("SELECT * FROM process_extractions WHERE json_extract(source_dependencies_json,'$.phase')='match'").get(),output=JSON.parse(row.output_json);
 assert.equal(row.status,'completed');assert.equal(output.sameWorkflow,false);assert.equal(output.validationRepairs.length,1);assert.ok(output.validationRepairs[0].raw);assert.ok(output.validationRepairs[0].error);
 const run=db.prepare('SELECT * FROM background_runs').get();assert.equal(run.status,'completed');assert.equal(run.invocations,calls().length);
 assert.ok(JSON.parse(run.metrics_json).some(m=>m.task==='compare_workflow_identity'&&m.repair&&m.accounting.complete));
 const count=calls().length;await warm();assert.equal(calls().length,count,'successful correction is cached');noSync();
});
test('a corrected matching response remains readable and gets normal saved enrichment',async()=>{
 history();await scanSessions();controls({workflowAssessment:'not JSON',workflowRepairAssessment:{relation:'same_workflow_candidate',workflow:{purpose:'Repair parser defects',method:['Reproduce the parser defect','Correct parsing and verify compatibility'],appliesWhen:'A parser regression needs a compatible fix'},stagePairs:[{left:'S1',right:'S1'},{left:'S2',right:'S2'}],reason:'Same supported parser method',limitations:[]}});
 await warm();const page=await factory();assert.equal(page.proposals.length,1);assert.equal(page.proposals[0].enrichment.status,'ready');assert.equal(getDb().prepare('SELECT status FROM background_runs').get().status,'completed');
});
test('a comparison without main stages can correct an unsupported match without inventing stage pairs',async()=>{
 history();await scanSessions();const process=fixture();process.fragments[0].stages.forEach(s=>{s.role='unknown';s.condition=null;});
 fs.writeFileSync(controlFile,JSON.stringify({workflowProcess:process,workflowAssessment:{relation:'same_workflow_candidate',workflow:{purpose:'Parser work',method:['Repair parsing'],appliesWhen:'Parser changes'},stagePairs:[],reason:'Unsupported identity',limitations:[]},workflowRepairAssessment:{...nonMatch,relation:'insufficient',reason:'No supplied main stages support identity'}}));
 await warm();assert.equal(getDb().prepare('SELECT status FROM background_runs').get().status,'completed');assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,2);assert.equal((await factory()).proposals.length,0);
});
test('two invalid comparison responses retain the exact error and outputs, then stop without a retry loop',async()=>{
 history();await scanSessions();controls({workflowAssessment:'not JSON'});await warm();
 const db=getDb(),row=db.prepare("SELECT * FROM process_extractions WHERE json_extract(source_dependencies_json,'$.phase')='match'").get(),output=JSON.parse(row.output_json);
 assert.equal(row.status,'failed');assert.equal(output.failure.stage,'validation');assert.match(output.failure.message,/JSON|Unexpected/);assert.equal(output.raw_output,'not JSON');assert.equal(output.validationRepairs[0].raw,'not JSON');
 assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,2);const count=calls().length;await warm();assert.equal(calls().length,count);
});
test('comparison correction cannot obtain a new invocation allowance',async()=>{
 history();await scanSessions();process.env.DRAKEN_PI_MAX_INVOCATIONS='6';controls({workflowAssessment:'not JSON',workflowRepairAssessment:nonMatch});await warm();
 const db=getDb(),run=db.prepare('SELECT * FROM background_runs').get();assert.equal(run.status,'failed');assert.equal(run.invocations,6);assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,1);
 const output=JSON.parse(db.prepare("SELECT output_json FROM process_extractions WHERE json_extract(source_dependencies_json,'$.phase')='match'").get().output_json);assert.match(output.failure.message,/Invocation budget/);assert.equal(output.validationRepairs.length,1);
});
for(const stop of ['revoke','cancel'])test(`${stop} after an invalid comparison prevents a correction call`,async()=>{
 history();await scanSessions();controls({workflowAssessment:'not JSON',workflowRepairAssessment:nonMatch,taskDelays:{compare_workflow_identity:400}});
 const done=warm();await waitFor(()=>calls().some(c=>c.task==='compare_workflow_identity'));
 if(stop==='revoke')getDb().prepare("UPDATE agent_sessions SET included=0 WHERE id='job-0'").run();else controller.abort();
 await done;assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,1);assert.equal((await factory()).proposals.length,0);
});
test('comparison provider failures are retained but are not retried as formatting corrections',async()=>{
 history();await scanSessions();controls({failStage:'workflow_match'});await warm();
 assert.equal(calls().filter(c=>c.task==='compare_workflow_identity').length,1);
 const row=getDb().prepare("SELECT output_json FROM process_extractions WHERE json_extract(source_dependencies_json,'$.phase')='match'").get();assert.equal(JSON.parse(row.output_json).failure.stage,'provider');assert.ok(JSON.parse(row.output_json).failure.message);
});
test('failed process extraction does not replace or break the ordinary summary and is visible on Factory',async()=>{
 history(1);await scanSessions();controls({invalidProcess:true});await warm();
 const db=getDb();assert.equal(db.prepare('SELECT status FROM background_runs').get().status,'completed');assert.ok(db.prepare('SELECT COUNT(*) n FROM summary_cache').get().n>0);
 assert.equal((await factory()).failedExtractions,1);assert.equal((await factory()).proposals.length,0);
 const count=calls().length;await warm();assert.equal(calls().length,count);
});
test('process validation uses the existing repair attempt without replacing the valid ordinary summary',async()=>{
 history(1);await scanSessions();controls({repairableProcess:true});await warm();
 const db=getDb();assert.equal(calls().filter(c=>c.task==='summarize').length,2);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE status='completed'").get().n,1);
 assert.ok(db.prepare('SELECT output_json FROM summary_cache').all().every(r=>!r.output_json.includes('Changed by process repair')));
});
test('process repair cannot spend the last invocation or discard a valid ordinary summary',async()=>{
 history(1);await scanSessions();process.env.DRAKEN_PI_MAX_INVOCATIONS='1';controls({invalidProcess:true});await warm();
 const db=getDb();assert.equal(calls().length,1);assert.equal(db.prepare('SELECT status FROM background_runs').get().status,'completed');
 assert.ok(db.prepare('SELECT COUNT(*) n FROM summary_cache').get().n>0);assert.equal((await factory()).failedExtractions,1);
});
test('a failed process-repair provider call does not discard a valid ordinary summary',async()=>{
 history(1);await scanSessions();controls({repairableProcess:true,failRepair:true});await warm();
 const db=getDb();assert.equal(calls().length,2);assert.equal(db.prepare('SELECT status FROM background_runs').get().status,'completed');
 assert.ok(db.prepare('SELECT COUNT(*) n FROM summary_cache').get().n>0);assert.equal((await factory()).failedExtractions,1);
});
test('explicit cached preparation retains the failed validation attempt before correction',async()=>{
 history(1);await scanSessions();controls({invalidProcess:true});await warm();const db=getDb();
 const keys=db.prepare('SELECT key FROM summary_leaf_inputs').all().map(r=>r.key),before=db.prepare('SELECT * FROM summary_cache ORDER BY key').all();
 controls({repairableCachedProcess:true});await warmSummaryCache(controller.signal,undefined,keys);
 assert.equal(calls().filter(c=>c.task==='prepare_workflow_process').length,2);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE status='failed'").get().n,2);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE kind='summary' AND status='completed'").get().n,1);
 assert.deepEqual(db.prepare('SELECT * FROM summary_cache ORDER BY key').all(),before);
});
test('explicit preparation of selected cached leaves preserves summaries and failed attempts',async()=>{
 history();await scanSessions();controls({invalidProcess:true});await warm();
 const db=getDb(),before=db.prepare('SELECT * FROM summary_cache ORDER BY key').all();
 const failed=db.prepare("SELECT output_json FROM process_extractions WHERE status='failed'").all();
 assert.equal(failed.length,2);assert.ok(failed.every(r=>JSON.parse(r.output_json).failure.message==='Invalid process object fields'));
 const keys=db.prepare('SELECT key FROM summary_leaf_inputs ORDER BY key').all().map(r=>r.key);
 controls({});await warmSummaryCache(controller.signal,undefined,keys);
 assert.deepEqual(db.prepare('SELECT * FROM summary_cache ORDER BY key').all(),before);
 assert.equal((await factory()).proposals.length,1);assert.equal((await factory()).failedExtractions,2);
 const count=calls().length;await warmSummaryCache(controller.signal,undefined,keys);assert.equal(calls().length,count);
});
test('explicit cached preparation respects opt-out and current source permissions',async()=>{
 history(1);await scanSessions();controls({invalidProcess:true});await warm();const db=getDb();
 const keys=db.prepare('SELECT key FROM summary_leaf_inputs').all().map(r=>r.key),count=calls().length;
 setAutoSummary(false);await warmSummaryCache(controller.signal,undefined,keys);assert.equal(calls().length,count);
 setAutoSummary(true);db.prepare("UPDATE agent_sessions SET included=0 WHERE id='job-0'").run();
 await warmSummaryCache(controller.signal,undefined,keys);assert.equal(calls().length,count);
 await assert.rejects(warmSummaryCache(controller.signal,undefined,Array(7).fill(keys[0])),/one to six/);
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
 const task=deps.parents[2],receipt=db.prepare('SELECT r.source_dependencies_json FROM episode_revisions v JOIN episode_reconstructions r ON r.id=v.reconstruction_id WHERE v.episode_id=? AND v.revision=?').get(task.episode,task.revision);
 const parent=db.prepare('SELECT source_dependencies_json FROM process_extractions WHERE id=?').get(JSON.parse(receipt.source_dependencies_json).parents[0].extraction),input=JSON.parse(parent.source_dependencies_json).input;
 db.prepare('UPDATE agent_entries SET active=0 WHERE session_id=? AND entry_id=?').run(input.session,input.evidence[3].entry_id);
 const after=await factory();assert.equal(after.proposals.length,0);assert.equal(after.unavailable,2);
});
test('cancelled matching retains accounting and resumes with cached summaries and candidate selection',async()=>{
 history();await scanSessions();controls({taskDelays:{compare_workflow_identity:1000}});
 const done=warm();await waitFor(()=>calls().some(c=>c.task==='compare_workflow_identity'));controller.abort();await done;
 const db=getDb(),before=db.prepare('SELECT * FROM background_runs').get();assert.equal(before.status,'cancelled');assert.equal((await factory()).proposals.length,0);
 const summaries=calls().filter(c=>c.task==='summarize').length,selections=calls().filter(c=>c.task==='select_workflow_candidates').length;
 controller=new AbortController();controls({});await warm();
 assert.equal(db.prepare('SELECT COUNT(*) n FROM background_runs').get().n,1);assert.equal(db.prepare('SELECT invocations FROM background_runs').get().invocations,before.invocations+2);
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
 assert.equal(JSON.parse(db.prepare("SELECT output_json FROM process_extractions WHERE status='failed'").get().output_json).failure.stage,'source_verification');
});
test('failed matching is not automatically retried; explicit preparation retry retains earlier receipts',async()=>{
 history();await scanSessions();controls({failStage:'workflow_match'});await warm();
 const db=getDb();assert.equal(db.prepare('SELECT status FROM background_runs').get().status,'failed');const count=calls().length;await warm();assert.equal(calls().length,count);
 controls({});setAutoSummary(true);await warm();assert.equal((await factory()).proposals.length,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM process_extractions WHERE status='failed'").get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM background_runs').get().n,2);
});
