// Explicit real Docker proof: edits survive stages and cancellation, without host writes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process');
async function main(){
 const base=JSON.parse(process.env.DRAKEN_WORKSPACE_ALLOWED_IMAGES||'[]')[0];if(!base)throw Error('Configure an approved image and rootless Docker');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-live-')),repo=path.join(dir,'repo');fs.mkdirSync(repo);
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
 git('init','-q');git('config','user.name','Workspace proof');git('config','user.email','proof@localhost');git('config','remote.origin.url','https://synthetic:credential@example.invalid/repo');
 fs.mkdirSync(path.join(repo,'.draken'));fs.writeFileSync(path.join(repo,'.gitignore'),'.env\n');fs.writeFileSync(path.join(repo,'source.txt'),'original');
 const environment={schema:1,image:base,setup:[{name:'Edit in workspace',argv:['node','-e',"require('fs').writeFileSync('source.txt','changed');require('fs').writeFileSync('new.txt','retained');"]}],checks:[{name:'Verify workspace and isolation',argv:['node','-e',`const fs=require('fs'),a=require('assert/strict'),cp=require('child_process');a.equal(fs.readFileSync('source.txt','utf8'),'changed');a.equal(fs.readFileSync('new.txt','utf8'),'retained');a.equal(process.getuid(),65532);a.equal(process.env.DRAKEN_PASSWORD,undefined);a.equal(fs.existsSync('/var/run/docker.sock'),false);a.equal(fs.existsSync(${JSON.stringify(path.join(repo,'.env'))}),false);a.equal(cp.execFileSync('git',['remote'],{encoding:'utf8'}).trim(),'');a.throws(()=>fs.writeFileSync('/factory/worker.cjs','overwrite'));`]}]};
 const declaration=()=>fs.writeFileSync(path.join(repo,'.draken/environment.json'),JSON.stringify(environment));
 const commit=()=>{git('add','.');git('commit','-qm','Workspace proof');};declaration();commit();fs.writeFileSync(path.join(repo,'.env'),'HOST_ONLY_SYNTHETIC_SECRET');
 const start=name=>{const output=path.join(dir,name),log=fs.openSync(path.join(dir,name+'.log'),'w');const child=spawn(process.execPath,[path.resolve('scripts/factory-workspace.cjs'),repo,'HEAD',output],{env:{...process.env,DRAKEN_WORKSPACE_PROPOSE:'false'},stdio:['ignore',log,log]});fs.closeSync(log);const done=new Promise(resolve=>child.on('close',resolve));return {output,child,done};};
 const first=start('completed');assert.equal(await first.done,0,fs.readFileSync(path.join(dir,'completed.log'),'utf8'));
 assert.equal(fs.readFileSync(path.join(repo,'source.txt'),'utf8'),'original');assert.equal(fs.existsSync(path.join(repo,'new.txt')),false);
 assert.match(fs.readFileSync(path.join(first.output,'changes.patch'),'utf8'),/\+changed/);assert.match(fs.readFileSync(path.join(first.output,'changes.patch'),'utf8'),/\+retained/);
 const collector=JSON.parse(fs.readFileSync(path.join(first.output,'export-container.json')));assert.equal(collector.HostConfig.NetworkMode,'none');assert.equal(collector.Mounts[0].RW,false);
 environment.checks=[{name:'Wait for cancellation',argv:['node','-e','setInterval(()=>{},1000)']}];declaration();commit();
 const second=start('cancelled');let started=false;
 for(let i=0;i<600;i++){const progress=path.join(second.output,'progress.jsonl');if(fs.existsSync(progress)&&fs.readFileSync(progress,'utf8').includes('Wait for cancellation')){started=true;break;}if(second.child.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}
 if(!started){second.child.kill('SIGTERM');await second.done;throw Error('Cancellation test did not start; see '+dir);}
 second.child.kill('SIGTERM');await second.done;const result=JSON.parse(fs.readFileSync(path.join(second.output,'result.json')));assert.equal(result.status,'cancelled',JSON.stringify(result));assert.match(fs.readFileSync(path.join(second.output,'changes.patch'),'utf8'),/\+changed/);
 console.log(JSON.stringify({directory:dir,workspacePersistence:true,hostUnchanged:true,credentialsExcluded:true,readOnlyPatchCollector:true,cancelledChangesRetained:true}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
