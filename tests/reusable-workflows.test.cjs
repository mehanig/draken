const {test}=require('node:test');
const assert=require('node:assert/strict');
const {examples,workflow,guidance}=require('./fixtures/reusable-workflows.cjs');
const {contractMatchInput,validateProcess,validateProcessEvidence,validateContractAssessment,decideContractMatch}=require('../dist/workflow-learning');
const {enrich,workflowRequest,sessionPlan}=require('../dist/factory-enrichment');
const inputs=()=>[examples()[0].left,examples()[0].right].map(side=>contractMatchInput(side.fragment));
const assessment=()=>({relation:'same_workflow_candidate',workflow:structuredClone(workflow),reuse:'saved-workflow',stagePairs:[{left:'S1',right:'S1'},{left:'S2',right:'S2'},{left:'S3',right:'S3'},{left:'S4',right:'S4'}],reason:'Different requested behaviors use the same interaction-regression and local-preview procedure',limitations:[]});
const saved=()=>[{id:'saved-workflow',workflow:structuredClone(workflow)}];
test('cross-feature fixtures retain historical goals and distinguish implementation from discussion and delivery endpoints',()=>{
 for(const c of examples())for(const s of [c.left,c.right])validateProcessEvidence(validateProcess(JSON.stringify({summary:'Synthetic reuse case',fragments:[s.fragment],limitations:['Synthetic']}),s.records.map(r=>r.ref)),s.records);
 assert.notEqual(inputs()[0].goal,inputs()[1].goal);
 assert.equal(decideContractMatch(assessment(),inputs(),saved()).assessment.reuse,'saved-workflow');
});
test('reuse names only a supplied unchanged definition, never a widened endpoint or an unsupported stage',()=>{
 for(const mutate of [a=>a.reuse='unknown',a=>a.reuse=42,a=>a.workflow.purpose='Publish a release',a=>a.workflow.appliesWhen+=' and publish',a=>a.workflow.method.push('Merge and publish'),a=>a.relation='shared_subprocedure',a=>a.stagePairs[0].left='missing']){
  const a=assessment();mutate(a);assert.throws(()=>validateContractAssessment(JSON.stringify(a),inputs(),saved()));
 }
 const a=assessment();a.workflow={method:a.workflow.method,appliesWhen:a.workflow.appliesWhen,purpose:a.workflow.purpose};assert.equal(validateContractAssessment(JSON.stringify(a),inputs(),saved()).reuse,'saved-workflow');
});
test('distinct definitions and legacy comparisons need no invented reuse identity',()=>{
 const a=assessment();a.reuse=null;assert.equal(decideContractMatch(a,inputs(),saved()).assessment.reuse,null);
 delete a.reuse;assert.equal(decideContractMatch(a,inputs()).sameWorkflow,true);
 a.relation='different';a.workflow=null;a.stagePairs=[];a.reuse='saved-workflow';assert.throws(()=>decideContractMatch(a,inputs(),saved()));
});
test('one saved enrichment accepts different feature runs without rewriting its procedure or expanding its endpoint',()=>{
 const discovery={id:'saved-workflow',revision:'revision-1',locationKey:'repo',...workflow,limitations:[]};
 const prepared=enrich(discovery,guidance),before=structuredClone(prepared);
 const requests=[{desired_behavior:'Filter workflows by name',acceptance_criteria:'Matching rows remain visible; clearing restores all rows'},{desired_behavior:'Sort sessions by activity',acceptance_criteria:'Newest activity first; selected session remains selected'}];
 const plans=requests.map(values=>sessionPlan(discovery,workflowRequest(prepared,values).task,'repo',prepared));
 assert.notEqual(plans[0].task,plans[1].task);assert.deepEqual(plans[0].workflow,plans[1].workflow);assert.deepEqual(prepared,before);
 assert.throws(()=>workflowRequest(prepared,{desired_behavior:'Change filtering'}),/Acceptance criteria/);
 assert.throws(()=>workflowRequest(prepared,{...requests[0],publish:'yes'}));
 for(const plan of plans){assert.equal(plan.workflow.purpose,workflow.purpose);assert.match(plan.workflow.appliesWhen,/not a PR, merge or release/);}
});
