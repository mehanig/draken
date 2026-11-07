const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {npmCli}=require('../dist/npm-cli');

test('npm resolution runs JS under current Node, never the command shim or shell text',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"draken npm & quote'-"));
 try{
  const directory=path.join(root,'node_modules','npm','bin');fs.mkdirSync(directory,{recursive:true});
  const cli=path.join(directory,'npm-cli.js');fs.writeFileSync(cli,'console.log(JSON.stringify(process.argv.slice(2)))');
  fs.writeFileSync(path.join(root,'npm.cmd'),'THIS SHIM MUST NEVER EXECUTE');
  const found=npmCli({PATH:root,npm_execpath:path.join(root,'npm.cmd')},path.join(root,'elsewhere','node.exe'));
  assert.equal(found,cli);
  const args=['install','space & semicolon; literal','quote\'s'];
  assert.deepEqual(JSON.parse(execFileSync(process.execPath,[found,...args],{encoding:'utf8',shell:false})),args);
  assert.throws(()=>npmCli({PATH:''},path.join(root,'missing','node.exe')),/npm was not found/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Windows voice owns the official native exe; private profile and credentials do not leak',async()=>{
 const {codexExecutable,helperEnvironment}=await import('../voice/realtime/native.mjs');
 for(const [arch,target] of [['x64','x86_64'],['arm64','aarch64']]){
  const executable=codexExecutable('/private','win32',arch);
  assert.equal(executable,path.join('/private','runtime','node_modules','@openai','codex-win32-'+arch,'vendor',target+'-pc-windows-msvc','bin','codex.exe'));
  assert.doesNotMatch(executable,/\.cmd$|\.bin/);
 }
 assert.throws(()=>codexExecutable('/private','win32','ia32'),/x64 or arm64/);
 const env=helperEnvironment('/private/account',{PATH:'/bin',USERPROFILE:'/global',APPDATA:'/global/data',OPENAI_API_KEY:'secret',NODE_OPTIONS:'--untrusted'});
 assert.equal(env.USERPROFILE,'/private/account');assert.equal(env.HOME,env.USERPROFILE);
 assert.equal(env.APPDATA,path.join('/private/account','AppData','Roaming'));
 assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.NODE_OPTIONS,undefined);
});
