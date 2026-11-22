const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url');
const {sessionPlan}=require('../dist/factory-enrichment'),fixtureEnrichment=require('./fixtures/workflow-enrichment.cjs');
const {createTools,runAgent}=require('../scripts/factory-workspace/agent.cjs');
const {target}=require('../scripts/factory-workspace/tool.cjs');
const workflow={id:'workflow',revision:'1',locationKey:'repo',purpose:'Fix a bug',appliesWhen:'Reproducible bug',method:['Reproduce','Edit','Test and repair'],limitations:[]};
test('whole-workflow plan retains every step without fabricating a one-step discovery',()=>{
 const plan=sessionPlan(workflow,'Fix the issue','repo',fixtureEnrichment(workflow),8);assert.deepEqual(plan.workflow.method,workflow.method);assert.equal(Object.hasOwn(plan.policy,'publication'),false);
 plan.workflow.method[0]='changed';assert.equal(workflow.method[0],'Reproduce');
 assert.throws(()=>sessionPlan(workflow,'Fix','other'),/scope/);assert.throws(()=>sessionPlan(workflow,'Fix','repo',fixtureEnrichment(workflow),0),/allowance/);
});
test('container file paths reject traversal, outside symlinks and dangling symlinks',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-path-')),root=path.join(dir,'repo');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'a'),'source');
 try{assert.equal(target('a',false,root),path.join(root,'a'));assert.throws(()=>target('../secret',true,root),/stay/);fs.symlinkSync(dir,path.join(root,'outside'));assert.throws(()=>target('outside/private',true,root),/leaves/);
 fs.symlinkSync(path.join(dir,'missing'),path.join(root,'dangling'));assert.throws(()=>target('dangling',true,root));assert.equal(fs.existsSync(path.join(dir,'missing')),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('all four tools delegate operations, serialize mutations, and refuse revoked or cancelled work',async()=>{
 const sdk=await import(pathToFileURL(path.resolve('tests/fixtures/factory-agent-sdk.mjs'))),calls=[],controller=new AbortController();let allowed=true,active=0,maximum=0;
 const tools=createTools(sdk,async r=>{maximum=Math.max(maximum,++active);calls.push(r);await new Promise(r=>setTimeout(r,5));active--;return r.op==='read'?{base64:Buffer.from('old').toString('base64')}:{output:'guest output',code:1};},async()=>{if(!allowed)throw Error('Revoked');},controller.signal);
 await Promise.all(tools.filter(t=>t.name!=='bash').map(t=>t.execute('1',{path:'/workspace/repo/a',content:'new'},controller.signal)));
 assert.equal(maximum,1);assert.ok(calls.some(c=>c.op==='write'));const bash=tools.find(t=>t.name==='bash');const result=await bash.execute('2',{command:'pwd'},controller.signal);assert.equal(result.isError,true);assert.equal(calls.at(-1).command,'pwd');
 const count=calls.length;allowed=false;await assert.rejects(bash.execute('3',{command:'touch HOST'},controller.signal),/Revoked/);assert.equal(calls.length,count);controller.abort();await assert.rejects(bash.execute('4',{command:'pwd'},controller.signal));assert.equal(calls.length,count);
});
async function sdkFixture(fn){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdk-')),prior={...process.env};fs.mkdirSync(path.join(dir,'dist'));fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({type:'module',name:'@earendil-works/pi-coding-agent',version:'1.4.0'}));fs.copyFileSync('tests/fixtures/factory-agent-sdk.mjs',path.join(dir,'dist/index.js'));
 Object.assign(process.env,{DRAKEN_FACTORY_PI_SDK:path.join(dir,'dist/index.js'),DRAKEN_PI_FINAL_MODEL:'fixture/test',DRAKEN_FACTORY_AGENT_MODEL:'obsolete/ignored',DRAKEN_PI_BIN:'/not-called'});
 try{assert.equal(require('../scripts/factory-workspace/agent.cjs').sdkConfiguration().model,'fixture/test');await fn(dir);}finally{for(const k of Object.keys(process.env))if(!(k in prior))delete process.env[k];Object.assign(process.env,prior);fs.rmSync(dir,{recursive:true,force:true});}
}
test('provider requests are durably reserved before dispatch and stop at the invocation allowance',async()=>sdkFixture(async dir=>{
 const output=path.join(dir,'run'),controller=new AbortController();
 await assert.rejects(runAgent({directory:output,brief:{...sessionPlan(workflow,'Fix','repo',fixtureEnrichment(workflow),1),repository:dir,locationKey:'repo',commit:'base'},invoke:async()=>{throw Error('Unexpected tool');},authorize:async()=>{},signal:controller.signal,record:()=>{},maxCalls:1}),/allowance/);
 assert.equal(fs.readFileSync(path.join(output,'fixture-provider-calls'),'utf8'),'call\n');const entries=fs.readFileSync(path.join(output,'accounting.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(entries.map(e=>e.type),['request','response']);assert.equal(entries[0].call,1);assert.equal(JSON.parse(fs.readFileSync(path.join(output,'result.json'))).modelCalls,1);
}));
test('one session accounts for all requests and source failure prevents subsequent provider work',async()=>sdkFixture(async dir=>{
 const common={brief:{...sessionPlan(workflow,'Fix','repo',fixtureEnrichment(workflow),2),repository:dir,locationKey:'repo',commit:'base'},invoke:async()=>{},signal:new AbortController().signal,record:()=>{},maxCalls:2};
 const result=await runAgent({...common,directory:path.join(dir,'success'),authorize:async()=>{}});assert.equal(result.modelCalls,2);assert.equal(result.completedCalls,2);assert.equal(result.accountingComplete,true);assert.equal(result.sessionId,'fixture-session');const enriched=JSON.parse(fs.readFileSync(path.join(dir,'success/enrichment.json')));assert.deepEqual(enriched,common.brief.enrichment);assert.equal(enriched.guidance.steps.length,3);assert.ok(enriched.requirements.some(s=>s.includes('repair and retest')));
 const failed=path.join(dir,'revoked');await assert.rejects(runAgent({...common,directory:failed,authorize:async()=>{if(fs.existsSync(path.join(failed,'fixture-provider-calls')))throw Error('Source revoked');}}),/revoked/);assert.equal(fs.readFileSync(path.join(failed,'fixture-provider-calls'),'utf8'),'call\n');
}));
test('blocked endpoint remains blocked with confirmed usage',async()=>sdkFixture(async dir=>{
 const result=await runAgent({directory:path.join(dir,'blocked'),brief:{...sessionPlan(workflow,'fixture-blocked','repo',fixtureEnrichment(workflow),2),repository:dir,locationKey:'repo',commit:'base'},invoke:async()=>{},authorize:async()=>{},signal:new AbortController().signal,record:()=>{},maxCalls:2});assert.equal(result.status,'blocked');assert.equal(result.accountingComplete,true);assert.match(result.summary,/credential/);
}));
test('execution ownership is shared between profiles and interrupted workspace resources block starts',()=>{
 const {claimFactoryExecution}=require('../dist/factory/execution-owner'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-owner-')),prior=process.env.DRAKEN_DATA_DIR;process.env.DRAKEN_DATA_DIR=dir;
 try{const release=claimFactoryExecution('one');assert.throws(()=>claimFactoryExecution('two'),/active/);release();const next=claimFactoryExecution('two');next();for(const folder of ['factory-workspaces','factory-runs']){const run=path.join(dir,folder,'12345678-1234-4234-8234-123456789abc');fs.mkdirSync(path.join(run,'work'),{recursive:true});for(const file of ['request.json','exit.json','work/resources.json'])fs.writeFileSync(path.join(run,file),'{}');assert.throws(()=>claimFactoryExecution('three'),/inspection/);fs.writeFileSync(path.join(run,'work/cleanup.json'),'{"completed":true}');const release=claimFactoryExecution('cleaned');release();fs.writeFileSync(path.join(run,'work/result.json'),'{"status":"blocked"}');const afterBlocked=claimFactoryExecution('after-blocked');afterBlocked();}}
 finally{if(prior===undefined)delete process.env.DRAKEN_DATA_DIR;else process.env.DRAKEN_DATA_DIR=prior;fs.rmSync(dir,{recursive:true,force:true});}
});
