const {test}=require('node:test'),assert=require('node:assert/strict');
const {sessionPlan,workflowRequest,enrich,proposeEnrichment,ENRICHMENT_PROMPT}=require('../dist/factory-enrichment');
const workflow={id:'source',revision:'1',locationKey:'repo',purpose:'Repair parser',appliesWhen:'Parser defect',method:['Reproduce','Fix'],limitations:['Historical outcome not verified']};
const guidance=()=>({inputs:[],steps:[{step:1,approach:'Reproduce the reported defect',checks:['Regression fails before fixing']},{step:2,approach:'Repair the parser with regression coverage',checks:['Regression and compatibility pass']}],review:['Review edge cases and unintended diff changes'],completion:['Requested format preserved'],risks:['Historical outcome not verified']});
test('enrichment is workflow-owned and reused unchanged across different tasks',()=>{
 const saved=enrich(workflow,guidance());assert.deepEqual(saved.workflow,workflow);assert.equal(saved.task,undefined);
 const first=sessionPlan(workflow,'Fix escaped strings','repo',saved),second=sessionPlan(workflow,'Fix integers','repo',saved);
 assert.deepEqual(first.enrichment,second.enrichment);assert.notEqual(first.task,second.task);assert.match(saved.requirements.join(' '),/repair and retest/);assert.match(saved.requirements.join(' '),/not an independent reviewer/);
 first.enrichment.guidance.review[0]='changed';assert.notEqual(saved.guidance.review[0],'changed');
});
test('workflow-defined inputs replace a generic task and are validated before execution',()=>{
 const g=guidance();g.inputs=[{name:'version',label:'Release version',description:'Published version to verify',required:true}];const saved=enrich(workflow,g);
 assert.throws(()=>workflowRequest(saved,{}),/Release version/);assert.throws(()=>workflowRequest(saved,{version:'1',task:'other'}),/Unexpected/);
 assert.throws(()=>workflowRequest(saved,{version:123}),/valid/);const request=workflowRequest(saved,{version:' 1.2.3 '});assert.deepEqual(request.inputs,{version:'1.2.3'});assert.match(request.task,/selected enriched workflow/);
 assert.deepEqual(workflowRequest(enrich(workflow,guidance()),{}).inputs,{});
 g.inputs.push(g.inputs[0]);assert.throws(()=>enrich(workflow,g),/workflow input/);
});
test('every detected step, review and endpoint criteria are required',()=>{
 for(const mutate of [g=>g.steps.pop(),g=>g.steps[1].step=1,g=>g.steps[0].step=3,g=>g.review=[],g=>g.completion=[],g=>g.steps[0].checks=[]]){const g=guidance();mutate(g);assert.throws(()=>enrich(workflow,g),/enrich|step/);}
});
test('missing, changed-source or changed-policy enrichment cannot start a session',()=>{
 const saved=enrich(workflow,guidance());assert.throws(()=>sessionPlan(workflow,'Fix','repo'),/enrichment/);
 assert.throws(()=>sessionPlan({...workflow,revision:'2'},'Fix','repo',saved),/enrichment/);
 for(const mutate of [e=>e.policyVersion='other',e=>e.requirements=[],e=>e.workflow.method[0]='other']){const e=structuredClone(saved);mutate(e);assert.throws(()=>sessionPlan(workflow,'Fix','repo',e),/enrichment/);}
 for(const key of ['policy','workflow','requirements','tools','publication'])assert.throws(()=>enrich(workflow,{...guidance(),[key]:true}),/enrichment/);
});
test('enrichment order is stable and invalid prose is not silently repaired',()=>{
 const g=guidance();g.steps.reverse();assert.deepEqual(enrich(workflow,g).guidance.steps.map(s=>s.step),[1,2]);
 for(const invalid of ['', '   ', 123, null]){g.review=[invalid];assert.throws(()=>enrich(workflow,g));}
});
test('long input names survive preparation, saved JSON, request and session planning',async()=>{
 const name='architecture_and_data_constraints',g=guidance();
 g.inputs=[{name,label:'Architecture and data constraints',description:'Preserve pointer-only storage',required:true}];
 let calls=0;
 const prepared=await proposeEnrichment(workflow,{assertCurrent:async()=>{},ask:async()=>{calls++;return JSON.stringify(g);}},new AbortController().signal);
 const saved=JSON.parse(JSON.stringify(prepared)),request=workflowRequest(saved,{[name]:'Keep session content in original files'});
 assert.equal(calls,1);assert.deepEqual(saved.guidance,g);
 assert.equal(request.inputs[name],'Keep session content in original files');
 assert.deepEqual(sessionPlan(workflow,request.task,'repo',saved).enrichment,saved);
});
for(const [name,change] of [
 ['input name',(w,g)=>{g.inputs=[{name:'input_'+ 'x'.repeat(5000),label:'Input',description:'Description',required:true}];}],
 ['input count',(w,g)=>{g.inputs=Array.from({length:9},(_,i)=>({name:`input_${i}`,label:'Input',description:'Description',required:false}));}],
 ['guidance prose',(w,g)=>{const text='x'.repeat(5000);g.inputs=[{name:'input',label:text,description:text,required:false}];g.steps[0].approach=text;g.steps[0].checks=[text];g.review=[text];g.completion=[text];g.risks=[text];}],
 ['guidance lists',(w,g)=>{const list=Array.from({length:13},(_,i)=>`Check ${i}`);g.steps[0].checks=list;g.review=list;g.completion=list;g.risks=list;}],
 ['workflow prose',(w)=>{w.purpose='x'.repeat(4001);w.appliesWhen=w.purpose;w.method[0]=w.purpose;w.limitations=[w.purpose];}],
 ['method steps',(w,g)=>{w.method=Array.from({length:33},(_,i)=>`Step ${i}`);g.steps=w.method.map((approach,i)=>({step:i+1,approach,checks:['Check result']}));}],
 ['limitations',(w)=>{w.limitations=Array.from({length:65},(_,i)=>`Limitation ${i}`);}],
])test(`enrichment does not impose an arbitrary size limit on ${name}`,()=>{
 const w=structuredClone(workflow),g=guidance();change(w,g);
 const saved=JSON.parse(JSON.stringify(enrich(w,g)));
 assert.deepEqual(saved.workflow,w);assert.deepEqual(saved.guidance,g);
 assert.deepEqual(sessionPlan(w,'Execute','repo',saved).enrichment,saved);
});
test('one accounted preparation callback with no task and source checks before/after; failed output is not retried',async()=>{
 let calls=0,checks=0;const host={assertCurrent:async()=>{checks++;},ask:async(payload,prompt)=>{calls++;assert.equal(prompt,ENRICHMENT_PROMPT);assert.deepEqual(payload.workflow,workflow);assert.equal(payload.task,undefined);payload.workflow.purpose='tampered';return JSON.stringify(guidance());}};
 const result=await proposeEnrichment(workflow,host,new AbortController().signal);assert.equal(calls,1);assert.equal(checks,2);assert.equal(result.workflow.purpose,'Repair parser');
 calls=0;host.ask=async()=>{calls++;return 'invalid JSON';};await assert.rejects(proposeEnrichment(workflow,host,new AbortController().signal));assert.equal(calls,1);
});
test('revocation after preparation and cancellation prevent accepting enrichment',async()=>{
 let checks=0,calls=0;await assert.rejects(proposeEnrichment(workflow,{assertCurrent:async()=>{if(++checks===2)throw Error('Revoked');},ask:async()=>{calls++;return JSON.stringify(guidance());}},new AbortController().signal),/Revoked/);assert.equal(calls,1);
 const c=new AbortController();c.abort();await assert.rejects(proposeEnrichment(workflow,{assertCurrent:async()=>{},ask:async()=>{calls++;return '';}},c.signal));assert.equal(calls,1);
});

