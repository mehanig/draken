const {test}=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),http=require('node:http');
const {assertDockerHost,dockerIsolation}=require('../dist/factory/docker');
const {publicIPv4,createProxy}=require('../scripts/factory-workspace/proxy.cjs');
test('workspace and broker isolation prohibit host mounts and require a local rootless engine',()=>{
 const info={SecurityOptions:['name=rootless','name=seccomp,profile=builtin'],MemoryLimit:true,PidsLimit:true,CpuCfsQuota:true},image='sha256:'+'a'.repeat(64);
 assertDockerHost(info,'unix:///test.sock',image);for(const flag of ['MemoryLimit','PidsLimit','CpuCfsQuota'])assert.throws(()=>assertDockerHost({...info,[flag]:false},'unix:///test.sock',image),/enforcement/);
 assert.throws(()=>assertDockerHost({...info,SecurityOptions:[]},'unix:///test.sock',image),/Rootless/);assert.throws(()=>assertDockerHost(info,'tcp://remote',image),/local/);assert.throws(()=>assertDockerHost(info,'unix:///test.sock','node:latest'),/pinned/);
 for(const engineering of [true,false]){const args=dockerIsolation('owned','internal','run',engineering);for(const flag of ['--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--init'])assert.ok(args.includes(flag));assert.equal(args[args.indexOf('--user')+1],'65532:65532');assert.ok(!args.join().includes('type=bind'));assert.ok(!args.includes('--privileged'));assert.ok(args.includes(engineering?'--memory=4096m':'--memory=768m'));}
});
test('public HTTPS reads follow checked redirects without forwarding credentials or granting writes',async()=>{
 const seen=[],lookups=[];
 const upstream=http.createServer((req,res)=>{
  if(req.url==='/redirect')return res.writeHead(302,{Location:'https://other.example/ok'}).end();
  if(req.url==='/private')return res.writeHead(302,{Location:'https://127.0.0.1/ok'}).end();
  if(req.url==='/metadata')return res.writeHead(302,{Location:'https://169.254.169.254/ok'}).end();
  if(req.url==='/http')return res.writeHead(302,{Location:'http://public.example/ok'}).end();
  if(req.url==='/loop')return res.writeHead(302,{Location:'/loop'}).end();
  res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'never-forward'}).end(JSON.stringify({ok:true,tarball:'https://registry.npmjs.org/p/-/p.tgz'}));
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const proxy=createProxy({lookup:async host=>{lookups.push(host);return host==='mixed.example'?[{address:'104.16.25.34'},{address:'10.0.0.1'}]:[{address:host==='rebind.example'&&lookups.filter(h=>h===host).length>1?'127.0.0.1':net.isIP(host)?host:'104.16.25.34'}];},requestHTTPS:(options,cb)=>{seen.push(options);return http.request({...options,hostname:'127.0.0.1',port:upstream.address().port},cb);}});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${proxy.address().port}`,get=(url,options)=>fetch(base+'/fetch?url='+encodeURIComponent(url),options);
 try{
  const response=await get('https://public.example/redirect',{headers:{Authorization:'Bearer secret',Cookie:'secret',Host:'spoof.example'}});assert.equal(response.status,200);assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('x-draken-url'),'https://other.example/ok');assert.equal((await response.json()).ok,true);
  assert.deepEqual(lookups,['public.example','other.example']);for(const options of seen){assert.equal(options.hostname,'104.16.25.34');assert.equal(options.headers.Host,options.servername);assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);assert.ok(options.checkServerIdentity('ignored',{subject:{CN:'wrong.example'}}));}
  for(const url of ['https://public.example/private','https://public.example/metadata','https://public.example/http','https://mixed.example/ok','https://rebind.example/loop','https://user:password@public.example/ok','https://public.example:444/ok','https://[::1]/ok'])assert.equal((await get(url)).status,403,url);
  assert.equal((await get('https://public.example/loop')).status,502);
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await get('https://public.example/ok',{method,body:'no'})).status,403);
  const npm=await fetch(base+'/npm/p');assert.match((await npm.json()).tarball,/^http:\/\/egress:8080\/npm\//);
  assert.equal((await fetch(base+'/npm/-/npm/v1/security/advisories/bulk',{method:'POST',body:'{}'})).status,200);
  assert.equal((await fetch(base+'/npm/-/user/org.couchdb.user:test',{method:'POST',body:'{}'})).status,403);
 }finally{await new Promise(r=>proxy.close(r));await new Promise(r=>upstream.close(r));}
});
test('proxy rejects loopback, metadata, private networks, non-HTTPS ports and write operations',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.3.112','100.64.0.1','::1','224.0.0.1','0.0.0.0','192.0.2.1','198.51.100.1','203.0.113.1','240.0.0.1'])assert.equal(publicIPv4(ip),false,ip);
 assert.equal(publicIPv4('104.16.25.34'),true);
 const proxy=createProxy({lookup:async()=>[{address:'127.0.0.1',family:4}]});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
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
