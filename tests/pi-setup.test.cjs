const {test,beforeEach,afterEach}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn,spawnSync}=require('node:child_process');
const {piPaths,piSetupStatus,selectedPi}=require('../dist/pi/runtime'),{invokePi}=require('../dist/sync/pi'),{getDb,closeDb}=require('../dist/db/schema');
const cli=path.resolve(__dirname,'../dist/cli.js');let root,saved;
beforeEach(()=>{
 saved={...process.env};root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-pi-setup-'));fs.mkdirSync(path.join(root,'home'));fs.mkdirSync(path.join(root,'bin'));
 fs.symlinkSync(process.execPath,path.join(root,'bin/node'));fs.copyFileSync(path.join(__dirname,'fixtures/fake-npm.cjs'),path.join(root,'npm-cli.js'));
 process.env={HOME:path.join(root,'home'),PATH:path.join(root,'bin'),LANG:'C.UTF-8',DRAKEN_DATA_DIR:path.join(root,'state'),DRAKEN_HOST:'127.0.0.1',DRAKEN_NO_AUTH:'true',npm_execpath:path.join(root,'npm-cli.js')};
});
afterEach(()=>{closeDb();process.env=saved;fs.rmSync(root,{recursive:true,force:true});});
const run=(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:root,env:process.env,encoding:'utf8',timeout:30000});
const installed=()=>{const result=run('setup','--yes');assert.equal(result.status,0,result.stdout+result.stderr);return piPaths();};
const calls=()=>fs.existsSync(path.join(root,'npm-calls.jsonl'))?fs.readFileSync(path.join(root,'npm-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
const port=()=>new Promise(resolve=>{const server=net.createServer().listen(0,'127.0.0.1',()=>{const n=server.address().port;server.close(()=>resolve(n));});});

test('missing-pi doctor is actionable, read-only and does not install or inspect the real profile',async()=>{
 const status=await piSetupStatus(true);assert.equal(status.state,'missing');assert.match(status.message,/draken setup/);assert.match(status.message,/draken login/);
 const result=run('doctor');assert.equal(result.status,1);assert.match(result.stdout,/not generate text/);assert.equal(fs.existsSync(process.env.DRAKEN_DATA_DIR),false);assert.deepEqual(calls(),[]);
 const help=run('--help');assert.equal(help.status,0);assert.match(help.stdout,/draken setup/);assert.match(help.stdout,/Codex and Claude/);
 assert.equal(run('setup','--unknown').status,1);assert.equal(run('--help','--install').status,1);
});

test('installation requires explicit consent; login requires a terminal; overrides are never silently replaced',()=>{
 const result=run('setup');assert.equal(result.status,1);assert.match(result.stderr,/confirmation/);assert.equal(fs.existsSync(process.env.DRAKEN_DATA_DIR),false);assert.deepEqual(calls(),[]);
 assert.match(run('login').stderr,/interactive terminal/);
 process.env.DRAKEN_PI_BIN='/synthetic/nonexistent-pi';assert.match(run('setup','--yes').stderr,/explicitly configured/);assert.deepEqual(calls(),[]);
});

test('private install uses the shipped lock without scripts/global config; credentials and summarization stay isolated',async()=>{
 const global=path.join(root,'home/.pi/agent');fs.mkdirSync(global,{recursive:true});const original='synthetic global credentials must not be copied';fs.writeFileSync(path.join(global,'auth.json'),original);
 process.env.OPENAI_API_KEY='synthetic-ambient-key';process.env.PI_SESSION_ID='parent-session';process.env.PI_CODING_AGENT_DIR=global;process.env.CODEX_HOME='/synthetic/other-agent';
 const paths=installed(),entries=calls();assert.equal(entries.length,1);assert.ok(entries[0].args.includes('ci'));assert.ok(entries[0].args.includes('--ignore-scripts'));assert.ok(entries[0].args.some(arg=>arg.startsWith('--userconfig=')));assert.ok(entries[0].args.some(arg=>arg.startsWith('--globalconfig=')));assert.equal(entries[0].hasKey,false);assert.equal(entries[0].home,paths.home);
 assert.equal(fs.existsSync(path.join(paths.agent,'auth.json')),false);assert.equal(fs.readFileSync(path.join(global,'auth.json'),'utf8'),original);
 assert.equal((await piSetupStatus(true)).state,'needs_login');fs.writeFileSync(path.join(paths.agent,'auth.json'),'{}',{mode:0o600});assert.equal((await piSetupStatus(true)).state,'configured');
 process.env.NODE_OPTIONS='--require /synthetic/forbidden-preload';
 const answer=await invokePi('Synthetic source only',{system:'Synthetic test only.'});assert.equal(answer,'Synthetic private summary.');
 const invocation=JSON.parse(fs.readFileSync(path.join(paths.agent,'invocation.json'),'utf8'));
 for(const flag of ['--no-tools','--no-session','--no-extensions','--no-mcp','--no-context-files','--no-approve','--offline'])assert.ok(invocation.args.includes(flag));
 assert.equal(invocation.agent,paths.agent);for(const key of ['hasKey','hasParent','hasPreload','hasCodexHome'])assert.equal(invocation[key],false);
 delete process.env.NODE_OPTIONS;
 installed();assert.equal(calls().length,1,'qualified runtime is reused');assert.equal(fs.readFileSync(path.join(paths.agent,'auth.json'),'utf8'),'{}');
 assert.equal(fs.existsSync(path.join(paths.root,'setup.lock')),false);assert.equal(fs.existsSync(path.join(process.env.DRAKEN_DATA_DIR,'draken.db')),false);
 if(process.platform!=='win32'){assert.equal(fs.statSync(paths.agent).mode&0o777,0o700);assert.equal(fs.statSync(paths.selected).mode&0o777,0o600);}
});

test('failed installation and package mismatch leave credentials intact, no selection and no stale staging lock',()=>{
 const paths=piPaths();fs.mkdirSync(paths.agent,{recursive:true});fs.writeFileSync(path.join(paths.agent,'auth.json'),'synthetic existing private credential');
 for(const control of [{fail:true},{badVersion:true}]){
  fs.writeFileSync(path.join(root,'control.json'),JSON.stringify(control));const result=run('setup','--yes');assert.equal(result.status,1);assert.equal(fs.existsSync(paths.selected),false);assert.equal(fs.readFileSync(path.join(paths.agent,'auth.json'),'utf8'),'synthetic existing private credential');
  assert.equal(fs.existsSync(path.join(paths.root,'setup.lock')),false);assert.ok(!fs.readdirSync(paths.root).some(name=>name.startsWith('.install-')));
 }
 fs.writeFileSync(path.join(paths.root,'setup.lock'),'synthetic lock');assert.match(run('setup','--yes').stderr,/already running or was interrupted/);assert.equal(calls().length,2);
});

test('explicit and PATH pi are preserved; selected private failure cannot silently fall back',async()=>{
 const external=path.join(root,'bin/pi');fs.copyFileSync(path.join(__dirname,'fixtures/fake-pi.cjs'),external);fs.chmodSync(external,0o700);
 assert.equal(selectedPi().source,'external');assert.equal(selectedPi().binary,external);assert.equal((await piSetupStatus(true)).state,'configured');
 installed();assert.equal(selectedPi().source,'managed');process.env.DRAKEN_PI_BIN=external;assert.equal(selectedPi().source,'external');delete process.env.DRAKEN_PI_BIN;
 const selected=selectedPi();fs.unlinkSync(selected.prefix[0]);assert.throws(()=>selectedPi(),/incomplete/);assert.equal((await piSetupStatus(true)).state,'error');
 await assert.rejects(invokePi('Synthetic',{system:'Synthetic'}),/No other runtime was substituted/);
});

test('cancelled install terminates its owned child and releases staging without selecting a runtime',async()=>{
 fs.writeFileSync(path.join(root,'control.json'),JSON.stringify({delay:10000}));
 const child=spawn(process.execPath,[cli,'setup','--yes'],{env:process.env,cwd:root,stdio:'ignore'}),exited=new Promise(resolve=>child.once('exit',resolve));
 try {
  for(let n=0;n<100&&!calls().length;n++)await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(calls().length,1);const npmPid=calls()[0].pid;child.kill('SIGTERM');assert.equal(await exited,1);
  assert.throws(()=>process.kill(npmPid,0),error=>error.code==='ESRCH');const paths=piPaths();assert.equal(fs.existsSync(paths.selected),false);assert.equal(fs.existsSync(path.join(paths.root,'setup.lock')),false);assert.ok(!fs.readdirSync(paths.root).some(name=>name.startsWith('.install-')));
 } finally { if(child.exitCode===null){child.kill('SIGTERM');await exited;} }
});

test('private directory escapes and malformed selections fail visibly',()=>{
 const paths=piPaths(),outside=path.join(root,'outside');fs.mkdirSync(outside);fs.mkdirSync(paths.root,{recursive:true});fs.symlinkSync(outside,paths.agent,'dir');
 assert.equal(run('setup','--yes').status,1);assert.equal(fs.readdirSync(outside).length,0);assert.equal(calls().length,0);
 fs.unlinkSync(paths.agent);installed();const outsideAuth=path.join(outside,'auth.json');fs.writeFileSync(outsideAuth,'synthetic global credential');fs.symlinkSync(outsideAuth,path.join(paths.agent,'auth.json'));assert.throws(()=>selectedPi(),/must not be symlinks/);assert.equal(fs.readFileSync(outsideAuth,'utf8'),'synthetic global credential');fs.unlinkSync(path.join(paths.agent,'auth.json'));
 fs.writeFileSync(paths.selected,JSON.stringify({version:1,runtime:'../../outside'}));assert.throws(()=>selectedPi(),/Invalid private pi selection/);
});

test('setup status is authenticated, coalesced, secret-free; missing pi blocks combined sync before scanning or freezing',async()=>{
 const db=getDb(),server=require('../dist/server').createApp().listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const url=`http://127.0.0.1:${server.address().port}/api`;
 try{
  const pending=Array.from({length:12},()=>piSetupStatus(true));for(const value of pending)assert.equal(value,pending[0]);await Promise.all(pending);
  const response=await fetch(url+'/setup');assert.equal(response.status,200);assert.equal((await response.json()).pi.state,'missing');
  const blocked=await fetch(url+'/syncs/start-call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:require('crypto').randomUUID()})});assert.equal(blocked.status,503);
  for(const table of ['agent_sessions','agent_entries','syncs','sync_items','sync_runs','sync_coverage'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal((await fetch(url+'/setup?refresh=anything')).status,400);
  assert.equal((await fetch(url+'/setup',{headers:{Origin:'http://other.invalid'}})).status,403);
  Object.assign(process.env,{DRAKEN_NO_AUTH:'false',DRAKEN_USERNAME:'synthetic',DRAKEN_PASSWORD:'synthetic',DRAKEN_JWT_SECRET:'synthetic-test-only-not-a-real-secret'});
  assert.equal((await fetch(url+'/setup')).status,401);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('start prints first-run instructions; status confirms the server; duplicate launch never opens a database',async()=>{
 const n=await port(),env={...process.env,DRAKEN_PORT:String(n)},child=spawn(process.execPath,[cli],{env,cwd:root,stdio:['ignore','pipe','pipe']});let text='',error='';child.stdout.on('data',part=>text+=part);child.stderr.on('data',part=>error+=part);const exited=new Promise(resolve=>child.once('exit',resolve));
 try{
  for(let count=0;count<100&&!text.includes('Draken sync running at');count++){if(child.exitCode!==null)throw Error(error);await new Promise(resolve=>setTimeout(resolve,50));}
  assert.match(text,/draken setup → draken login/);assert.match(text,/Ctrl\+C/);assert.match(text,/draken voice login/);assert.deepEqual(calls(),[]);
  const status=spawnSync(process.execPath,[cli,'status'],{env,cwd:root,encoding:'utf8',timeout:10000});assert.equal(status.status,0,status.stderr);assert.match(status.stdout,/Draken is responding/);
  const other=path.join(root,'duplicate-state'),duplicate=spawnSync(process.execPath,[cli],{env:{...env,DRAKEN_DATA_DIR:other},cwd:root,encoding:'utf8',timeout:10000});assert.equal(duplicate.status,1);assert.match(duplicate.stderr,/already in use/);assert.equal(fs.existsSync(other),false);
 }finally{child.kill('SIGTERM');await exited;}
});
