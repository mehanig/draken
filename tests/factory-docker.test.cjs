const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {DockerExecutor}=require('../dist/factory/docker');
const {publicIPv4,createProxy}=require('../scripts/factory-container/proxy.cjs');
const image='sha256:'+'a'.repeat(64);
function fixture(wait=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-docker-')),log=path.join(dir,'commands.jsonl'),binary=path.join(dir,'docker');
 fs.writeFileSync(binary,`#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(4);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
if(a[0]==='info')console.log(JSON.stringify({SecurityOptions:['name=rootless','name=seccomp,profile=builtin'],MemoryLimit:true,PidsLimit:true,CpuCfsQuota:true}));
else if(a[0]==='inspect')console.log(JSON.stringify(a.includes('--format')?{ExitCode:0,OOMKilled:false}:[{Image:${JSON.stringify(image)},Config:{User:'65532:65532'},HostConfig:{},Mounts:[]}]));
else if(a[0]==='logs')console.log('proxy-ready');
else if(a[0]==='start'&&a.includes('--attach')){let input='';process.stdin.on('data',p=>input+=p);process.stdin.on('end',()=>${wait?"setTimeout(()=>{},60000)":"console.log(JSON.stringify({outcome:{ok:true,detail:'Controlled Docker CLI fixture',evidence:['receipt']}}))"});}
else console.log('created');
`,{mode:0o700});
 const records=[],executor=new DockerExecutor({binary,host:'unix:///test.sock',image,stages:{produce:{dependencies:[],output:true,networkHosts:['registry.npmjs.org']},verify:{dependencies:['produce'],output:false,networkHosts:[]}},record:async v=>records.push(v)});
 return {executor,records,commands:()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[],cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
const invocation={phase:'action',attempt:1,task:{id:'task',locationKey:'repo',inputs:{}}};
test('Docker stages have independent containers, no host mounts and read-only prior artifacts',async()=>{
 const f=fixture();try{
  const signal=new AbortController().signal;await f.executor.check(signal);await f.executor.invoke('produce',invocation,signal);await f.executor.invoke('verify',invocation,signal);await f.executor.dispose();
  const creates=f.commands().filter(a=>a[0]==='create');assert.equal(creates.length,3); // two workers and their one egress broker
  for(const args of creates){for(const flag of ['--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=128','--memory=768m','--cpus=1'])assert.ok(args.includes(flag));assert.equal(args[args.indexOf('--user')+1],'65532:65532');assert.ok(!args.join().includes('type=bind'));assert.ok(!args.includes('--privileged'));}
  const verify=creates.find(a=>a.includes('none'));assert.ok(verify.some(a=>a.includes('dst=/inputs/produce,readonly')));
  assert.equal(new Set(creates.map(a=>a[a.indexOf('--name')+1])).size,3);
  assert.ok(f.commands().some(a=>a[0]==='network'&&a.includes('--internal')));assert.ok(f.commands().some(a=>a[0]==='volume'&&a[1]==='rm'));
 }finally{f.cleanup();}
});
test('cancellation removes the running container rather than merely killing the docker client',async()=>{
 const f=fixture(true),controller=new AbortController();try{
  const running=f.executor.invoke('produce',invocation,controller.signal);
  for(let i=0;i<200&&!f.commands().some(a=>a[0]==='start'&&a.includes('--attach'));i++)await new Promise(r=>setTimeout(r,10));
  controller.abort();await assert.rejects(running,/cancelled/);await f.executor.dispose();
  assert.ok(f.commands().some(a=>a[0]==='rm'&&a.includes('--force')));
 }finally{f.cleanup();}
});
test('missing Docker, unknown tools, missing artifacts and mutable image tags never fall back to host commands',async()=>{
 assert.throws(()=>new DockerExecutor({binary:'none',host:'unix:///x',image:'node:latest',stages:{},record:async()=>{}}),/pinned/);
 const missing=new DockerExecutor({binary:'/nonexistent/docker',host:'unix:///x',image,stages:{},record:async()=>{}});await assert.rejects(missing.check(new AbortController().signal));
 const f=fixture();try{await assert.rejects(f.executor.invoke('shell',invocation,new AbortController().signal),/Unregistered/);await assert.rejects(f.executor.invoke('verify',invocation,new AbortController().signal),/artifact/);assert.equal(f.commands().length,0);}finally{f.cleanup();}
});
test('proxy rejects loopback, metadata, private networks, non-HTTPS ports and unapproved hosts',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.3.112','100.64.0.1','::1','224.0.0.1'])assert.equal(publicIPv4(ip),false,ip);
 assert.equal(publicIPv4('104.16.25.34'),true);
 const proxy=createProxy(new Set(['registry.npmjs.org']),async()=>[{address:'127.0.0.1',family:4}]);await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 try{
  const base=`http://127.0.0.1:${proxy.address().port}`;
  for(const url of ['https://registry.npmjs.org/draken','https://evil.example/','https://registry.npmjs.org@evil.example/','http://169.254.169.254/'])assert.equal((await fetch(base+'/fetch?url='+encodeURIComponent(url))).status,403);
  assert.equal((await fetch(base+'/npm/draken',{method:'PUT',body:'not a publication'})).status,403);
  assert.equal((await fetch(base+'/npm/https://evil.example/')).status,403);
  for(const target of ['registry.npmjs.org:443','169.254.169.254:443','registry.npmjs.org:80','evil.example:443']){
  const response=await new Promise((resolve,reject)=>{const socket=net.connect(proxy.address().port,'127.0.0.1',()=>socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));let text='';socket.on('data',x=>text+=x);socket.on('end',()=>{socket.destroy();resolve(text);});socket.on('error',reject);});assert.match(response,/403/);
 }}finally{await new Promise(r=>proxy.close(r));}
});
