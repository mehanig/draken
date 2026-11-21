const {test}=require('node:test'),assert=require('node:assert/strict'),net=require('node:net');
const {assertDockerHost,dockerIsolation}=require('../dist/factory/docker');
const {publicIPv4,createProxy}=require('../scripts/factory-workspace/proxy.cjs');
test('workspace and broker isolation prohibit host mounts and require a local rootless engine',()=>{
 const info={SecurityOptions:['name=rootless','name=seccomp,profile=builtin'],MemoryLimit:true,PidsLimit:true,CpuCfsQuota:true},image='sha256:'+'a'.repeat(64);
 assertDockerHost(info,'unix:///test.sock',image);for(const flag of ['MemoryLimit','PidsLimit','CpuCfsQuota'])assert.throws(()=>assertDockerHost({...info,[flag]:false},'unix:///test.sock',image),/enforcement/);
 assert.throws(()=>assertDockerHost({...info,SecurityOptions:[]},'unix:///test.sock',image),/Rootless/);assert.throws(()=>assertDockerHost(info,'tcp://remote',image),/local/);assert.throws(()=>assertDockerHost(info,'unix:///test.sock','node:latest'),/pinned/);
 for(const engineering of [true,false]){const args=dockerIsolation('owned','internal','run',engineering);for(const flag of ['--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--init'])assert.ok(args.includes(flag));assert.equal(args[args.indexOf('--user')+1],'65532:65532');assert.ok(!args.join().includes('type=bind'));assert.ok(!args.includes('--privileged'));assert.ok(args.includes(engineering?'--memory=4096m':'--memory=768m'));}
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
  }
 }finally{await new Promise(r=>proxy.close(r));}
});
