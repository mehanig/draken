const {test}=require('node:test'),assert=require('node:assert/strict');
const {sessionPlan,enrich,proposeEnrichment,ENRICHMENT_PROMPT}=require('../dist/factory-enrichment');
const workflow={id:'source',revision:'1',locationKey:'repo',purpose:'Repair parser',appliesWhen:'Parser defect',method:['Reproduce','Fix'],limitations:['Historical outcome not verified']};
const plan=()=>sessionPlan(workflow,'Fix escaped strings','repo',8);
const guidance=()=>({steps:[{step:1,approach:'Reproduce escaped-string failure',checks:['Regression fails before fixing']},{step:2,approach:'Repair escaping and add regression coverage',checks:['Regression and compatibility pass']}],review:['Review escaping edge cases and unintended diff changes'],completion:['Requested format preserved'],risks:['Historical outcome not verified']});
test('enrichment adds task-specific guidance and mandatory review/repair without rewriting history',()=>{
 const p=plan(),g=guidance(),result=enrich(p,g);assert.deepEqual(result.plan,p);assert.deepEqual(result.plan.workflow,workflow);assert.deepEqual(result.guidance,g);assert.match(result.requirements.join(' '),/Review the diff/);assert.match(result.requirements.join(' '),/repair and retest/i);assert.match(result.requirements.join(' '),/not an independent reviewer/);
 g.review[0]='changed';p.workflow.method[0]='changed';assert.notEqual(result.guidance.review[0],'changed');assert.equal(result.plan.workflow.method[0],'Reproduce');
});
test('every detected step, review and endpoint criteria are required',()=>{
 for(const mutate of [g=>g.steps.pop(),g=>g.steps[1].step=1,g=>g.steps[0].step=3,g=>g.review=[],g=>g.completion=[],g=>g.steps[0].checks=[]]){const g=guidance();mutate(g);assert.throws(()=>enrich(plan(),g),/enrich|step/);}
});
test('model cannot insert authority, replace history or change host requirements',()=>{
 for(const key of ['policy','workflow','requirements','tools','publication'])assert.throws(()=>enrich(plan(),{...guidance(),[key]:true}),/enrichment/);
 const p=plan();p.policy.publication=true;assert.throws(()=>enrich(p,guidance()),/policy/);
});
test('enrichment order is stable and invalid prose is not silently repaired',()=>{
 const g=guidance();g.steps.reverse();assert.deepEqual(enrich(plan(),g).guidance.steps.map(s=>s.step),[1,2]);
 g.review=['x'.repeat(1601)];assert.throws(()=>enrich(plan(),g));
});
test('one accounted planning callback with source checks before and after; failed paid output is not retried',async()=>{
 let calls=0,checks=0;const host={assertCurrent:async()=>{checks++;},ask:async(payload,prompt)=>{calls++;assert.equal(prompt,ENRICHMENT_PROMPT);assert.deepEqual(payload.plan,plan());payload.plan.workflow.purpose='tampered';return JSON.stringify(guidance());}};
 const result=await proposeEnrichment(plan(),host,new AbortController().signal);assert.equal(calls,1);assert.equal(checks,2);assert.equal(result.plan.workflow.purpose,'Repair parser');
 calls=0;host.ask=async()=>{calls++;return 'invalid JSON';};await assert.rejects(proposeEnrichment(plan(),host,new AbortController().signal));assert.equal(calls,1);
});
test('revocation after planning and cancellation prevent accepting enrichment',async()=>{
 let checks=0,calls=0;await assert.rejects(proposeEnrichment(plan(),{assertCurrent:async()=>{if(++checks===2)throw Error('Revoked');},ask:async()=>{calls++;return JSON.stringify(guidance());}},new AbortController().signal),/Revoked/);assert.equal(calls,1);
 const c=new AbortController();c.abort();await assert.rejects(proposeEnrichment(plan(),{assertCurrent:async()=>{},ask:async()=>{calls++;return '';}},c.signal));assert.equal(calls,1);
});
