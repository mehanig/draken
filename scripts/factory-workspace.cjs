#!/usr/bin/env node
// Repository snapshots and Docker control only. Repository setup/check commands never run on the host.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {validate,pinned,fingerprint}=require('./factory-workspace/environment.cjs');
const {assertDockerHost,dockerIsolation}=require('../dist/factory/docker');
const {workflowLocation}=require('../dist/factory/location');
const {runAgent,sdkConfiguration}=require('./factory-workspace/agent.cjs');
const {loadBrief}=require('./factory-workspace/authorization.cjs');
function processCall(binary,args,{input,signal,env=process.env,limit=128_000_000,timeout=120000,onLine,group=false}={}){
 return new Promise((resolve,reject)=>{
  signal?.throwIfAborted();const child=spawn(binary,args,{env,stdio:['pipe','pipe','pipe'],shell:false,detached:group});let chunks=[],bytes=0,stderr='',pending='',failure,killTimer,stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;failure=Error('Operation cancelled or timed out');if(group){try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);}else child.kill('SIGKILL');};const timer=setTimeout(stop,timeout);
  signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>limit){stop();failure=Error('Output exceeds the configured size limit');return;}if(onLine){pending+=chunk;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);try{onLine(line);}catch(error){stop();failure=error;}}}else chunks.push(chunk);});
  child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-8000));child.stdin.on('error',()=>{});child.stdin.end(input);
  const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',stop);};
  child.on('error',error=>{cleanup();reject(error);});child.on('close',code=>{cleanup();if(failure||code!==0)reject(failure||Object.assign(Error(`${path.basename(binary)} failed (${code}): ${stderr}`),{exitCode:code}));else resolve(Buffer.concat(chunks));});
 });
}
async function snapshot(repo,ref,signal){
 if(typeof ref!=='string'||!ref||ref.startsWith('-')||ref.length>200)throw Error('Invalid commit reference');
 const location=workflowLocation(repo);if(location.kind!=='repository')throw Error('Repository location is unavailable');
 if(process.env.DRAKEN_WORKSPACE_LOCATION_KEY&&process.env.DRAKEN_WORKSPACE_LOCATION_KEY!==location.key)throw Error('Approved repository location changed');
 const env={PATH:process.env.PATH,HOME:process.env.HOME,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_ATTR_NOSYSTEM:'1'};
 const git=(args,input)=>processCall('git',['--no-pager','--no-replace-objects','--no-optional-locks','-C',repo,...args],{env,input,signal});
 const commit=(await git(['rev-parse','--verify',ref+'^{commit}'])).toString().trim();if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))throw Error('Invalid resolved commit');
 const objectFormat=(await git(['rev-parse','--show-object-format'])).toString().trim();if(!['sha1','sha256'].includes(objectFormat))throw Error('Unsupported Git object format');
 const entries=(await git(['ls-tree','-rz','--full-tree',commit])).toString().split('\0').filter(Boolean).map(line=>{const tab=line.indexOf('\t');return {mode:line.slice(0,6),file:line.slice(tab+1)};});
 const files={};for(const entry of entries){
  if(entry.file==='.draken/environment.json'){
   if(entry.mode!=='100644'&&entry.mode!=='100755')throw Error('Environment inputs must be regular committed files');
   const content=(await git(['show',commit+':'+entry.file])).toString();if(content.length>80000)throw Error('Environment input exceeds 80 KB');files[entry.file]=content;
  }
 }
 if(JSON.stringify(files).length>200000)throw Error('Environment context exceeds 200 KB');
 const pack=await git(['pack-objects','--stdout','--revs','--threads=1'],Buffer.from(commit+'\n'));
 const shallowFile=path.resolve(repo,(await git(['rev-parse','--git-path','shallow'])).toString().trim());
 const shallow=fs.existsSync(shallowFile)?fs.readFileSync(shallowFile,'utf8'):'';
 if(workflowLocation(repo).key!==location.key)throw Error('Repository changed while exporting its snapshot');
 return {commit,objectFormat,files,pack,fileCount:entries.length,locationKey:location.key,shallow};
}
async function main(){
 process.umask(0o077);
 const [repoArg,ref,outputArg,briefFile]=process.argv.slice(2),repo=path.resolve(repoArg||'.'),output=path.resolve(outputArg||'.');
 const binary=process.env.DRAKEN_DOCKER_BIN,host=process.env.DRAKEN_DOCKER_HOST;
 const approved=JSON.parse(process.env.DRAKEN_WORKSPACE_ALLOWED_IMAGES||'[]');
 if(!repoArg||!ref||!outputArg||!briefFile||!binary||!host||!Array.isArray(approved)||!approved.length||approved.length>16||approved.some(image=>!pinned(image)))throw Error('Usage: factory-workspace.cjs REPOSITORY COMMIT NEW_OUTPUT_DIRECTORY BRIEF_FILE; configure Docker and DRAKEN_WORKSPACE_ALLOWED_IMAGES');
 fs.mkdirSync(output,{mode:0o700});const controller=new AbortController();const abort=()=>controller.abort();process.once('SIGTERM',abort);process.once('SIGINT',abort);const deadline=setTimeout(abort,900000);
 const save=(name,value)=>{const temporary=path.join(output,'.'+crypto.randomUUID());const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.linkSync(temporary,path.join(output,name));const directory=fs.openSync(output,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}finally{fs.unlinkSync(temporary);}};
 const record=value=>{const fd=fs.openSync(path.join(output,'events.jsonl'),'a',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const {stdout,stderr,...progress}=value;const status=fs.openSync(path.join(output,'progress.jsonl'),'a',0o600);try{fs.writeFileSync(status,JSON.stringify(progress)+'\n');fs.fsyncSync(status);}finally{fs.closeSync(status);}if(value.type==='stage-started'||value.type==='stage-result')console.log(value.type,value.name,value.code??'');};
 const docker=(args,options={})=>processCall(binary,['--host',host,...args],{...options,env:{PATH:process.env.PATH,HOME:process.env.HOME,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR}});
 const prefix='draken-workspace-'+crypto.randomUUID(),container=prefix+'-worker',volume=prefix+'-files';
 save('resources.json',{prefix,container,volume,exporter:prefix+'-export'});
 const resources=[];let outcome,modelCalls=0,source,image,environment,authorization,checkoutComplete=false,retainVolume=false;
 const accounting=()=>{const file=path.join(output,'agent/status.json');if(!fs.existsSync(file))return {};try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {modelCalls:null,accountingComplete:false};}};
 const receive=event=>{record(event);if(event.type==='stage-result'&&event.name==='Check out repository'&&event.commit===source.commit&&event.code===0)checkoutComplete=true;};
 try{
  source=await snapshot(repo,ref,controller.signal);save('source.json',{repo,ref,locationKey:source.locationKey,commit:source.commit,objectFormat:source.objectFormat,fileCount:source.fileCount,packSHA256:crypto.createHash('sha256').update(source.pack).digest('hex'),uncommittedIncluded:false,historyIncluded:true});fs.writeFileSync(path.join(output,'source.pack'),source.pack,{mode:0o600,flag:'wx'});
  if(!Object.hasOwn(source.files,'.draken/environment.json'))throw Error('Missing required file: .draken/environment.json. Add and commit it to the selected branch or commit before running repository checks.');
  environment=validate(JSON.parse(source.files['.draken/environment.json']),approved);
  authorization=loadBrief(path.resolve(briefFile),repo,source.commit);sdkConfiguration();await authorization.authorize(controller.signal);save('workflow.json',authorization.brief);
  const info=JSON.parse((await docker(['image','inspect',environment.image],{signal:controller.signal})).toString())[0];assertDockerHost(JSON.parse((await docker(['info','--format','{{json .}}'],{signal:controller.signal})).toString()),host,info.Id);
  save('environment.json',environment);
  const tool=fs.readFileSync(path.join(__dirname,'factory-workspace/tool.cjs')),worker=fs.readFileSync(path.join(__dirname,'factory-workspace/worker.cjs'));
  const key=fingerprint({environment,commit:source.commit,tool:crypto.createHash('sha256').update(tool).digest('hex'),worker:crypto.createHash('sha256').update(worker).digest('hex'),platform:process.arch,wrapper:4});
  const context=path.join(output,'image');fs.mkdirSync(context,{mode:0o700});fs.writeFileSync(path.join(context,'tool.cjs'),tool);fs.writeFileSync(path.join(context,'worker.cjs'),worker);
  fs.writeFileSync(path.join(context,'Dockerfile'),`FROM ${environment.image}\nUSER root\nRUN mkdir -p /factory /workspace && chown 65532:65532 /workspace\nCOPY worker.cjs tool.cjs /factory/\nRUN chmod 644 /factory/worker.cjs /factory/tool.cjs\nLABEL draken.environment=${key}\nUSER 65532:65532\nWORKDIR /workspace\nCMD ["node", "/factory/worker.cjs"]\n`);
  image=(await docker(['build','--network=none','--quiet','-t','draken-workspace:'+key,context],{signal:controller.signal,timeout:180000})).toString().trim().split('\n').at(-1);
  if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Build did not return a pinned image ID');
  save('image.json',{id:image,base:environment.image,recipe:key});
  resources.push(['volume',volume]);await docker(['volume','create','--label','draken.factory.run='+prefix,volume]);
  const taskEnv=process.env.DRAKEN_WORKSPACE_ENV_FILE?['--env-file',path.resolve(process.env.DRAKEN_WORKSPACE_ENV_FILE)]:[];
  resources.push(['container',container]);await docker(['create','-i',...dockerIsolation(container,'bridge',prefix),...taskEnv,'--mount',`type=volume,src=${volume},dst=/workspace`,image,'node','-e','setInterval(()=>{},1000)']);
  const inspection=JSON.parse((await docker(['inspect',container])).toString())[0];delete inspection.Config.Env;save('container.json',inspection);
   await docker(['start',container]);
   const input={commit:source.commit,objectFormat:source.objectFormat,pack:source.pack.toString('base64'),shallow:source.shallow,remote:process.env.DRAKEN_WORKSPACE_REMOTE||'',environment};
   await docker(['exec','-i',container,'node','/factory/worker.cjs'],{signal:controller.signal,timeout:900000,limit:64_000_000,input:JSON.stringify(input),onLine:line=>receive(JSON.parse(line))});
   record({type:'stage-started',name:'Run workflow',phase:'agent'});
   const agent=await runAgent({directory:path.join(output,'agent'),sessionDirectory:authorization.sessionDirectory,brief:authorization.brief,ref,environment,signal:controller.signal,record,maxCalls:authorization.brief.policy.maxCalls,authorize:()=>authorization.authorize(controller.signal),invoke:async(request,signal)=>{
    const raw=await docker(['exec','-i',container,'node','/factory/tool.cjs'],{signal,timeout:245000,limit:3_000_000,input:JSON.stringify(request)});const response=JSON.parse(raw.toString());if(!response.ok)throw Error(response.error);return response.value;
   }});
   modelCalls=agent.modelCalls;record({type:'stage-result',name:'Run workflow',phase:'agent',status:agent.status,code:agent.status==='completed'?0:1});
   outcome={status:agent.status,detail:agent.summary,commit:source.commit,image,modelCalls,sessionId:agent.sessionId,summary:agent.summary,output};
 }catch(error){outcome={status:controller.signal.aborted?'cancelled':'failed',detail:error.message,modelCalls,output,...accounting()};save('failure.json',outcome);}
 finally{
  if(checkoutComplete){
   const exporter=prefix+'-export';resources.push(['container',exporter]);
   try{
    // Stop all repository processes before taking a read-only handoff to a fresh collector.
    await docker(['rm','--force',container]);
    await docker(['create','-i',...dockerIsolation(exporter,'none',prefix),'--mount',`type=volume,src=${volume},dst=/workspace,readonly`,image]);
    save('export-container.json',JSON.parse((await docker(['inspect',exporter])).toString())[0]);
    let collected=false;
    await docker(['start','--attach','--interactive',exporter],{timeout:60000,limit:8_000_000,input:JSON.stringify({commit:source.commit,objectFormat:source.objectFormat,pack:source.pack.toString('base64'),shallow:source.shallow,exportOnly:true}),onLine:line=>{
     const event=JSON.parse(line);if(event.type==='patch'&&event.base===source.commit){const fd=fs.openSync(path.join(output,'changes.patch'),'wx',0o600);try{fs.writeFileSync(fd,event.patch);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}record({type:'patch-saved',base:event.base,bytes:Buffer.byteLength(event.patch)});collected=true;}
    }});
    const state=JSON.parse((await docker(['inspect','--format','{{json .State}}',exporter])).toString());if(state.ExitCode!==0||!collected)throw Error('Patch collection failed');
   }catch(error){retainVolume=true;outcome={...outcome,status:'interrupted',detail:'Patch collection failed; workspace retained for inspection',retainedVolume:volume,patchError:error.message};}
  }
  outcome={...outcome,...accounting()};
  if(outcome.status==='completed'&&outcome.accountingComplete===false)outcome={...outcome,status:'failed',detail:'Agent usage is unconfirmed'};
  const errors=[];for(const [kind,name] of resources.reverse())try{if(kind==='volume'&&retainVolume)continue;await docker(kind==='container'?['rm','--force',name]:[kind,'rm',name]);}catch(error){if(!/No such|not found/.test(error.message))errors.push(error.message);}
  if(errors.length){outcome={...outcome,status:'interrupted',detail:'Workspace cleanup needs attention',cleanupErrors:errors};}
  save('result.json',outcome);clearTimeout(deadline);process.removeListener('SIGTERM',abort);process.removeListener('SIGINT',abort);
 }
 console.log(JSON.stringify(outcome,null,2));if(outcome.status!=='completed')process.exitCode=1;
}
module.exports={snapshot};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
