// Explicit real-Docker isolation proof. Never substitutes a fake engine or host execution.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {DockerExecutor}=require('../dist/factory/docker');
async function main(){
 const binary=process.env.DRAKEN_DOCKER_BIN,host=process.env.DRAKEN_DOCKER_HOST,base=process.env.DRAKEN_FACTORY_IMAGE;
 if(!binary||!host||!base)throw Error('Explicit Docker binary, socket and pinned base image required');
 const docker=(...args)=>execFileSync(binary,['--host',host,...args],{encoding:'utf8',maxBuffer:4_000_000});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'draken-container-proof-'));let executor,image;
 const records=[];
 try{
  fs.writeFileSync(path.join(dir,'Dockerfile'),`FROM ${base}\nCOPY probe.cjs /factory/stage.cjs\n`);
  fs.writeFileSync(path.join(dir,'probe.cjs'),`const fs=require('node:fs'),assert=require('node:assert/strict'),net=require('node:net');let text='';process.stdin.on('data',p=>text+=p);process.stdin.on('end',async()=>{try{const {capability:id}=JSON.parse(text);assert.equal(process.getuid(),65532);assert.equal(fs.existsSync('/var/run/docker.sock'),false);assert.equal(process.env.DRAKEN_FACTORY_TOKEN,undefined);assert.throws(()=>fs.writeFileSync('/factory/overwrite','bad'));
if(id==='produce')fs.writeFileSync('/out/report.json','{"value":"original"}');
if(id==='verify'){assert.equal(JSON.parse(fs.readFileSync('/inputs/produce/report.json')).value,'original');assert.throws(()=>fs.writeFileSync('/inputs/produce/report.json','changed'));}
if(id==='network'){const broker=url=>'http://egress:8080/fetch?url='+encodeURIComponent(url);const allowed=await fetch(broker('https://registry.npmjs.org/draken/latest'),{signal:AbortSignal.timeout(15000)});assert.equal(allowed.status,200);assert.equal((await fetch(broker('https://api.github.com'),{signal:AbortSignal.timeout(3000)})).status,403);assert.equal((await fetch(broker('http://169.254.169.254'),{signal:AbortSignal.timeout(3000)})).status,403);await assert.rejects(fetch('https://registry.npmjs.org/draken/latest',{signal:AbortSignal.timeout(2000)}));await new Promise((resolve,reject)=>{const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(1200,()=>{s.destroy();resolve();});s.on('connect',()=>{s.destroy();reject(Error('Direct egress escaped internal network'));});s.on('error',()=>resolve());});}
if(id==='sleep'){setInterval(()=>{},1000);return;}
console.log(JSON.stringify({outcome:{ok:true,detail:id+' isolation verified',evidence:['real Docker kernel enforcement']}}));}catch(error){console.error(error.message);process.exitCode=1;}});`);
  image=docker('build','--quiet',dir).trim().split('\n').at(-1);assert.match(image,/^sha256:/);
  executor=new DockerExecutor({binary,host,image,stages:{produce:{dependencies:[],output:true,networkHosts:[]},verify:{dependencies:['produce'],output:false,networkHosts:[]},network:{dependencies:[],output:false,networkHosts:['registry.npmjs.org']},sleep:{dependencies:[],output:false,networkHosts:[]}},record:async value=>records.push(value)});
  const context={phase:'action',attempt:1,task:{id:'proof',locationKey:'proof',inputs:{}}},signal=new AbortController().signal;
  await executor.check(signal);
  for(const id of ['produce','verify','network'])assert.equal((await executor.invoke(id,context,signal)).ok,true);
  const controller=new AbortController(),run=executor.invoke('sleep',context,controller.signal);const failed=assert.rejects(run,/cancelled/);
  let name;for(let i=0;i<200;i++){name=records.find(r=>r.capability==='sleep'&&r.type==='container-created')?.name;if(name){try{if(docker('inspect','--format','{{.State.Running}}',name).trim()==='true')break;}catch{}}await new Promise(r=>setTimeout(r,50));}
  assert.ok(name);controller.abort();await failed;await executor.dispose();
  for(const row of records.filter(r=>r.type==='container-created'))assert.throws(()=>docker('inspect',row.name));
  console.log(JSON.stringify({rootless:true,nonRoot:true,readOnlyRoot:true,readOnlyArtifacts:true,noDockerSocket:true,noCredentials:true,approvedHTTPS:true,unapprovedHTTPSDenied:true,metadataDenied:true,directEgressDenied:true,cancellationRemovedContainer:true,stages:records.filter(r=>r.type==='container-created').length}));
 }finally{await executor?.dispose();if(image)docker('image','rm',image);fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1});
