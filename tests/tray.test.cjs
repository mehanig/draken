const {test,beforeEach,afterEach}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {TrayController}=require('../dist/tray/controller');
const {launchServer,openBrowser}=require('../dist/tray/processes');
const {assertTrayDesktop}=require('../dist/tray/launcher');
const {nativeCommand}=require('../dist/tray/native');
test('Windows tray transport preserves the fixed Unicode program without shell or execution-policy overrides',()=>{
 const command=nativeCommand('win32','C:\\Windows');
 assert.match(command.executable,/powershell\.exe$/);
 assert.deepEqual(command.args.slice(0,-1),['-NoLogo','-NoProfile','-NonInteractive','-STA','-WindowStyle','Hidden','-EncodedCommand']);
 assert.equal(Buffer.from(command.args.at(-1),'base64').toString('utf16le'),fs.readFileSync(path.join(__dirname,'../tray/windows.ps1'),'utf8'));
 assert.throws(()=>nativeCommand('linux','/synthetic'),/Unsupported/);
});
const {probeServer}=require('../dist/server-status');
const {serverTarget,recordedServerTarget}=require('../dist/server-state');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const target={url:'http://127.0.0.1:40333',open:'http://127.0.0.1:40333',instance:undefined};
function rig({live=false,saved=false}={}){
 const views=[],calls=[];let running=live,child,stopWorks=true,readyGate;
 const ops={target:()=>({...target,instance:saved?'saved-instance':undefined}),configured:()=>target,
  probe:async()=>{calls.push('probe');if(!running)throw Error('offline');return {instance:'owned'};},
  launch:()=>{calls.push('launch');const exit=deferred();running=true;
   child={ready:readyGate?readyGate.promise:Promise.resolve({...target,instance:'owned'}),exited:exit.promise,stop:async()=>{calls.push('stop');if(stopWorks){running=false;exit.resolve();}return stopWorks;}};return child;},
  open:async url=>{calls.push(['open',url]);},changed:v=>views.push(v)};
 return {ops,views,calls,controller:new TrayController(ops),setLive:v=>running=v,setStop:v=>stopWorks=v,setReady:v=>readyGate=v};
}

