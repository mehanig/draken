// Fresh identity cases, written after the original eight-case/model comparisons.
// Expected labels are evaluator metadata, never model input.
const copy=x=>structuredClone(x);
function scenario(goal,context,input,output,actions,restriction,tool='local-tool',skill='task-method'){
 const records=[{ref:'U',role:'user',text:goal+'. '+restriction},{ref:'I',role:'toolResult',text:input},{ref:'O',role:'toolResult',text:output}];
 const claim=(description,ref,basis='observed')=>({description,basis,refs:[ref]});
 const stages=actions.map((action,i)=>{const ref=i?'O':'I';return {key:'step-'+i,action,normalizedAction:action,role:'main',condition:null,claims:[claim(i?output:input,ref)],refs:[ref],tools:[{name:tool,usage:action,refs:[ref]}],skills:[{name:skill,usage:action,refs:[ref]}]};});
 return {kind:'synthetic',records,fragment:{key:'example',goal,context,state:'completed',refs:['U','I','O'],coverage:{triggerRefs:['U'],outcomeRefs:['O'],gaps:[]},stages,dependencies:[claim(input,'I')],decisions:[claim(restriction,'U','requested')],exceptions:[],questions:[],matching:{goal,context}}};
}
function examples(){
 const parser=scenario('Repair a parser defect with regression coverage','A reproducible parser defect must be fixed without changing the documented format',
  'A minimal input reproduces the parser defect and its new regression test fails',
  'The patched parser passes the new regression test and the existing compatibility suite',
  ['Reproduce the parser defect and add a failing regression test','Correct the parser and run the regression and compatibility tests'],
  'Preserve the documented input format','node-test','parser-debugging');
 const parserOther=copy(parser);for(const s of parserOther.fragment.stages){s.tools[0].name='pytest';s.skills[0].name='regression-testing';}
 const backupHash=scenario('Check reliability of a stored database backup','A stored backup needs checking before it is relied on',
  'The backup bytes and the cryptographic digest recorded when the backup was created are available',
  'The computed digest matches the recorded digest; the backup has not been restored or queried',
  ['Read the stored backup and its original digest','Compute the byte digest and compare it with the original digest'],
  'Read only the backup bytes; do not restore a database');
 const backupRestore=scenario('Check reliability of a stored database backup','A stored backup needs checking before it is relied on',
  'The backup, expected table contents and an empty isolated database are available',
  'The isolated restore succeeded and queries returned the expected table contents',
  ['Prepare the isolated database and expected table contents','Restore the backup and query the restored tables'],
  'Restore only into the isolated database; do not change production');
 const image=scenario('Correct the white balance of a photograph','A photograph contains a reference gray patch',
  'The image and neutral reference patch are available','The saved image has neutral channel values at the reference patch',
  ['Inspect the input and specification','Transform the input, validate the result and save it'],'Preserve the original image','python','data-processing');
 const ledger=scenario('Convert ledger amounts into the reporting currency','A financial ledger has amounts in one currency and an approved exchange rate',
  'The ledger and fixed exchange rate are available','Every output amount equals its source amount times the approved rate, rounded to cents',
  ['Inspect the input and specification','Transform the input, validate the result and save it'],'Preserve the source ledger','python','data-processing');
 const scan=scenario('Audit a local page for accessibility violations','An accessibility report is needed for a saved page',
  'The saved page was loaded into the scanner','The scanner produced an accessibility report with rule violations and element references',
  ['Load the saved page into the accessibility scanner','Run the accessibility rules and save the report'],'Inspect the saved page without modifying it');
 const failedScan=copy(scan);failedScan.fragment.state='blocked';failedScan.records[2].text='The scanner crashed while executing the rules; no accessibility report was produced';failedScan.fragment.stages[1].claims[0].description=failedScan.records[2].text;
 const refund=scenario('Issue an approved customer refund','A settled payment is eligible for an approved refund',
  'The original settled payment and approved refund amount were checked','The payment gateway accepted the refund and returned its transaction identifier',
  ['Check the original payment and approved refund amount','Submit the refund to the payment gateway and record its transaction identifier'],'Refund only the approved amount');
 const preview=scenario('Preview a possible customer refund without moving money','A settled payment is being assessed for a possible refund',
  'The original settled payment and proposed refund amount were checked','A local preview lists the proposed refund; no payment gateway request was made',
  ['Check the original payment and proposed refund amount','Write a local preview of the refund without submitting it'],'Do not submit transactions or move money');
 const calibration=scenario('Calibrate a temperature sensor offset against a stable reference','The sensor needs a zero-offset correction using a traceable reference',
  'The sensor reads 0.5 degrees above the stable reference','The offset correction was stored and a repeated reading matches the reference',
  ['Measure the sensor offset against the stable reference','Store the offset correction and repeat the reference measurement'],'Change only the offset, not the gain','bench-controller-A','offset-calibration');
 const otherCalibration=copy(calibration);otherCalibration.records[1].text='The sensor reads 2.1 degrees above the stable reference';otherCalibration.fragment.stages[0].claims[0].description=otherCalibration.records[1].text;otherCalibration.fragment.dependencies[0].description=otherCalibration.records[1].text;for(const s of otherCalibration.fragment.stages)s.tools[0].name='bench-controller-B';
 function envelope(goal,outcome){
  const e=scenario(goal,'The parent job consumes versioned event envelopes',
   'An event envelope and its declared schema version are available',outcome,
   ['Inspect the event envelope and declared schema version','Consume the validated event envelope for the parent job'],
   'Before consumption, reject unsupported schema versions, missing required fields or fields with the wrong value types');
  e.records.splice(2,0,{ref:'V',role:'toolResult',text:'The schema version is supported and every required field is present with the correct value type'});e.fragment.refs.push('V');
  const s=copy(e.fragment.stages[0]);s.key='validate-envelope';s.action=s.normalizedAction='Validate the schema version, required fields and value types before consumption';s.claims=[{description:e.records[2].text,basis:'observed',refs:['V']}];s.refs=['V'];s.tools[0].refs=['V'];s.skills[0].refs=['V'];e.fragment.stages.splice(1,0,s);return e;
 }
 const unknown=copy(parser);unknown.records=[{ref:'U',role:'user',text:'Repair the parser defect'}];unknown.fragment.refs=['U'];unknown.fragment.state='partial';unknown.fragment.coverage={triggerRefs:['U'],outcomeRefs:[],gaps:['No repair method or execution is recorded']};unknown.fragment.dependencies=[];unknown.fragment.decisions=[];unknown.fragment.stages=[{key:'unknown',action:'Unspecified repair',normalizedAction:'Unspecified repair',role:'unknown',condition:null,claims:[{description:'Repair the parser defect',basis:'requested',refs:['U']}],refs:['U'],tools:[],skills:[]}];
 return [
  {name:'parser-repair-same-method-different-tools',expected:{sameWorkflow:true,relations:['same_workflow_candidate']},left:parser,right:parserOther},
  {name:'backup-same-goal-different-methods',expected:{sameWorkflow:false,relations:['different','common_practice']},left:backupHash,right:backupRestore},
  {name:'image-versus-ledger-same-tools-and-verbs',expected:{sameWorkflow:false,relations:['different','common_practice']},left:image,right:ledger},
  {name:'accessibility-same-method-success-versus-failure',expected:{sameWorkflow:true,relations:['same_workflow_candidate']},left:scan,right:failedScan},
  {name:'refund-execution-versus-preview',expected:{sameWorkflow:false,relations:['different','common_practice','shared_subprocedure']},left:refund,right:preview},
  {name:'sensor-calibration-different-instance-values',expected:{sameWorkflow:true,relations:['same_workflow_candidate']},left:calibration,right:otherCalibration},
  {name:'shared-envelope-validation-does-not-merge-parent-jobs',expected:{sameWorkflow:false,relations:['shared_subprocedure']},left:envelope('Update a contact directory from received events','Validated contact events updated the directory'),right:envelope('Aggregate usage metrics from received events','Validated usage events updated the metric aggregates')},
  {name:'same-request-with-no-known-method',expected:{sameWorkflow:false,relations:['insufficient']},left:parser,right:unknown}
 ];
}
module.exports={examples};
