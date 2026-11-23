require('./fixtures/fake-memory.cjs');
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {getDb,closeDb}=require('../dist/db/schema');
const {preparationFailure,savedPreparationError}=require('../dist/sync/preparation-status');
const {summaryPreparationSettings}=require('../dist/sync/summary-preparation');
const {readFactory}=require('../dist/factory/service');
const legacy='Background summaries could not finish. Check provider settings, invocation limits and original session files, then explicitly retry automatic preparation in Settings. Cached work is retained.';
let root;
beforeEach(()=>{closeDb();root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-preparation-status-'));process.env.DRAKEN_DATA_DIR=root;getDb();});
afterEach(()=>{closeDb();fs.rmSync(root,{recursive:true,force:true});});
function run(error=legacy,task='compare_workflow_identity',calls=9,requestStatus='completed'){
 return Number(getDb().prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,status,error,invocations,metrics_json,input_key)
 VALUES ('fixture/summary','fixture/final',120,64,?,'failed',?,?,?,'fixture-input')`).run(new Date().toISOString(),error,calls,JSON.stringify([{task,status:requestStatus}])).lastInsertRowid);
}
function failure(id,message='Pair must cite supplied main stages',stage='validation'){
 getDb().prepare(`INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,output_json,usage_json,created_at,completed_at)
 VALUES (?,'comparison','input','recipe','fixture/model','failed','{}',?,?,?,?)`).run('failure-'+id,JSON.stringify({failure:{stage,message}}),JSON.stringify({backgroundRun:id}),new Date().toISOString(),new Date().toISOString());
}
function save(error){getDb().prepare("INSERT OR REPLACE INTO sync_settings(key,value) VALUES ('auto_summary_error',?)").run(error);}

test('legacy comparison failure is explained from its own saved attempt, not later consolidation; reads do not open history or write',async()=>{
 const id=run();failure(id);save(legacy);run('Unrelated consolidation failure','reconstruct_task',33);
 const db=getDb(),before=db.prepare('SELECT total_changes() n').get().n,original=fs.readFileSync;
 fs.readFileSync=()=>{throw Error('Status must not reopen historical files');};
 try{
  const text=savedPreparationError();assert.match(text,/Workflow comparison stopped/);assert.match(text,/model compared steps outside/);assert.match(text,new RegExp(`Attempt #${id} used 9 of 120`));
  assert.doesNotMatch(text,/summaries could not finish|Check provider|limit.*reached/);
  assert.equal(summaryPreparationSettings().error,text);assert.equal((await readFactory(undefined,new AbortController().signal)).learningError,text);
  assert.equal(db.prepare('SELECT total_changes() n').get().n,before);assert.equal(db.prepare("SELECT value FROM sync_settings WHERE key='auto_summary_error'").get().value,legacy);
 }finally{fs.readFileSync=original;}
});
test('reaching the last allowed call does not turn an invalid response into a quota failure',()=>{
 const id=run('new','compare_workflow_identity',120);failure(id);
 const result=preparationFailure(id,'compare_workflow_identity',Error('Pair must cite supplied main stages'));
 assert.match(result.reason,/model compared steps/);assert.doesNotMatch(result.reason,/limit/);assert.match(result.message,/120 of 120/);
});
test('call-limit, input-size, source and runtime failures have different explanations',()=>{
 const id=run();
 for(const [task,error,expected] of [
  ['reconstruct_task','Invocation budget reached. Completed summaries are cached.',/model-call limit/],
  ['select_workflow_candidates','Summary request exceeds its token safety budget; cached work is intact.',/input exceeded.*request was not sent/],
  ['sources','Original session evidence is unavailable or changed. Restore the session files.',/original history.*unavailable or changed/],
  ['summarize','Private pi is unavailable. Run draken setup.',/model runtime is unavailable/],
  ['reconstruct_task','Task reconstruction split an existing task; review is required',/grouping needs review/],
 ])assert.match(preparationFailure(id,task,Error(error)).reason,expected);
});
test('unknown causes are admitted rather than guessed or exposing private exception text',()=>{
 const result=preparationFailure(undefined,'planning',Error('PRIVATE_SOURCE_SENTINEL /private-workspace secret-token'));
 assert.match(result.reason,/cause could not be identified/);assert.doesNotMatch(result.message,/PRIVATE_SOURCE|private-workspace|secret-token|provider settings/);
 save(legacy);assert.match(savedPreparationError(),/cause could not be identified/);
});
test('failed provider request is not reported as a local indexing or workflow validation failure',()=>{
 const id=run('new','summarize',1,'failed'),result=preparationFailure(id,'summarize',Error('PRIVATE_PROVIDER_ERROR'));
 assert.match(result.message,/Summarization stopped/);assert.match(result.reason,/model request did not complete/);assert.doesNotMatch(result.message,/PRIVATE_PROVIDER|indexing|invalid response/);
});
test('a previous failed receipt cannot replace a different current error',()=>{
 const id=run();failure(id);const result=preparationFailure(id,'finalization',Error('Unknown finalization failure'));
 assert.equal(result.operation,'Completing preparation');assert.match(result.reason,/cause could not be identified/);assert.doesNotMatch(result.message,/model compared steps/);
});
