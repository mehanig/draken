const {test}=require('node:test'),assert=require('node:assert/strict');
const {sessionPlan,enrich,proposeEnrichment,ENRICHMENT_PROMPT}=require('../dist/factory-enrichment');
const workflow={id:'source',revision:'1',locationKey:'repo',purpose:'Repair parser',appliesWhen:'Parser defect',method:['Reproduce','Fix'],limitations:['Historical outcome not verified']};
const guidance=()=>({steps:[{step:1,approach:'Reproduce the reported defect',checks:['Regression fails before fixing']},{step:2,approach:'Repair the parser with regression coverage',checks:['Regression and compatibility pass']}],review:['Review edge cases and unintended diff changes'],completion:['Requested format preserved'],risks:['Historical outcome not verified']});
test('enrichment is workflow-owned and reused unchanged across different tasks',()=>{
 const saved=enrich(workflow,guidance());assert.deepEqual(saved.workflow,workflow);assert.equal(saved.task,undefined);
 const first=sessionPlan(workflow,'Fix escaped strings','repo',saved),second=sessionPlan(workflow,'Fix integers','repo',saved);
 assert.deepEqual(first.enrichment,second.enrichment);assert.notEqual(first.task,second.task);assert.match(saved.requirements.join(' '),/repair and retest/);assert.match(saved.requirements.join(' '),/not an independent reviewer/);
 first.enrichment.guidance.review[0]='changed';assert.notEqual(saved.guidance.review[0],'changed');
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
 const g=guidance();g.steps.reverse();assert.deepEqual(enrich(workflow,g).guidance.steps.map(s=>s.step),[1,2]);g.review=['x'.repeat(1601)];assert.throws(()=>enrich(workflow,g));
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
