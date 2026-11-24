const {test}=require('node:test'),assert=require('node:assert/strict');
const {consolidatedWorkflows,decideContractMatch,contractMatchInput}=require('../dist/workflow-learning');
const {enrich,workflowRequest,sessionPlan}=require('../dist/factory-enrichment');
const {examples}=require('./fixtures/reusable-workflows.cjs');
const workflow={purpose:'Implement a requested Draken change',method:[
 'Inspect affected behavior, implement the requested change and update relevant tests, UI and documentation.',
 'Validate acceptance criteria and applicable stored-data preservation requirements.',
 'Only when delivery_scope requests local deployment, back up data, build, restart and verify the running result. Otherwise stop after validation.'
],appliesWhen:'A Draken change requires implementation and validation. Each run supplies desired behavior, acceptance criteria and delivery_scope: validation only or validation and local deployment. Neither choice includes PR submission or publication.'};
const guidance={inputs:[
 {name:'desired_behavior',label:'Desired behavior',description:'The change to implement',required:true},
 {name:'acceptance_criteria',label:'Acceptance criteria',description:'Observable results',required:true},
 {name:'delivery_scope',label:'Delivery scope',description:'Validation only, or validation and local deployment',required:true}
],steps:workflow.method.map((approach,i)=>({step:i+1,approach,checks:[i===2?'Verify deployment only when requested by delivery_scope; otherwise report deployment as not applicable.':'Check acceptance_criteria.']})),review:['Review the change and verify it stayed within delivery_scope.'],completion:['Acceptance criteria pass. Local deployment is verified only when requested; otherwise the run stops after validation.'],risks:['Clarify ambiguous delivery_scope before external actions.']};
test('conditional delivery uses ordinary workflow text through consolidation and identity reuse',()=>{
 const groups=consolidatedWorkflows(JSON.stringify({groups:[{members:['validation','local-deployment'],workflow,reason:'Same implementation procedure; local deployment is a supported conditional final step.'}]}),['validation','local-deployment']);
 assert.deepEqual(groups[0].workflow,workflow);assert.deepEqual(Object.keys(workflow).sort(),['appliesWhen','method','purpose']);
 const pair=[examples()[0].left,examples()[0].right].map(s=>contractMatchInput(s.fragment));
 const a={relation:'same_workflow_candidate',workflow,reuse:'conditional',stagePairs:[{left:'S1',right:'S1'}],reason:'Reuse the shared procedure and retain per-run delivery scope.',limitations:[]};
 assert.equal(decideContractMatch(a,pair,[{id:'conditional',workflow}]).assessment.reuse,'conditional');
 assert.throws(()=>decideContractMatch(a,pair,[{id:'conditional',workflow:{...workflow,method:workflow.method.slice(0,2)}}]),/unchanged definition/);
});
test('one saved enrichment carries both delivery choices through the existing session path',()=>{
 const discovery={id:'conditional',revision:'1',locationKey:'repo',...workflow,limitations:[]};
 const saved=JSON.parse(JSON.stringify(enrich(discovery,guidance))),before=structuredClone(saved);
 const values={desired_behavior:'Allow chat to select a workflow',acceptance_criteria:'No execution starts before run authorization'};
 assert.throws(()=>workflowRequest(saved,values),/Delivery scope/);
 const plans=['validation only','validation and local deployment'].map(delivery_scope=>sessionPlan(discovery,workflowRequest(saved,{...values,delivery_scope}).task,'repo',saved));
 assert.notEqual(plans[0].task,plans[1].task);
 for(const plan of plans){assert.equal(plan.format,'factory-agent-session-v2');assert.deepEqual(plan.workflow,discovery);assert.deepEqual(plan.enrichment,saved);assert.deepEqual(plan.policy.tools,['read','write','edit','bash']);}
 assert.deepEqual(saved,before);
});
