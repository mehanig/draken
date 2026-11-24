require('./fixtures/fake-memory.cjs');
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {getDb,closeDb}=require('../dist/db/schema');
const {summaryPreparationSettings}=require('../dist/sync/summary-preparation');
const {readFactory}=require('../dist/factory/service');
const legacy='Background summaries could not finish. Check provider settings, invocation limits and original session files, then explicitly retry automatic preparation in Settings. Cached work is retained.';
let root,priorDataDir;
beforeEach(()=>{closeDb();priorDataDir=process.env.DRAKEN_DATA_DIR;root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-preparation-status-'));process.env.DRAKEN_DATA_DIR=root;getDb();});
afterEach(()=>{closeDb();fs.rmSync(root,{recursive:true,force:true});if(priorDataDir===undefined)delete process.env.DRAKEN_DATA_DIR;else process.env.DRAKEN_DATA_DIR=priorDataDir;});

for(const stage of ['validation','provider','sources'])test(`status counts saved ${stage} failures without pausing, exposing private errors, opening originals or writing`,async()=>{
 const db=getDb(),at=new Date().toISOString();
 const id=Number(db.prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,status,error,invocations,input_key)
   VALUES ('fixture/summary','fixture/final',120,64,?,'failed',?,9,'fixture-input')`).run(at,legacy).lastInsertRowid);
 db.prepare(`INSERT INTO process_extractions(id,kind,input_key,recipe_version,model,status,source_dependencies_json,output_json,usage_json,created_at,completed_at)
   VALUES ('failure','comparison','input','recipe','fixture/model','failed','{"phase":"match"}',?,?,?,?)`).run(JSON.stringify({failure:{stage,message:'PRIVATE_SOURCE_SENTINEL /private-workspace secret-token'}}),JSON.stringify({backgroundRun:id}),at,at);
 db.prepare("INSERT OR REPLACE INTO sync_settings(key,value) VALUES ('auto_summary_error',?)").run(legacy);
 db.prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,status,invocations,input_key)
   VALUES ('fixture/summary','fixture/final',120,25,?,'completed',33,'workflow-consolidation:fixture')`).run(at);
 const before=db.prepare('SELECT total_changes() n').get().n,receipt=db.prepare('SELECT * FROM process_extractions').get(),original=fs.readFileSync;
 fs.readFileSync=()=>{throw Error('Status must not reopen historical files');};
 try{
  const settings=summaryPreparationSettings(),page=await readFactory(undefined,new AbortController().signal);
  assert.equal(settings.error,'');assert.equal(settings.status,'waiting');assert.equal(settings.error_count,1);assert.equal(settings.prepared_entries,0,'consolidation is not summary progress');
  assert.equal(page.learning,'enabled');assert.equal(page.preparationErrors,1);
  assert.doesNotMatch(JSON.stringify({settings,page}),/PRIVATE_SOURCE_SENTINEL|private-workspace|secret-token/);
  assert.deepEqual(db.prepare('SELECT * FROM process_extractions').get(),receipt);
  assert.equal(db.prepare('SELECT total_changes() n').get().n,before);assert.equal(db.prepare("SELECT value FROM sync_settings WHERE key='auto_summary_error'").get().value,legacy);
 }finally{fs.readFileSync=original;}
});
