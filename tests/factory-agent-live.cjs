// Opt-in Docker integration: deterministic SDK fixture, no provider calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {workflowLocation}=require('../dist/factory/location'),{sessionPlan}=require('../dist/factory-enrichment');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 process.umask(0o077);const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-agent-live-')),repo=path.join(root,'repo'),sdk=path.join(root,'sdk');console.log('Receipts:',root);
 fs.mkdirSync(repo);fs.mkdirSync(path.join(repo,'.draken'));fs.mkdirSync(path.join(sdk,'dist'),{recursive:true});
 fs.writeFileSync(path.join(sdk,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.4.0',type:'module'}));fs.copyFileSync('tests/fixtures/factory-agent-sdk.mjs',path.join(sdk,'dist/index.js'));
 const image=JSON.parse(process.env.DRAKEN_WORKSPACE_ALLOWED_IMAGES)[0];fs.writeFileSync(path.join(repo,'.draken/environment.json'),JSON.stringify({schema:1,image,setup:[],checks:[{name:'Check',argv:['node','verify.cjs']}]}));fs.writeFileSync(path.join(repo,'verify.cjs'),'require("node:assert/strict").equal(2+2,4)');
 const git=(...a)=>cp.execFileSync('git',['-C',repo,...a],{encoding:'utf8'});git('init','-q');git('-c','user.name=Fixture','-c','user.email=fixture@localhost','add','.');git('-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-qm','Fixture');
 const location=workflowLocation(repo).key,workflow={id:'fixture',revision:'1',locationKey:location,purpose:'Fixture lifecycle',appliesWhen:'Testing host control',method:['Inspect','Edit','Test'],limitations:['Deterministic SDK fixture, not a paid model proof']};
 const env={...process.env,DRAKEN_FACTORY_PI_SDK:path.join(sdk,'dist/index.js'),DRAKEN_FACTORY_AGENT_MODEL:'fixture/test',DRAKEN_PI_BIN:'/not-called'};delete env.DRAKEN_WORKSPACE_LOCATION_KEY;
 const docker=(args,input)=>cp.execFileSync(env.DRAKEN_DOCKER_BIN,args,{env:{...env,DOCKER_HOST:env.DRAKEN_DOCKER_HOST},input,encoding:'utf8',timeout:30000});
 function start(name,task,maxCalls){const brief=path.join(root,name+'.json'),out=path.join(root,name);fs.writeFileSync(brief,JSON.stringify({plan:sessionPlan(workflow,task,location,maxCalls),authorization:{kind:'operator'}}));const child=cp.spawn(process.execPath,['scripts/factory-workspace.cjs',repo,'HEAD',out,brief],{env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);const done=new Promise(resolve=>child.on('close',code=>{fs.writeFileSync(out+'.log',log);resolve(code);}));return {child,done,out};}
 const limited=start('allowance','fixture-budget',1);assert.equal(await limited.done,1);const budget=JSON.parse(fs.readFileSync(path.join(limited.out,'result.json')));assert.equal(budget.modelCalls,1);assert.match(budget.detail,/allowance/);assert.equal(budget.accountingComplete,true);
 const weakened=start('protected','fixture-weaken-check',2);assert.equal(await weakened.done,1);assert.match(JSON.parse(fs.readFileSync(path.join(weakened.out,'result.json'))).detail,/protected check/);assert.equal(fs.existsSync(path.join(weakened.out,'verification.json')),false);
 const verified=start('verified','fixture-verify',2);assert.equal(await verified.done,0);assert.equal(JSON.parse(fs.readFileSync(path.join(verified.out,'verification.json'))).scope,'frozen-repository-checks');
 const cancelled=start('cancel','fixture-cancel',2);try{
  for(let i=0;;i++){if(i>180)throw Error('Agent did not reach long command');const progress=path.join(cancelled.out,'events.jsonl');if(fs.existsSync(progress)&&fs.readFileSync(progress,'utf8').includes('long-command'))break;await sleep(500);}
  const resources=JSON.parse(fs.readFileSync(path.join(cancelled.out,'resources.json'))),container=resources.container;
  const tool=request=>JSON.parse(docker(['exec','-i',container,'node','/factory/tool.cjs'],JSON.stringify(request)));
  assert.equal(tool({op:'read',path:'/etc/passwd'}).ok,false);assert.equal(tool({op:'read',path:'../repo/../../etc/passwd'}).ok,false);
  assert.equal(tool({op:'mkdir',path:'new parent'}).ok,true);assert.equal(tool({op:'write',path:'new parent/$(touch HOST).txt',text:'literal'}).ok,true);assert.equal(Buffer.from(tool({op:'read',path:'new parent/$(touch HOST).txt'}).value.base64,'base64').toString(),'literal');
  assert.equal(tool({op:'bash',command:'ln -s /tmp/missing dangling'}).ok,true);assert.equal(tool({op:'write',path:'dangling',text:'no'}).ok,false);
  const environment=tool({op:'bash',command:'env'}).value.output;assert.doesNotMatch(environment,/DRAKEN_|PI_SESSION|API_KEY|AUTH_TOKEN/);
  const large=tool({op:'bash',command:'node -e "console.log(\'x\'.repeat(90000))"'});assert.ok(large.value.output.length<=40000);
  assert.match(tool({op:'bash',command:'sleep 5',timeoutMs:1000}).value.output,/timeout/);
  cancelled.child.kill('SIGTERM');assert.equal(await cancelled.done,1);
  const result=JSON.parse(fs.readFileSync(path.join(cancelled.out,'result.json')));assert.equal(result.status,'cancelled');assert.equal(result.modelCalls,1);assert.match(fs.readFileSync(path.join(cancelled.out,'changes.patch'),'utf8'),/retained before cancellation/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cancelled.out,'export-container.json'))).Mounts[0].RW,false);
  assert.equal(docker(['ps','-aq','--filter','label=draken.factory.run='+resources.prefix]).trim(),'');
  assert.equal(fs.existsSync(path.join(repo,'cancelled.txt')),false);assert.equal(git('status','--porcelain'),'');console.log('Passed: allowance, container-only tools, cancellation, read-only patch collection, unchanged host checkout.');
 }finally{if(cancelled.child.exitCode===null)cancelled.child.kill('SIGTERM');}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
