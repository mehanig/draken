// Run only on a real macOS/Windows desktop. No provider, server, source or mic use.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {nativeTray}=require('../dist/tray/native');
async function main(){
 if(!['darwin','win32'].includes(process.platform))throw Error('Native tray qualification requires macOS or Windows; not qualified on this host.');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-native-tray-')),file=path.join(root,'state.json');let helper;
 const write=(phase,quit=false)=>{const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify({version:1,updated:Date.now(),phase,title:'Draken — '+phase,detail:'Native helper qualification — no server',canOpen:false,canStart:false,canStop:false,owned:false,quit}),{mode:0o600});fs.renameSync(temp,file);};
 try{
  write('starting');let unexpected=[];helper=nativeTray(file,action=>unexpected.push(action));let exited=false;void helper.exited.then(()=>exited=true);await helper.ready;
  for(const phase of ['running','stopped','error','stopping']){write(phase);await new Promise(resolve=>setTimeout(resolve,650));assert.equal(exited,false,'helper must survive status updates');}
  write('stopped',true);await Promise.race([helper.exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('helper did not exit gracefully')),4000);timer.unref();})]);
  assert.deepEqual(unexpected,[]);console.log(JSON.stringify({nativeHelperStarted:true,statusUpdates:true,gracefulExit:true,platform:process.platform,arch:process.arch,physicalMenuClicksVerified:false,providerCalls:0},null,2));
 }finally{write('stopped',true);await helper?.close();fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1});