test('fresh tray starts one owned server; browser and stop actions use its verified target',async()=>{
 const r=rig();await r.controller.initialize();assert.equal(r.controller.view.phase,'running');assert.equal(r.controller.view.canStop,true);
 await r.controller.act('open');assert.deepEqual(r.calls.find(Array.isArray),['open',target.open]);
 await r.controller.act('stop');assert.equal(r.controller.view.phase,'stopped');assert.equal(r.controller.view.canStart,true);
 await r.controller.close();assert.equal(r.calls.filter(x=>x==='stop').length,1);
});
test('existing server is observed, never stopped or taken over even after it disappears',async()=>{
 const r=rig({live:true,saved:true});await r.controller.initialize();assert.equal(r.controller.view.owned,false);assert.equal(r.controller.view.canStop,false);
 await r.controller.act('stop');await r.controller.act('start');assert.equal(r.calls.includes('launch'),false);assert.equal(r.calls.includes('stop'),false);
 r.setLive(false);await r.controller.poll();assert.equal(r.controller.view.canStart,false);await r.controller.close();assert.equal(r.calls.includes('stop'),false);
});
test('a stopped owned server remains restartable when its hostname resolved to a numeric bind address',async()=>{
 const r=rig(),named={url:'http://localhost:40333',open:'http://localhost:40333',instance:undefined},actual={url:'http://[::1]:40333',open:'http://[::1]:40333',instance:'owned'};
 r.ops.target=()=>named;r.ops.configured=()=>named;const gate=deferred();gate.resolve(actual);r.setReady(gate);
 await r.controller.initialize();r.ops.target=()=>actual;await r.controller.act('stop');await r.controller.poll();assert.equal(r.controller.view.canStart,true);
});
test('saved offline server needs an explicit Start; different launch settings cannot silently become defaults',async()=>{
 const r=rig({saved:true});await r.controller.initialize();assert.equal(r.calls.includes('launch'),false);assert.equal(r.controller.view.canStart,true);
 r.ops.target=()=>({...target,url:'http://192.0.2.1:40333',open:'https://192.0.2.1:44433',instance:'saved'});
 await r.controller.poll();assert.equal(r.controller.view.canStart,false);await r.controller.act('start');assert.equal(r.calls.includes('launch'),false);
});
test('concurrent starts coalesce and Quit during startup waits then stops its child',async()=>{
 const r=rig({saved:true});await r.controller.initialize();const gate=deferred();r.setReady(gate);
 const start=r.controller.act('start');await new Promise(resolve=>setImmediate(resolve));
 await r.controller.act('start');const close=r.controller.close();gate.resolve({...target,instance:'owned'});await start;assert.equal(await close,true);
 assert.equal(r.calls.filter(x=>x==='launch').length,1);assert.equal(r.calls.filter(x=>x==='stop').length,1);
});
test('unconfirmed shutdown retains ownership and blocks replacement, including Quit',async()=>{
 const r=rig();await r.controller.initialize();r.setStop(false);await r.controller.act('stop');assert.equal(r.controller.view.phase,'error');assert.equal(r.controller.view.canStart,false);
 await r.controller.act('start');assert.equal(r.calls.filter(x=>x==='launch').length,1);assert.equal(await r.controller.close(),false);
 r.setStop(true);assert.equal(await r.controller.close(),true);
});
test('late poll cannot turn a stopped server back into running; late browser probe cannot open after Quit',async()=>{
 const r=rig();await r.controller.initialize();const gate=deferred();r.ops.probe=()=>gate.promise;
 const poll=r.controller.poll();await r.controller.act('stop');gate.resolve({instance:'owned'});await poll;assert.equal(r.controller.view.phase,'stopped');
 const other=rig({live:true});await other.controller.initialize();const second=deferred();other.ops.probe=()=>second.promise;
 const opening=other.controller.act('open'),closing=other.controller.close();second.resolve({instance:'elsewhere'});await opening;await closing;
 assert.equal(other.calls.some(Array.isArray),false);
});
test('failed startup stays visible across polling instead of becoming an apparently clean stop',async()=>{
 const r=rig({saved:true});r.ops.launch=()=>{throw Error('synthetic launch failure');};await r.controller.initialize();await r.controller.act('start');
 assert.equal(r.controller.view.phase,'error');const detail=r.controller.view.detail;await r.controller.poll();assert.equal(r.controller.view.phase,'error');assert.equal(r.controller.view.detail,detail);assert.equal(r.controller.view.canStart,true);
});
test('platform and browser boundaries reject unsupported/headless use and command-bearing URLs',async()=>{
 assert.throws(()=>assertTrayDesktop('linux',{}),/macOS and Windows/);
 assert.throws(()=>assertTrayDesktop('darwin',{SSH_CONNECTION:'remote'}),/local desktop/);
 assert.throws(()=>assertTrayDesktop('win32',{SESSIONNAME:'Services'}),/local desktop/);
 assert.doesNotThrow(()=>assertTrayDesktop('darwin',{}));assert.doesNotThrow(()=>assertTrayDesktop('win32',{}));
 for(const value of ['file:///etc/passwd','javascript:alert(1)','https://example.com/?token=secret','https://user:pass@example.com','http://localhost/path'])await assert.rejects(openBrowser(value),/Invalid browser URL/);
});

