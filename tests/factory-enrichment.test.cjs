const {test}=require('node:test'),assert=require('node:assert/strict');
const {enrich,proposeEnrichment,runWorkflow,ENRICHMENT_PROMPT}=require('../dist/factory-enrichment');
function fixture(){
 const discovery={id:'source',revision:'source-v1',locationKey:'repo-a',purpose:'Repair a parser',appliesWhen:'Parser bug',method:['Reproduce','Fix'],limitations:['One example is incomplete']};
 const capabilities=[['input','check'],['prepare','action'],['reproduce','action'],['fix','action'],['verify','check'],['repair','repair'],['complete','check']].map(([id,kind])=>({id,kind,revision:'v1',description:id,effects:['local'],repeatable:true,...(['verify','repair'].includes(id)?{forActions:['reproduce','fix']}:{})}));
 const policy={id:'policy',revision:'v1',locationKey:'repo-a',discoveryRevision:'source-v1',endpoint:'Tested patch',inputCheck:'input',prepare:'prepare',completionCheck:'complete',allowedCapabilities:capabilities.map(c=>c.id),allowedEffects:['local'],maxAttempts:2,timeoutMs:5000};
 const configuration={inputCheck:'input',prepare:'prepare',completionCheck:'complete',bindings:[{step:1,action:'reproduce',verify:'verify'},{step:2,action:'fix',verify:'verify',repair:'repair'}]};
 const task={id:'task-1',locationKey:'repo-a',inputs:{request:'Fix escaped strings'}};
 const events=[],calls=[];let claims=0;
 const host={capabilities,claim:async()=>{if(claims++)throw Error('Duplicate task');},authorize:async()=>{},record:async event=>events.push(event),invoke:async(id,context)=>{calls.push([id,context]);return {ok:true,detail:'Checked',evidence:['test receipt']};}};
 return {discovery,capabilities,policy,configuration,task,host,events,calls,plan:()=>enrich(discovery,policy,configuration,capabilities)};
}
test('enrichment preserves discovery and separates Factory additions; missing steps cannot run',async()=>{
 const f=fixture(),original=structuredClone(f.discovery);f.configuration.bindings.pop();const plan=f.plan();
 assert.deepEqual(plan.discovery,original);assert.ok(plan.additions.includes('Verify every discovered step'));assert.equal(plan.ready,false);assert.match(plan.missing.join(),/Step 2/);
 await assert.rejects(runWorkflow(plan,f.task,f.host,new AbortController().signal),/incomplete/);assert.equal(f.calls.length,0);
});
test('different locations, unsupported effects and invented capability kinds are rejected',()=>{
 const f=fixture();assert.throws(()=>enrich(f.discovery,{...f.policy,locationKey:'repo-b'},f.configuration,f.capabilities),/Policy/);
 assert.throws(()=>enrich(f.discovery,{...f.policy,allowedEffects:[]},f.configuration,f.capabilities),/not permitted/);
 assert.throws(()=>enrich(f.discovery,f.policy,{...f.configuration,inputCheck:'fix'},f.capabilities),/lifecycle/);
 assert.throws(()=>enrich(f.discovery,f.policy,{...f.configuration,bindings:[f.configuration.bindings[0],f.configuration.bindings[0]]},f.capabilities),/duplicate/);
});
test('unavailable capabilities produce gaps, not executable shell text',()=>{const f=fixture();f.configuration.bindings[0].action='invented-shell';assert.equal(f.plan().ready,false);});
test('model enrichment uses supplied accounting callback once and checks source access before and after',async()=>{
 const f=fixture();let checks=0,calls=0;
 const plan=await proposeEnrichment(f.discovery,f.policy,f.capabilities,{assertCurrent:async()=>{checks++;},ask:async(payload,prompt)=>{calls++;assert.equal(prompt,ENRICHMENT_PROMPT);assert.deepEqual(payload.discovery,f.discovery);return JSON.stringify(f.configuration);}},new AbortController().signal);
 assert.equal(plan.ready,true);assert.equal(checks,2);assert.equal(calls,1);
});
test('source revocation during model inference rejects output without retry',async()=>{
 const f=fixture();let checks=0,calls=0;
 await assert.rejects(proposeEnrichment(f.discovery,f.policy,f.capabilities,{assertCurrent:async()=>{if(++checks===2)throw Error('Source revoked');},ask:async()=>{calls++;return JSON.stringify(f.configuration);}},new AbortController().signal),/revoked/);assert.equal(calls,1);
});
test('runner completes whole loop without manual transitions and records before actions',async()=>{
 const f=fixture();const invoke=f.host.invoke;f.host.invoke=async(id,context)=>{assert.equal(f.events.at(-1).type,'requested');return invoke(id,context);};
 const result=await runWorkflow(f.plan(),f.task,f.host,new AbortController().signal);assert.equal(result.status,'completed');
 assert.deepEqual(f.calls.map(([id])=>id),['input','prepare','reproduce','verify','fix','verify','complete']);assert.equal(f.events.at(-1).type,'completed');
 await assert.rejects(runWorkflow(f.plan(),f.task,f.host,new AbortController().signal),/Duplicate/);assert.equal(f.calls.length,7);
});
test('repair follows failed verification then repeats the action and verifies again',async()=>{
 const f=fixture();const invoke=f.host.invoke;
 f.host.invoke=async(id,c)=>id==='verify'&&c.step===2&&c.attempt===1?(f.calls.push([id,c]),{ok:false,detail:'Regression still fails',evidence:['failed test']}):invoke(id,c);
 assert.equal((await runWorkflow(f.plan(),f.task,f.host,new AbortController().signal)).status,'completed');
 assert.deepEqual(f.calls.map(([id])=>id),['input','prepare','reproduce','verify','fix','verify','repair','fix','verify','complete']);
});
test('failed repair and exhausted verification stop without delivery',async()=>{
 for(const failRepair of [true,false]){const f=fixture();const invoke=f.host.invoke;f.host.invoke=async(id,c)=>{if((id==='verify'&&c.step===2)||(id==='repair'&&failRepair)){f.calls.push([id,c]);return {ok:false,detail:'Still failing',evidence:['test']};}return invoke(id,c);};
 assert.equal((await runWorkflow(f.plan(),f.task,f.host,new AbortController().signal)).status,'failed');assert.ok(!f.calls.some(([id])=>id==='complete'));assert.ok(f.calls.filter(([id])=>id==='fix').length<=2);}
});
test('non-repeatable actions cannot have repair/replay loops',()=>{const f=fixture();f.capabilities.find(c=>c.id==='fix').repeatable=false;assert.throws(f.plan,/non-repeatable/);});
test('unknown action outcome stops rather than replaying',async()=>{const f=fixture();f.host.invoke=async()=>{throw Error('Connection lost');};assert.equal((await runWorkflow(f.plan(),f.task,f.host,new AbortController().signal)).status,'failed');assert.equal(f.events.filter(e=>e.type==='requested').length,1);});
test('completion needs an independent positive check and evidence',async()=>{
 for(const outcome of [{ok:false,detail:'Artifact missing',evidence:[]},{ok:true,detail:'Agent said done',evidence:[]}]){const f=fixture(),invoke=f.host.invoke;f.host.invoke=async(id,c)=>id==='complete'?outcome:invoke(id,c);assert.equal((await runWorkflow(f.plan(),f.task,f.host,new AbortController().signal)).status,'failed');}
});
test('source or policy changes during action prevent result acceptance and subsequent actions',async()=>{
 const f=fixture();let allowed=true;f.host.authorize=async()=>{if(!allowed)throw Error('Source or policy revoked');};f.host.invoke=async()=>{allowed=false;return {ok:true,detail:'done',evidence:['receipt']};};
 assert.equal((await runWorkflow(f.plan(),f.task,f.host,new AbortController().signal)).status,'failed');assert.equal(f.events.filter(e=>e.type==='result').length,0);
});
test('capability changes and mismatched target repositories cannot run',async()=>{
 const f=fixture(),plan=f.plan();f.capabilities[0].revision='v2';await assert.rejects(runWorkflow(plan,f.task,f.host,new AbortController().signal),/changed/);
 await assert.rejects(runWorkflow(f.plan(),{...f.task,locationKey:'repo-b'},f.host,new AbortController().signal),/repository/);assert.equal(f.calls.length,0);
});
test('late callback results after cancellation are not accepted',async()=>{
 const f=fixture(),controller=new AbortController();f.host.invoke=async()=>{controller.abort();return {ok:true,detail:'late',evidence:['receipt']};};
 assert.equal((await runWorkflow(f.plan(),f.task,f.host,controller.signal)).status,'cancelled');assert.equal(f.events.filter(e=>e.type==='result').length,0);
});
test('deadline reaches the host cancellation signal',async()=>{
 const f=fixture();f.policy.timeoutMs=20;f.host.invoke=async(_,__,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Stopped')),{once:true}));
 assert.equal((await runWorkflow(f.plan(),f.task,f.host,new AbortController().signal)).status,'cancelled');
});
test('recording failure prevents invocation and cannot claim completion',async()=>{const f=fixture();f.host.record=async()=>{throw Error('Disk full');};await assert.rejects(runWorkflow(f.plan(),f.task,f.host,new AbortController().signal),/Disk full/);assert.equal(f.calls.length,0);});
test('permission revoked while recording a request prevents the actual invocation',async()=>{
 const f=fixture();let allowed=true;f.host.authorize=async()=>{if(!allowed)throw Error('Revoked');};f.host.record=async event=>{f.events.push(event);if(event.type==='requested')allowed=false;};
 assert.equal((await runWorkflow(f.plan(),f.task,f.host,new AbortController().signal)).status,'failed');assert.equal(f.calls.length,0);
});
test('capability revisions are checked again within a run',async()=>{
 const f=fixture(),invoke=f.host.invoke;f.host.invoke=async(id,context)=>{const result=await invoke(id,context);f.capabilities[0].revision='changed';return result;};
 assert.equal((await runWorkflow(f.plan(),f.task,f.host,new AbortController().signal)).status,'failed');assert.equal(f.calls.length,1);
});
test('model transport cannot rewrite the retained discovery through shared objects',async()=>{
 const f=fixture();const plan=await proposeEnrichment(f.discovery,f.policy,f.capabilities,{assertCurrent:async()=>{},ask:async payload=>{payload.discovery.purpose='Injected';return JSON.stringify(f.configuration);}},new AbortController().signal);
 assert.equal(plan.discovery.purpose,'Repair a parser');
});
test('model bindings cannot weaken the endpoint or substitute an unrelated verifier',()=>{
 const f=fixture();assert.throws(()=>enrich(f.discovery,f.policy,{...f.configuration,completionCheck:'input'},f.capabilities),/lifecycle/);
 f.configuration.bindings[0].verify='input';assert.throws(f.plan,/Verifier/);
});
test('already cancelled runs do not claim tasks or call capabilities',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();let claims=0;f.host.claim=async()=>{claims++;};await assert.rejects(runWorkflow(f.plan(),f.task,f.host,controller.signal));assert.equal(claims,0);assert.equal(f.calls.length,0);
});
test('out-of-order bindings compile to a stable execution order',async()=>{const f=fixture();f.configuration.bindings.reverse();assert.equal((await runWorkflow(f.plan(),f.task,f.host,new AbortController().signal)).status,'completed');});
