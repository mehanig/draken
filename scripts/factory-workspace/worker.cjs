// Trusted image entry point. Repository commands run only in this container.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
function command(argv,cwd,input){return new Promise(resolve=>{
 const child=spawn(argv[0],argv.slice(1),{cwd,detached:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0'},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='',reason='';const stop=why=>{reason=why;try{process.kill(-child.pid,'SIGKILL');}catch{}};
 const timer=setTimeout(()=>stop('Command exceeded four minutes'),240000);
 child.stdout.on('data',v=>{stdout+=v;if(stdout.length>2_000_000)stop('Command output limit reached');});child.stderr.on('data',v=>{stderr+=v;if(stderr.length>2_000_000)stop('Command output limit reached');});
 child.stdin.on('error',()=>{});child.stdin.end(input);
 child.on('error',error=>{clearTimeout(timer);resolve({code:1,stdout,stderr: error.message});});
 child.on('close',code=>{clearTimeout(timer);resolve({code:code??1,stdout:stdout.slice(0,2_000_000),stderr:stderr.slice(0,2_000_000),reason});});
});}
async function checked(argv,cwd,input){const result=await command(argv,cwd,input);if(result.code!==0)throw Error(`${argv[0]} failed: ${result.stderr||result.reason}`);return result.stdout;}
async function main(request){
 const root=request.exportOnly?'/tmp/baseline':'/workspace/repo';fs.mkdirSync(root,{recursive:true});fs.mkdirSync('/tmp/home',{recursive:true});
 if(request.mode!=='checks'){
 if(!request.exportOnly)emit({type:'stage-started',name:'Check out repository'});
 await checked(['git','init','--quiet',`--object-format=${request.objectFormat}`,root],'/workspace');
 await checked(['git','index-pack','--stdin'],root,Buffer.from(request.pack,'base64'));
 fs.writeFileSync(path.join(root,'.git/shallow'),request.commit+'\n');
 await checked(['git','update-ref','refs/heads/factory-task',request.commit],root);
 await checked(['git','symbolic-ref','HEAD','refs/heads/factory-task'],root);
 await checked(['git','-c','core.hooksPath=/dev/null','checkout','--force','HEAD'],root);
 const head=(await checked(['git','rev-parse','HEAD'],root)).trim();if(head!==request.commit)throw Error('Checkout commit differs from the requested snapshot');
 await checked(['git','config','user.name','Draken Factory'],root);await checked(['git','config','user.email','factory@localhost'],root);
 if(request.candidatePatch)await checked(['git','-c','core.hooksPath=/dev/null','apply','--binary','-'],root,request.candidatePatch);
 if(!request.exportOnly)emit({type:'stage-result',name:'Check out repository',code:0,commit:head});
 }
 if(request.exportOnly){
  const git=['git','--git-dir='+root+'/.git','--work-tree=/workspace/repo','-c','core.hooksPath=/dev/null'];
  await checked([...git,'add','--all'],root);
  const patch=await checked([...git,'diff','--cached','--binary',request.commit,'--'],root);
  const names=(await checked([...git,'-c','diff.renames=false','diff','--cached','--name-status','-z',request.commit,'--'],root)).split('\0').filter(Boolean),files=[];
  for(let i=0;i<names.length;i+=2)files.push({status:names[i],file:names[i+1]});
  emit({type:'patch',base:request.commit,patch,files});return;
 }
 let failed=false;
 {
  for(const phase of (request.mode==='prepare'?['setup']:request.mode==='checks'?['checks']:['setup','checks'])){ for(const original of request.environment[phase]){
   const step={...original,name:(request.label?request.label+' · ':'')+original.name};
   const cwd=fs.realpathSync(path.resolve(root,step.cwd||'.'));if(cwd!==root&&!cwd.startsWith(root+'/'))throw Error('Command directory escapes checkout');
   emit({type:'stage-started',name:step.name,phase});
   const result=await command(step.argv,cwd);emit({type:'stage-result',name:step.name,phase,...result});
   if(result.code!==0||result.reason){failed=true;break;}
  }
  if(failed)break;
  }
 }
 emit({type:'result',status:failed?'failed':'completed',commit:request.commit});
 if(failed)process.exitCode=1;
}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{input+=part;if(input.length>180_000_000)process.exit(2);});
process.stdin.on('end',()=>main(JSON.parse(input)).catch(error=>{emit({type:'error',message:error.message});process.exitCode=1;}));
