const {test,beforeEach,afterEach}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process');
const {rememberServer,serverTarget}=require('../dist/server-state');
let root,saved;
beforeEach(()=>{saved={...process.env};root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-server-status-'));process.env={HOME:root,PATH:path.dirname(process.execPath)+path.delimiter+'/usr/bin',DRAKEN_DATA_DIR:path.join(root,'state')};fs.mkdirSync(process.env.DRAKEN_DATA_DIR);});
afterEach(()=>{process.env=saved;fs.rmSync(root,{recursive:true,force:true});});
const record=()=>path.join(process.env.DRAKEN_DATA_DIR,'server-state.json');
const cli=path.resolve(__dirname,'../dist/cli.js');
function command(args,env=process.env){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cli,...args],{env,cwd:root,stdio:['ignore','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolve({code,out,err});});});}

test('saved bind address replaces localhost guessing, prefers HTTPS for opening and contains no credentials',()=>{
 const instance=randomUUID();rememberServer(instance,{address:'192.0.2.45',port:40333},{address:'192.0.2.45',port:44433});
 assert.deepEqual(serverTarget(),{url:'http://192.0.2.45:40333',open:'https://192.0.2.45:44433',instance});
 assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(record(),'utf8'))).sort(),['http_url','https_url','instance','pid','started_at','version']);
 if(process.platform!=='win32')assert.equal(fs.statSync(record()).mode&0o777,0o600);
 process.env.DRAKEN_PORT='41234';assert.deepEqual(serverTarget(),{url:'http://192.0.2.45:41234',open:'http://192.0.2.45:41234',instance:undefined});
 process.env.DRAKEN_HOST='localhost';assert.equal(serverTarget().url,'http://localhost:41234');
});

test('wildcard IPv4/IPv6 binds become usable loopback targets; absent records preserve legacy defaults',()=>{
 assert.equal(serverTarget().url,'http://127.0.0.1:40333');assert.equal(fs.existsSync(record()),false);
 rememberServer(randomUUID(),{address:'0.0.0.0',port:40333});assert.equal(serverTarget().url,'http://127.0.0.1:40333');
 rememberServer(randomUUID(),{address:'::',port:40333},{address:'::',port:44433});assert.equal(serverTarget().url,'http://[::1]:40333');assert.equal(serverTarget().open,'https://[::1]:44433');
 process.env.DRAKEN_PORT='0';assert.throws(()=>serverTarget(),/Invalid status port/);
});

test('corrupt, oversized, symlinked and non-origin records fail visibly rather than probing arbitrary paths',()=>{
 const instance=randomUUID();rememberServer(instance,{address:'127.0.0.1',port:40333});const original=JSON.parse(fs.readFileSync(record(),'utf8'));
 for(const body of ['synthetic secret that must not appear','x'.repeat(4097),JSON.stringify({...original,http_url:'http://127.0.0.1:40333/private?token=synthetic'}),JSON.stringify({...original,instance:[instance]}),JSON.stringify({...original,http_url:'file:///etc/passwd'})]){
  fs.writeFileSync(record(),body);assert.throws(()=>serverTarget(),error=>/saved server address is invalid/.test(error.message)&&!error.message.includes('synthetic secret'));
 }
 fs.unlinkSync(record());const outside=path.join(root,'outside.json');fs.writeFileSync(outside,JSON.stringify(original));fs.symlinkSync(outside,record());assert.throws(()=>serverTarget(),/saved server address is invalid/);
 process.env.DRAKEN_HOST='127.0.0.1';process.env.DRAKEN_PORT='40333';assert.equal(serverTarget().url,'http://127.0.0.1:40333','explicit operator override remains usable');
});

test('bare CLI discovers a non-default authenticated bind, rejects stale/wrong instances, and follows restart',async()=>{
 const port=await new Promise(resolve=>{const s=net.createServer().listen(0,'127.0.0.2',()=>{const n=s.address().port;s.close(()=>resolve(n));});});
 const env={...process.env,DRAKEN_HOST:'127.0.0.2',DRAKEN_PORT:String(port),DRAKEN_NO_AUTH:'false',DRAKEN_USERNAME:'synthetic',DRAKEN_PASSWORD:'synthetic',DRAKEN_JWT_SECRET:'synthetic-local-status-test-only'};
 let child,closed,fake;
 const stop=async()=>{if(child){child.kill('SIGTERM');await closed;child=undefined;}};
 const start=async()=>{child=spawn(process.execPath,[cli],{env,cwd:root,stdio:['ignore','pipe','pipe']});closed=new Promise(resolve=>child.once('exit',resolve));let text='',error='';child.stdout.on('data',v=>text+=v);child.stderr.on('data',v=>error+=v);for(let n=0;n<150&&!text.includes('Draken sync running');n++){if(child.exitCode!==null)throw Error(error);await new Promise(resolve=>setTimeout(resolve,30));}assert.match(text,/Draken sync running/);};
 try{
  await start();const first=JSON.parse(fs.readFileSync(record(),'utf8'));let status=await command(['status']);assert.equal(status.code,0,status.err);assert.match(status.out,new RegExp(`127\\.0\\.0\\.2:${port}`));assert.match(status.out,/saved server instance/);
  const before=fs.readFileSync(record());const duplicate=await command([],env);assert.equal(duplicate.code,1);assert.deepEqual(fs.readFileSync(record()),before,'failed duplicate must not overwrite the active identity');
  await stop();assert.equal((await command(['status'])).code,1,'a retained record does not prove liveness');
  fake=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({application:'draken',instance:randomUUID()}));}).listen(port,'127.0.0.2');await new Promise(resolve=>fake.once('listening',resolve));
  assert.equal((await command(['status'])).code,1,'an unrelated Draken response cannot confirm this data directory');await new Promise(resolve=>fake.close(resolve));fake=undefined;
  await start();assert.notEqual(JSON.parse(fs.readFileSync(record(),'utf8')).instance,first.instance);status=await command(['status']);assert.equal(status.code,0,status.err);
 }finally{await stop();if(fake)await new Promise(resolve=>fake.close(resolve));}
});
