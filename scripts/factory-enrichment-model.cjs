// Tool-free model worker. Run only with a private test data directory and a sanitized pi environment.
// Uses the same durable modelCall accounting as application preparation, not an unaccounted provider client.
const fs=require('node:fs'),path=require('node:path');
const {getDb,closeDb}=require('../dist/db/schema');
const {modelCall}=require('../dist/sync/model-call');
const {defaultModels}=require('../dist/sync/models');
const controller=new AbortController();process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{text+=part;if(text.length>500000)process.exit(2);});
process.stdin.on('end',async()=>{
 let db,run;
 try{
  const {payload,system}=JSON.parse(text);if(!process.env.DRAKEN_DATA_DIR||!process.env.DRAKEN_PI_BIN)throw Error('Private accounting directory and explicit provider runtime required; no runtime fallback');
  // No rerun of a paid attempt in this directory, even after cancellation or malformed output.
  fs.mkdirSync(process.env.DRAKEN_DATA_DIR,{recursive:true,mode:0o700});fs.writeFileSync(path.join(process.env.DRAKEN_DATA_DIR,'enrichment-claim'),'',{flag:'wx',mode:0o600});
  db=getDb();const models={...defaultModels(),max_invocations:1};
  run=Number(db.prepare(`INSERT INTO background_runs(summary_model,final_model,max_invocations,total_entries,started_at,input_key) VALUES (?,?,1,0,?,?)`).run(models.summary,models.final,new Date().toISOString(),'explicit-factory-enrichment').lastInsertRowid);
  const raw=await modelCall({...payload,stage:'factory_enrichment'},system,{models,runId:run,table:'background_runs',signal:controller.signal});
  db.prepare("UPDATE background_runs SET status='completed',stage=?,completed_at=? WHERE id=?").run('Factory enrichment',new Date().toISOString(),run);
  const receipt=db.prepare('SELECT id,summary_model,invocations,max_invocations,metrics_json FROM background_runs WHERE id=?').get(run);
  process.stdout.write(JSON.stringify({raw,receipt:{...receipt,metrics:JSON.parse(receipt.metrics_json),metrics_json:undefined}}));
 }catch(error){if(db&&run)db.prepare("UPDATE background_runs SET status=?,error=?,completed_at=? WHERE id=?").run(controller.signal.aborted?'cancelled':'failed',String(error.message).slice(0,1000),new Date().toISOString(),run);console.error(error.message);process.exitCode=1;}
 finally{closeDb();}
});
