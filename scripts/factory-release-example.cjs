#!/usr/bin/env node
// Real, accounted model enrichment followed exclusively by fresh Docker stages.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {enrich,proposeEnrichment,runWorkflow}=require('../dist/factory-enrichment');
const {discoveryFromProposal}=require('../dist/factory/enrichment');
const {DockerExecutor}=require('../dist/factory/docker');
const {workflowLocation}=require('../dist/factory/location');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function main(){
 const [base,id,version,directory,reuseDirectory]=process.argv.slice(2),token=process.env.DRAKEN_FACTORY_TOKEN;
 const binary=process.env.DRAKEN_DOCKER_BIN,host=process.env.DRAKEN_DOCKER_HOST,image=process.env.DRAKEN_FACTORY_IMAGE;
 if(!base||!id||!/^\d+\.\d+\.\d+$/.test(version||'')||!directory||!token||!binary||!host||!image||!process.env.DRAKEN_PI_BIN)throw Error('Required: BASE_URL PROPOSAL_ID VERSION OUTPUT_DIRECTORY; DRAKEN_FACTORY_TOKEN, explicit DRAKEN_PI_BIN, DRAKEN_DOCKER_BIN, DRAKEN_DOCKER_HOST, DRAKEN_FACTORY_IMAGE');
 const origin=new URL(base);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/')throw Error('Use the authenticated Factory origin');
 const output=path.resolve(directory);fs.mkdirSync(output,{mode:0o700}); // A new private directory, never an existing directory or shared append target.
 const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const save=(name,value)=>{const fd=fs.openSync(path.join(output,name),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 const append=(name,value)=>{const fd=fs.openSync(path.join(output,name),'a',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 async function source(signal){let cursor;for(let i=0;i<50;i++){
  const r=await fetch(new URL('/api/factory'+(cursor?'?before='+cursor:''),origin),{signal,redirect:'error',cache:'no-store',headers:{Authorization:'Bearer '+token}});
  if(!r.ok)throw Error(`Factory read failed: HTTP ${r.status}`);const page=await r.json(),proposal=page.proposals.find(p=>p.id===id);if(proposal)return discoveryFromProposal(proposal);
  if(page.nextCursor===null)break;cursor=page.nextCursor;
 }throw Error('Source proposal is no longer available');}
 const definitions=[
  ['input','check','Validate inputs: package draken, GitHub repository mehanig/draken, stable version; not a step verifier',[],[]],
  ['prepare','action','Prepare a non-root isolated execution environment; not an implementation of historical method steps',[],[]],
  ['registry','action','Read the exact and latest published package metadata from npm',['network-read'],[]],
  ['check-registry','check','Independently verify registry output: requested version is latest, with integrity and provenance',[],['registry']],
  ['install','action','Fresh-install the requested package without dev dependencies or lifecycle scripts; execute its CLI version command',['network-read','container-write'],[]],
  ['check-install','check','Inspect installed manifest, version output, selected production files and integrity against registry output',[],['install']],
  ['audit','action','Run a production-only npm dependency audit using the install artifact; retain the actual audit result',['network-read'],[]],
  ['check-audit','check','Verify the production audit exited successfully with zero findings',[],['audit']],
  ['release','action','Poll the release and deployment GitHub workflows for the release tag commit, then read live website version; stop after at most twenty polls',['network-read'],[]],
  ['check-release','check','Verify publication, successful release/deployment workflows and matching live website version',[],['release']],
  ['complete','check','Independently repeat all four endpoint checks from read-only stage artifacts; not a per-step verifier',[],[]]
 ];
 const stages={input:{dependencies:[],output:false,networkHosts:[]},prepare:{dependencies:[],output:true,networkHosts:[]},
  registry:{dependencies:[],output:true,networkHosts:['registry.npmjs.org']},'check-registry':{dependencies:['registry'],output:false,networkHosts:[]},
  install:{dependencies:['registry'],output:true,networkHosts:['registry.npmjs.org']},'check-install':{dependencies:['registry','install'],output:false,networkHosts:[]},
  audit:{dependencies:['install'],output:true,networkHosts:['registry.npmjs.org']},'check-audit':{dependencies:['audit'],output:false,networkHosts:[]},
  release:{dependencies:[],output:true,networkHosts:['api.github.com','draken.mehanig.com']},'check-release':{dependencies:['release'],output:false,networkHosts:[]},
  complete:{dependencies:['registry','install','audit','release'],output:false,networkHosts:[]}};
 const capabilities=definitions.map(([id,kind,description,effects,forActions])=>({id,kind,description:description+(stages[id].dependencies.length?' Requires earlier artifacts from: '+stages[id].dependencies.join(', ')+'.':''),effects,forActions,repeatable:true,revision:image}));
 const docker=new DockerExecutor({binary,host,image,stages,record:async event=>append('containers.jsonl',event)});
 let modelReceipt;
 try{
  await docker.check(controller.signal); // Missing/inadequate Docker fails before paid inference.
  const discovery=await source(controller.signal);
  const target=workflowLocation(path.resolve(__dirname,'..'));
  if(target.kind!=='repository'||discovery.locationKey!==target.key)throw Error('Selected discovery belongs to a different repository than this Draken checkout');
  const policy={id:'draken-container-release-verification',revision:hash(JSON.stringify({image,stages,capabilities})),locationKey:target.key,discoveryRevision:discovery.revision,
   endpoint:'Verify the published Draken release: registry, package contents and CLI version, production audit, release/deployment workflows and live site',
   inputCheck:'input',prepare:'prepare',completionCheck:'complete',allowedCapabilities:capabilities.map(c=>c.id),allowedEffects:['network-read','container-write'],maxAttempts:1,timeoutMs:600000};
  save('policy.json',policy);const policyText=fs.readFileSync(path.join(output,'policy.json'),'utf8');
  const assertCurrent=async signal=>{if(fs.readFileSync(path.join(output,'policy.json'),'utf8')!==policyText)throw Error('Policy changed');const current=await source(signal);if(current.revision!==discovery.revision||current.locationKey!==policy.locationKey)throw Error('Discovery or repository changed');};
  let plan;
  if(reuseDirectory){
   plan=JSON.parse(fs.readFileSync(path.join(reuseDirectory,'enrichment.json'),'utf8'));
   if(plan.discovery.revision!==discovery.revision||JSON.stringify(plan.policy)!==JSON.stringify(policy))throw Error('Saved enrichment no longer matches the current source and policy');
   await assertCurrent(controller.signal);
   const recorded=JSON.parse(fs.readFileSync(path.join(reuseDirectory,'model-response.json'),'utf8'));
   if(JSON.stringify(enrich(discovery,policy,JSON.parse(recorded.raw),capabilities))!==JSON.stringify(plan))throw Error('Saved enrichment differs from the recorded model output');
   modelReceipt=recorded.receipt;
   save('reused-enrichment.json',{directory:path.resolve(reuseDirectory),revision:hash(JSON.stringify(plan)),modelReceipt});
  }else plan=await proposeEnrichment(discovery,policy,capabilities,{assertCurrent,ask:async(payload,system,signal)=>{
   save('model-request.json',{payload,system});
   // Provider configuration stays on the control plane, never in container environment or task inputs.
   // The explicit worker uses a separate one-call accounting store; it cannot retry the live paused background job.
   const workerEnv={};for(const key of ['PATH','HOME','LANG','LC_ALL','TERM','TMPDIR','PI_CODING_AGENT_DIR','PI_OFFLINE','PI_SKIP_VERSION_CHECK','PI_TELEMETRY','DRAKEN_PI_BIN','DRAKEN_PI_SUMMARY_MODEL','DRAKEN_PI_FINAL_MODEL'])if(process.env[key])workerEnv[key]=process.env[key];
   workerEnv.DRAKEN_DATA_DIR=path.join(output,'model-accounting');
   const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(__dirname,'factory-enrichment-model.cjs')],{env:workerEnv,detached:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',kill;
    const abort=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}kill=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},3000);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    child.stdout.on('data',part=>{stdout+=part;if(stdout.length>2_000_000)abort();});child.stderr.on('data',part=>{stderr=(stderr+part).slice(-4000);});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({payload,system}));
    child.on('error',error=>{signal.removeEventListener('abort',abort);clearTimeout(kill);reject(error);});
    child.on('close',code=>{signal.removeEventListener('abort',abort);clearTimeout(kill);if(code!==0||signal.aborted)reject(Error(`Enrichment model worker failed: ${stderr}`));else{try{resolve(JSON.parse(stdout));}catch(error){reject(error);}}});
   });
   modelReceipt=result.receipt;save('model-response.json',result);return result.raw;
  }},controller.signal);
  save('enrichment.json',plan);if(!plan.ready)throw Error(`Model enrichment is incomplete: ${plan.missing.join('; ')}`);
  const task={id:'verify-draken-'+version.replaceAll('.','-')+'-'+crypto.randomUUID(),locationKey:discovery.locationKey,inputs:{package:'draken',githubRepository:'mehanig/draken',version}};
  const result=await runWorkflow(plan,task,{capabilities,claim:async()=>save('claim.json',{task,workflowRevision:hash(JSON.stringify(plan))}),
   authorize:async(_,__,signal)=>assertCurrent(signal),record:async event=>append('events.jsonl',event),invoke:(id,context,signal)=>docker.invoke(id,context,signal)},controller.signal);
  await docker.dispose(); // Do not report a completed job while its containers are still running.
  const report={...result,task,modelCalls:reuseDirectory?0:modelReceipt.invocations,enrichmentModelCalls:modelReceipt.invocations,model:modelReceipt.summary_model,bindingOrigin:'LLM response; no manual bindings',image,output};save('result.json',report);
  console.log(JSON.stringify(report,null,2));if(result.status!=='completed')process.exitCode=1;
 }catch(error){save('failure.json',{message:error.message,modelReceipt});throw error;}
 finally{try{await docker.dispose();}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}}
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
