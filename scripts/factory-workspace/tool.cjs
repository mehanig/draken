// Runs only inside the owned container. No host paths, credentials or Docker access.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root='/workspace/repo';
function target(value,create=false,base=root){
 if(typeof value!=='string'||value.includes('\0'))throw Error('Invalid workspace path');
 const resolved=path.resolve(base,value);
 if(resolved!==base&&!resolved.startsWith(base+'/'))throw Error('Path must stay in /workspace/repo');
 let existing=resolved;while(true){try{fs.lstatSync(existing);break;}catch(error){if(error.code!=='ENOENT'||!create)throw error;existing=path.dirname(existing);}}
 const real=fs.realpathSync(existing);if(real!==base&&!real.startsWith(base+'/'))throw Error('Symlink leaves workspace');
 if(fs.lstatSync(existing).isSymbolicLink())throw Error('Symlink target is not permitted');
 return resolved;
}
async function execute(r){
 if(r.op==='bash'){
  if(typeof r.command!=='string'||r.command.length>32000||r.command.includes('\0'))throw Error('Invalid command');
  return new Promise(resolve=>{
   const child=spawn('/bin/bash',['--noprofile','--norc','-c',r.command],{cwd:root,detached:true,env:{PATH:process.env.PATH,HOME:'/tmp/home',npm_config_registry:process.env.npm_config_registry,GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']});
   let output='',bytes=0,reason='';const stop=why=>{reason=why;try{process.kill(-child.pid,'SIGKILL');}catch{}};
   const timer=setTimeout(()=>stop('Command timeout'),Math.min(240000,Math.max(1000,r.timeoutMs||240000)));
   const collect=b=>{bytes+=b.length;if(bytes>1000000)stop('Command output exceeded 1 MB');else output+=b.toString();};child.stdout.on('data',collect);child.stderr.on('data',collect);
   child.on('error',e=>{clearTimeout(timer);resolve({code:1,output:e.message});});child.on('close',code=>{clearTimeout(timer);resolve({code:reason?1:code??1,output:output.slice(-40000)+(reason?'\n'+reason:'')});});
  });
 }
 const file=target(r.path,['write','mkdir'].includes(r.op));
 if(r.op==='read'){const stat=fs.statSync(file);if(!stat.isFile())throw Error('Read requires a regular file');if(stat.size>1000000)throw Error('File exceeds 1 MB');return {base64:fs.readFileSync(file).toString('base64')};}
 if(r.op==='access'){fs.accessSync(file,fs.constants.R_OK);return {};}
 if(r.op==='mkdir'){fs.mkdirSync(file,{recursive:true});return {};}
 if(r.op==='write'){if(fs.existsSync(file)&&!fs.statSync(file).isFile())throw Error('Write requires a regular file');if(typeof r.text!=='string'||Buffer.byteLength(r.text)>1000000)throw Error('File exceeds 1 MB');fs.writeFileSync(file,r.text);return {};}
 throw Error('Unknown workspace operation');
}
module.exports={execute,target};
if(require.main===module){let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>{text+=v;if(text.length>2000000)process.exit(2);});process.stdin.on('end',()=>Promise.resolve().then(()=>execute(JSON.parse(text))).then(value=>console.log(JSON.stringify({ok:true,value}))).catch(e=>{console.log(JSON.stringify({ok:false,error:e.message}));}));}