for(const endpoint of [
 {id:'feature-to-pr',method:['Implement the feature with regression coverage','Run focused checks; self-review, repair and retest','Commit and push the approved branch','Open a draft PR against the requested base'],completion:['Record the commit and draft PR URL; verify head and base']},
 {id:'release',method:['Prepare version and release notes','Run release checks; self-review, repair and retest','Commit and tag the approved release','Publish the package and deploy the release','Verify the published version and live deployment'],completion:['Record the release tag, published package version and verified deployment URL']},
])test(`${endpoint.id} retains its complete endpoint in saved enrichment and execution plans without publication bans`,()=>{
 const fixtureEnrichment=require('./fixtures/workflow-enrichment.cjs');
 const source={...workflow,id:endpoint.id,purpose:endpoint.id,appliesWhen:'Operator approves this workflow',method:endpoint.method};
 const g=fixtureEnrichment(source).guidance;
 g.steps=source.method.map((approach,i)=>({step:i+1,approach,checks:[`Record the actual result of step ${i+1}`]}));
 g.completion=endpoint.completion;
 const saved=JSON.parse(JSON.stringify(enrich(source,g))),before=structuredClone(saved);
 const request=workflowRequest(saved,{});
 const plan=JSON.parse(JSON.stringify(sessionPlan(source,request.task,'repo',saved)));
 assert.deepEqual(saved.workflow,source);assert.deepEqual(saved.guidance,g);
 assert.deepEqual(plan.workflow,source);assert.deepEqual(plan.enrichment,saved);
 assert.deepEqual(plan.enrichment.guidance.steps.map(s=>s.approach),endpoint.method);
 assert.deepEqual(plan.enrichment.guidance.completion,endpoint.completion);
 assert.deepEqual(plan.policy,{locationKey:'repo',maxCalls:16,tools:['read','write','edit','bash']});
 for(const contract of [saved,plan.enrichment]){
  assert.equal(Object.hasOwn(contract,'publication'),false);
  const requirements=contract.requirements.join(' ');
  assert.match(requirements,/including commits, push, PR creation, publication or deployment when required/);
  assert.doesNotMatch(requirements,/never (?:push|publish|deploy)|publication.{0,20}(?:false|prohibited|forbidden)|do not.{0,40}(?:push|publish|deploy|publication)/i);
 }
 plan.enrichment.guidance.steps.pop();plan.workflow.method.pop();
 assert.deepEqual(saved,before);assert.deepEqual(source.method,endpoint.method);
});
