// Fresh production-only npm install and loopback lifecycle smoke; no accounts,
// histories, providers, model downloads, native desktop or microphone access.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const net=require('node:net');
const {npmCli}=require('../dist/npm-cli');
process.umask(0o077);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-package-smoke-')),home=path.join(root,'home'),install=path.join(root,'install'),state=path.join(root,'state');
fs.mkdirSync(home);fs.mkdirSync(install);let child;
const env={};for(const key of ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),DRAKEN_DATA_DIR:state,DRAKEN_PI_BIN:path.join(root,'no-pi'),DRAKEN_HOST:'127.0.0.1',DRAKEN_PORT:'0',DRAKEN_NO_AUTH:'true'});
const npm=npmCli(),run=(args,cwd=process.cwd())=>execFileSync(process.execPath,[npm,...args],{cwd,env,encoding:'utf8',timeout:300000,maxBuffer:4*1024*1024});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const [packed]=JSON.parse(run(['pack','--json','--ignore-scripts','--pack-destination',root]));
 const files=packed.files.map(file=>file.path);
 for(const file of files)assert.doesNotMatch(file,/(^|\/)(?:auth\.json|server-state\.json|\.env|node_modules|\.git)(?:\/|$)|\.(?:sqlite|db|jsonl|pem|key|log)$/i);
 for(const file of ['dist/cli.js','dist/npm-cli.js','runtime/pi/package-lock.json','tray/windows.ps1','tray/macos.js','voice/realtime/native.mjs','public/persona/call-poster.webp','public/persona/chat-avatar.webp','dist/memory/reconcile.js','dist/sync/reconciliation.js','dist/sync/automatic.js','dist/sync/answer-references.js'])assert.ok(files.includes(file),file);
 run(['install','--omit=dev','--no-audit','--no-fund',path.join(root,packed.filename)],install);
 const audit=JSON.parse(run(['audit','--omit=dev','--json'],install));assert.equal(audit.metadata.vulnerabilities.total,0);
 const app=path.join(install,'node_modules','draken'),cli=path.join(app,'dist','cli.js');
 assert.equal(require(path.join(app,'package.json')).version,require('../package.json').version,'Installed tarball must match the release manifest');
 const command=args=>execFileSync(process.execPath,[cli,...args],{env,encoding:'utf8',timeout:15000});
 assert.equal(JSON.parse(command(['voice','status'])).readyForProbe,false);
 const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 env.DRAKEN_PORT=String(reservation.address().port);await new Promise(resolve=>reservation.close(resolve));
 child=spawn(process.execPath,[cli],{env,stdio:'ignore',shell:false});
 const exited=new Promise(resolve=>child.once('exit',resolve));let saved;
 for(let i=0;i<150;i++){
  try{saved=JSON.parse(fs.readFileSync(path.join(state,'server-state.json'),'utf8'));break;}catch{}
  if(child.exitCode!==null)throw Error('Packed server exited before readiness');await pause(100);
 }
 assert.ok(saved);const url=saved.http_url;
 assert.match(command(['status']),/Draken is responding/);
 assert.equal((await fetch(url)).status,200);
 assert.equal((await fetch(url+'/api/scan',{method:'POST',headers:{Origin:'https://elsewhere.invalid'}})).status,403);
 const setup=await(await fetch(url+'/api/setup')).json();assert.notEqual(setup.pi.state,'configured');
 child.kill('SIGTERM');await Promise.race([exited,pause(10000).then(()=>{throw Error('Packed server did not stop');})]);child=undefined;
 const Database=require(path.join(install,'node_modules','better-sqlite3')),db=new Database(path.join(state,'draken.db'),{readonly:true});
 try{for(const table of ['agent_sessions','syncs','live_calls'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);}finally{db.close();}
 assert.equal(fs.existsSync(path.join(state,'memory','model')),false);
 assert.equal(fs.existsSync(path.join(home,'.pi')),false);
 console.log(JSON.stringify({productionOnly:true,packageFiles:files.length,rootAuditFindings:0,canonicalActivityRows:0,realProviderCalls:0}));
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{
 if(child&&child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}
 fs.rmSync(root,{recursive:true,force:true});
});
