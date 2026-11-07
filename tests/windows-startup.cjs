// CI diagnosis only: fixed local PowerShell output, never source/provider access.
const {spawn}=require('node:child_process'),path=require('node:path');
async function probe(name,env,args){
 const start=Date.now(),file=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
 await new Promise(resolve=>{let output='',error='';const child=spawn(file,['-NoLogo','-NoProfile','-NonInteractive',...args],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);
 const timer=setTimeout(()=>child.kill(),35000);
 child.once('error',()=>{});child.once('close',code=>{clearTimeout(timer);console.log(JSON.stringify({name,elapsed:Date.now()-start,code,ready:output.includes('draken-startup'),diagnostic:error.slice(-800)}));resolve();});});
}
(async()=>{
 if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true')throw Error('This diagnostic runs only in Windows CI.');
 const env={};for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','LANG','PATH'])if(process.env[key])env[key]=process.env[key];
 const code="[Console]::Out.WriteLine('draken-startup')",encoded=Buffer.from(code,'utf16le').toString('base64');
 await probe('inherited-plain',process.env,['-Command',code]);
 await probe('allowlist-plain',env,['-Command',code]);
 await probe('allowlist-encoded',env,['-STA','-WindowStyle','Hidden','-EncodedCommand',encoded]);
})().catch(error=>{console.error(error);process.exitCode=1;});