let root,env;
beforeEach(()=>{env={...process.env};root=fs.mkdtempSync(path.join(os.tmpdir(),'draken tray-'));});
afterEach(()=>{process.env=env;fs.rmSync(root,{recursive:true,force:true});});
async function isolated(){
 const port=await new Promise(resolve=>{const server=net.createServer().listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
 process.env={HOME:root,USERPROFILE:root,PATH:path.dirname(process.execPath),DRAKEN_DATA_DIR:path.join(root,'state'),DRAKEN_HOST:'127.0.0.1',DRAKEN_PORT:String(port)};
 fs.mkdirSync(process.env.DRAKEN_DATA_DIR);return port;
}
test('real owned server reports its instance over IPC and stops gracefully without a PID kill',async()=>{
 await isolated();const server=launchServer(path.join(root,'server.log'));
 try{const current=await server.ready;assert.equal((await probeServer(current)).instance,current.instance);assert.equal(serverTarget().instance,current.instance);
  assert.equal(await server.stop(),true);await server.exited;await assert.rejects(probeServer(current));assert.equal(await server.stop(),true);
 }finally{await server.stop();}
});
test('an IPC server rejects the wrong instance and exits when its owning channel disconnects',async()=>{
 await isolated();const child=spawn(process.execPath,[path.resolve(__dirname,'../dist/cli.js'),'--tray-server'],{env:process.env,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 try{
  const target=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server not ready')),10000);child.on('message',message=>{if(message.type==='draken-ready'){clearTimeout(timer);resolve(message.target);}});child.once('error',reject);});
  child.send({type:'draken-shutdown',instance:'not-its-instance'});await new Promise(resolve=>setTimeout(resolve,100));await probeServer(target);
  child.disconnect();await exited;await assert.rejects(probeServer(target));
 }finally{if(child.connected)child.disconnect();await exited;}
});
test('real tray worker is single-instance, detaches from its launching terminal, and cleans up its owned server on Quit',async()=>{
 await isolated();process.env.DRAKEN_TRAY_TEST_ACTION=path.join(root,'action');
 const launch=()=>spawn(process.execPath,[path.join(__dirname,'fixtures/fake-tray-worker.cjs')],{env:process.env,stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
 const child=launch(),exit=new Promise(resolve=>child.once('exit',resolve));
 const message=p=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker not ready')),15000);p.once('error',reject);p.once('message',value=>{clearTimeout(timer);resolve(value);});});
 try{
  assert.equal((await message(child)).type,'tray-ready');child.disconnect();
  let ready=false;for(let n=0;n<150;n++){try{await probeServer(serverTarget());ready=true;break;}catch{}await new Promise(r=>setTimeout(r,50));}assert.equal(ready,true);
  const duplicate=launch(),duplicateExit=new Promise(resolve=>duplicate.once('exit',resolve));const failure=await message(duplicate);assert.equal(failure.type,'tray-error');assert.match(failure.message,/already owns/);if(duplicate.connected)duplicate.disconnect();await duplicateExit;
  await probeServer(serverTarget());fs.writeFileSync(process.env.DRAKEN_TRAY_TEST_ACTION,'quit');await exit;await assert.rejects(probeServer(serverTarget()));
  assert.equal(fs.existsSync(path.join(process.env.DRAKEN_DATA_DIR,'tray.lock')),false);
 }finally{fs.writeFileSync(process.env.DRAKEN_TRAY_TEST_ACTION,'quit');if(child.connected)child.disconnect();await exit;}
});
test('native helper loss shuts down an owned server, but quitting while attached preserves an external server',async()=>{
 for(const external of [false,true]){
  await isolated();process.env.DRAKEN_TRAY_TEST_ACTION=path.join(root,'action');
  const server=external?launchServer(path.join(root,'external.log')):undefined;
  const original=server?await server.ready:undefined;
  // An override must not conceal the existing server and start a second listener
  // against the same database (and run recovery on its active work).
  const childEnv={...process.env};if(external)childEnv.DRAKEN_PORT=String(Number(childEnv.DRAKEN_PORT)===65535?65534:Number(childEnv.DRAKEN_PORT)+1);
  const child=spawn(process.execPath,[path.join(__dirname,'fixtures/fake-tray-worker.cjs')],{env:childEnv,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  try{
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('tray not ready')),10000);child.once('message',m=>{clearTimeout(timer);m.type==='tray-ready'?resolve():reject(Error(m.message));});});child.disconnect();
   let live=false;for(let n=0;n<150;n++){try{await probeServer(serverTarget());live=true;break;}catch{}await new Promise(r=>setTimeout(r,40));}assert.equal(live,true);
   fs.writeFileSync(process.env.DRAKEN_TRAY_TEST_ACTION,external?'quit':'crash');await exited;
   if(external){await probeServer(original);assert.equal(recordedServerTarget().instance,original.instance);}else await assert.rejects(probeServer(serverTarget()));
  }finally{fs.writeFileSync(process.env.DRAKEN_TRAY_TEST_ACTION,'quit');if(child.connected)child.disconnect();await exited;await server?.stop();}
  fs.rmSync(process.env.DRAKEN_DATA_DIR,{recursive:true,force:true});fs.rmSync(process.env.DRAKEN_TRAY_TEST_ACTION,{force:true});
 }
});
