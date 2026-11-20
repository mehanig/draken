#!/usr/bin/env node
// Repository snapshots and Docker control only. Repository setup/check commands never run on the host.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {validate,pinned,fingerprint,prompt}=require('./factory-workspace/environment.cjs');
const {DockerExecutor,dockerIsolation}=require('../dist/factory/docker');
function processCall(binary,args,{input,signal,env=process.env,limit=128_000_000,timeout=120000,onLine,group=false}={}){
 return new Promise((resolve,reject)=>{
  signal?.throwIfAborted();const child=spawn(binary,args,{env,stdio:['pipe','pipe','pipe'],shell:false,detached:group});let chunks=[],bytes=0,stderr='',pending='',failure,killTimer;
  const stop=()=>{failure=Error('Operation cancelled or timed out');if(group){try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);}else child.kill('SIGKILL');};const timer=setTimeout(stop,timeout);
  signal?.addEventListener('abort',stop,{once:true});
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>limit){failure=Error('Output exceeds the configured size limit');child.kill('SIGKILL');return;}if(onLine){pending+=chunk;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);try{onLine(line);}catch(error){failure=error;child.kill('SIGKILL');}}}else chunks.push(chunk);});
  child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-8000));child.stdin.on('error',()=>{});child.stdin.end(input);
  const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',stop);};
  child.on('error',error=>{cleanup();reject(error);});child.on('close',code=>{cleanup();if(failure||code!==0)reject(failure||Error(`${path.basename(binary)} failed (${code}): ${stderr}`));else resolve(Buffer.concat(chunks));});
 });
}
async function snapshot(repo,ref,signal){
 if(typeof ref!=='string'||!ref||ref.startsWith('-')||ref.length>200)throw Error('Invalid commit reference');
 const env={PATH:process.env.PATH,HOME:process.env.HOME,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_ATTR_NOSYSTEM:'1'};
 const git=(args,input)=>processCall('git',['--no-pager','--no-replace-objects','--no-optional-locks','-C',repo,...args],{env,input,signal});
 const commit=(await git(['rev-parse','--verify',ref+'^{commit}'])).toString().trim();if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))throw Error('Invalid resolved commit');
 const objectFormat=(await git(['rev-parse','--show-object-format'])).toString().trim();if(!['sha1','sha256'].includes(objectFormat))throw Error('Unsupported Git object format');
 const entries=(await git(['ls-tree','-rz','--full-tree',commit])).toString().split('\0').filter(Boolean).map(line=>{const tab=line.indexOf('\t');return {mode:line.slice(0,6),file:line.slice(tab+1)};});
 if(entries.some(e=>e.mode==='160000'))throw Error('Submodules require an explicit snapshot policy; refusing an incomplete checkout');
 if(entries.some(e=>/(^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]+)?|\.npmrc|id_rsa|id_ed25519|credentials(?:\.json)?|[^/]+\.(?:pem|key))$/.test(e.file)))throw Error('Potential credential file is tracked; review it before granting workspace access');
 const files={};for(const entry of entries){
  if(entry.file.endsWith('.gitattributes')){const text=(await git(['show',commit+':'+entry.file])).toString();if(/filter\s*=\s*lfs/.test(text))throw Error('Git LFS requires an explicit snapshot policy; refusing pointer-only source');}
  if(['.draken/environment.json','package.json','client/package.json','.nvmrc','.node-version','pyproject.toml','Cargo.toml','go.mod'].includes(entry.file)||/^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.file)){
   if(entry.mode!=='100644'&&entry.mode!=='100755')throw Error('Environment inputs must be regular committed files');
   const content=(await git(['show',commit+':'+entry.file])).toString();if(content.length>80000)throw Error('Environment input exceeds 80 KB');files[entry.file]=content;
  }
 }
 if(JSON.stringify(files).length>200000)throw Error('Environment context exceeds 200 KB');
 const objects=await git(['rev-list','--objects','--no-object-names',commit+'^{tree}']);
 const pack=await git(['pack-objects','--stdout','--threads=1'],Buffer.concat([Buffer.from(commit+'\n'),objects]));
 return {commit,objectFormat,files,pack,fileCount:entries.length};
}
async function main(){
 const [repoArg,ref,outputArg]=process.argv.slice(2),repo=path.resolve(repoArg||'.'),output=path.resolve(outputArg||'.');
 const binary=process.env.DRAKEN_DOCKER_BIN,host=process.env.DRAKEN_DOCKER_HOST;
 const approved=JSON.parse(process.env.DRAKEN_WORKSPACE_ALLOWED_IMAGES||'[]');
 if(!repoArg||!ref||!outputArg||!binary||!host||!Array.isArray(approved)||!approved.length||approved.length>16||approved.some(image=>!pinned(image)))throw Error('Usage: factory-workspace.cjs REPOSITORY COMMIT NEW_OUTPUT_DIRECTORY; configure Docker and DRAKEN_WORKSPACE_ALLOWED_IMAGES');
 fs.mkdirSync(output,{mode:0o700});const controller=new AbortController();const abort=()=>controller.abort();process.once('SIGTERM',abort);process.once('SIGINT',abort);
 const save=(name,value)=>{const temporary=path.join(output,'.'+crypto.randomUUID());fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});fs.linkSync(temporary,path.join(output,name));fs.unlinkSync(temporary);};
 const record=value=>{const fd=fs.openSync(path.join(output,'events.jsonl'),'a',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(value.type==='stage-started'||value.type==='stage-result')console.log(value.type,value.name,value.code??'');};
 const docker=(args,options={})=>processCall(binary,['--host',host,...args],{...options,env:{PATH:process.env.PATH,HOME:process.env.HOME,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR}});
 const prefix='draken-workspace-'+crypto.randomUUID(),container=prefix+'-worker',proxy=prefix+'-broker',network=prefix+'-network',volume=prefix+'-files';
 const resources=[];let outcome,modelCalls=0;
 try{
  const source=await snapshot(repo,ref,controller.signal);save('source.json',{repo,commit:source.commit,objectFormat:source.objectFormat,fileCount:source.fileCount,packSHA256:crypto.createHash('sha256').update(source.pack).digest('hex'),uncommittedIncluded:false,historyIncluded:false});fs.writeFileSync(path.join(output,'source.pack'),source.pack,{mode:0o600,flag:'wx'});
  // Check the engine and locally available approved bases before any paid proposal.
  for(const image of approved){const info=JSON.parse((await docker(['image','inspect',image],{signal:controller.signal})).toString())[0];await new DockerExecutor({binary,host,image:info.Id,stages:{},record:async()=>{}}).check(controller.signal);}
  let environment;
  if(source.files['.draken/environment.json'])environment=validate(JSON.parse(source.files['.draken/environment.json']),approved);
  else{
   if(!process.env.DRAKEN_PI_BIN)throw Error('Missing environment declaration and no explicit model runtime configured');
   const payload={task:'propose_factory_environment',commit:source.commit,files:source.files,approvedImages:approved};save('model-request.json',{payload,system:prompt});
   const env={};for(const key of ['PATH','HOME','LANG','PI_CODING_AGENT_DIR','DRAKEN_PI_BIN','DRAKEN_PI_SUMMARY_MODEL','DRAKEN_PI_FINAL_MODEL'])if(process.env[key])env[key]=process.env[key];env.DRAKEN_DATA_DIR=path.join(output,'model-accounting');
   modelCalls=null;
   const response=JSON.parse((await processCall(process.execPath,[path.join(__dirname,'factory-enrichment-model.cjs')],{input:JSON.stringify({payload,system:prompt}),env,signal:controller.signal,timeout:240000,limit:2_000_000,group:true})).toString());
   save('model-response.json',response);modelCalls=response.receipt.invocations;environment=validate(JSON.parse(response.raw),approved);
  }
  save('environment.json',environment);
  const worker=fs.readFileSync(path.join(__dirname,'factory-workspace/worker.cjs')),broker=fs.readFileSync(path.join(__dirname,'factory-container/proxy.cjs'));
  const key=fingerprint({environment,commit:source.commit,worker:crypto.createHash('sha256').update(worker).digest('hex'),broker:crypto.createHash('sha256').update(broker).digest('hex'),platform:process.arch});
  const context=path.join(output,'image');fs.mkdirSync(context,{mode:0o700});fs.writeFileSync(path.join(context,'worker.cjs'),worker);fs.writeFileSync(path.join(context,'proxy.cjs'),broker);
  fs.writeFileSync(path.join(context,'Dockerfile'),`FROM ${environment.image}\nUSER root\nRUN mkdir -p /factory /workspace && chown 65532:65532 /workspace\nCOPY worker.cjs proxy.cjs /factory/\nLABEL draken.environment=${key}\nUSER 65532:65532\nWORKDIR /workspace\nCMD ["node", "/factory/worker.cjs"]\n`);
  const image=(await docker(['build','--network=none','--quiet','-t','draken-workspace:'+key,context],{signal:controller.signal,timeout:180000})).toString().trim().split('\n').at(-1);
  if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Build did not return a pinned image ID');
  save('image.json',{id:image,base:environment.image,recipe:key});
  resources.push(['network',network]);await docker(['network','create','--internal','--label','draken.factory.run='+prefix,network]);
  resources.push(['container',proxy]);await docker(['create',...dockerIsolation(proxy,'bridge',prefix),'--env','ALLOWED_HOSTS=registry.npmjs.org',image,'node','/factory/proxy.cjs']);
  await docker(['network','connect','--alias','egress',network,proxy]);await docker(['start',proxy]);
  let ready=false;for(let i=0;i<30;i++){controller.signal.throwIfAborted();if((await docker(['logs',proxy])).toString().includes('proxy-ready')){ready=true;break;}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('Network broker did not start');
  resources.push(['volume',volume]);await docker(['volume','create','--label','draken.factory.run='+prefix,volume]);
  resources.push(['container',container]);await docker(['create','-i',...dockerIsolation(container,network,prefix,true),'--env','npm_config_registry=http://egress:8080/npm/','--mount',`type=volume,src=${volume},dst=/workspace`,image]);
  save('container.json',JSON.parse((await docker(['inspect',container])).toString())[0]);
  await docker(['start','--attach','--interactive',container],{signal:controller.signal,timeout:900000,limit:64_000_000,input:JSON.stringify({commit:source.commit,objectFormat:source.objectFormat,pack:source.pack.toString('base64'),environment}),onLine:line=>{
   const event=JSON.parse(line);if(event.type==='patch'){fs.writeFileSync(path.join(output,'changes.patch'),event.patch,{mode:0o600,flag:'wx'});record({type:'patch-saved',base:event.base,bytes:Buffer.byteLength(event.patch)});}else record(event);if(event.type==='result')outcome=event;
  }});
  const state=JSON.parse((await docker(['inspect','--format','{{json .State}}',container])).toString());if(state.ExitCode!==0||state.OOMKilled||!outcome)throw Error('Workspace exited without a confirmed result');
  outcome={...outcome,image,modelCalls,output};
 }catch(error){outcome={status:controller.signal.aborted?'cancelled':'failed',detail:error.message,modelCalls,output};save('failure.json',outcome);}
 finally{
  const errors=[];for(const [kind,name] of resources.reverse())try{await docker(kind==='container'?['rm','--force',name]:[kind,'rm',name]);}catch(error){if(!/No such|not found/.test(error.message))errors.push(error.message);}
  if(errors.length){outcome={...outcome,status:'interrupted',detail:'Workspace cleanup needs attention',cleanupErrors:errors};}
  save('result.json',outcome);process.removeListener('SIGTERM',abort);process.removeListener('SIGINT',abort);
 }
 console.log(JSON.stringify(outcome,null,2));if(outcome.status!=='completed')process.exitCode=1;
}
module.exports={snapshot};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
