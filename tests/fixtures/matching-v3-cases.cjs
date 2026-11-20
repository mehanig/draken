// Controlled examples, NOT claims about real session history. Expectations never enter model input.
function episode({goal,context,entry,result,action,permission,tool='shell',skill='recorded-skill'}) {
  const claim=(description,basis,ref)=>({description,basis,refs:[ref]});
  const stage=(key,action,description,ref)=>({key,action,normalizedAction:action,role:'main',condition:null,claims:[claim(description,'observed',ref)],refs:[ref],tools:[{name:tool,usage:action,refs:[ref]}],skills:[{name:skill,usage:action,refs:[ref]}]});
  return {kind:'synthetic',records:[{ref:'U',role:'user'},{ref:'I',role:'toolResult'},{ref:'O',role:'toolResult'}],fragment:{
    key:'example',goal,context,state:'completed',refs:['U','I','O'],coverage:{triggerRefs:['U'],outcomeRefs:['O'],gaps:[]},
    stages:[stage('inspect','Inspect the available input',entry,'I'),stage('perform',action,result,'O')],
    dependencies:[],decisions:[claim(permission,'requested','U')],exceptions:[],questions:[],matching:{goal,context}
  }};
}
const copy=x=>JSON.parse(JSON.stringify(x));
function examples() {
  const restore=episode({goal:'Verify that a database backup can restore the expected data in isolation',context:'A backup exists; this is a recovery rehearsal, not a production recovery',entry:'An immutable database backup and a table-count manifest are available; an empty isolated target exists',action:'Restore the backup into the isolated target and compare its tables with the manifest',result:'The isolated database was restored; every table and row count matches the backup manifest',permission:'Restore only into the isolated target; production must remain unchanged',tool:'local-restore-cli',skill:'recovery-rehearsal'});
  const alternate=copy(restore);alternate.fragment.key='a-new-instance';alternate.fragment.goal+=' (rehearsal 907)';
  alternate.fragment.stages.forEach(s=>{s.tools[0].name='managed-restore-service';s.skills[0].name='alternative-backup-check';});
  const dataset=episode({goal:'Publish a cleaned measurement dataset for analysis',context:'Measurement records must satisfy unit and range rules before publication',entry:'Unvalidated measurement rows and a declared unit/range specification are available',action:'Edit, validate and publish the artifact',result:'Normalized measurement rows passed the declared rules and were published as the analysis dataset',permission:'Publish only validated data; reject rows with invalid units',tool:'bash',skill:'validation'});
  const docs=episode({goal:'Publish revised product documentation',context:'Reviewed prose is converted into public documentation pages',entry:'Reviewed document drafts and a documentation navigation map are available',action:'Edit, validate and publish the artifact',result:'Documentation pages were published with working navigation links',permission:'Publish reviewed prose; do not modify measurement datasets',tool:'bash',skill:'validation'});
  const apply=episode({goal:'Apply approved configuration to the running service',context:'A production change has been explicitly approved',entry:'The current service configuration and a validated replacement are available',action:'Validate the replacement configuration and apply it',result:'The running production service reports the new configuration active',permission:'Apply this approved configuration to the production service',tool:'config-cli',skill:'configuration'});
  const preview=episode({goal:'Preview configuration changes without touching the running service',context:'Only a local simulation is authorized',entry:'The current service configuration and a validated replacement are available',action:'Validate the replacement configuration and apply it',result:'A simulation report describes the replacement; production configuration is unchanged',permission:'Do not change production; simulate locally only',tool:'config-cli',skill:'configuration'});
  const missing=copy(restore);missing.fragment.state='unknown';missing.fragment.coverage.outcomeRefs=[];missing.fragment.coverage.gaps=['No restore result or verification output is available'];missing.fragment.stages[1].claims=[{description:'Restoration and comparison were requested; their outcome is unknown',basis:'requested',refs:['U']}];
  const credentials=episode({goal:'Revoke a compromised credential and activate its replacement',context:'A credential is compromised and must no longer authenticate',entry:'A compromised credential is still active and a replacement is available',action:'Inspect state, change it, validate the result and record completion',result:'Authentication with the old credential is rejected and the replacement succeeds',permission:'Rotate this credential; do not restore or copy any database',tool:'local-restore-cli',skill:'recovery-rehearsal'});
  const archive=copy(restore);archive.fragment.stages[1].action=archive.fragment.stages[1].normalizedAction='Inspect state, change it, validate the result and record completion';
  function withIntegrity(goal,context,finalResult) {
    const e=episode({goal,context,entry:'A downloaded batch of files and its signed checksum manifest are available',action:'Consume the files for the parent task',result:finalResult,permission:'Before consuming any file, reject missing or extra files and reject any checksum mismatch',tool:'hash-tool',skill:'manifest-integrity'});
    const a=copy(e.fragment.stages[0]);a.key='manifest-input';a.action=a.normalizedAction='Inspect the received files and their signed manifest';
    const b=copy(e.fragment.stages[1]);b.key='verify-integrity';b.action=b.normalizedAction='Compare file membership and each file checksum against the signed manifest';b.claims=[{description:'File membership matches exactly and every checksum matches the signed manifest; the batch is eligible for consumption',basis:'observed',refs:['V']}];b.refs=['V'];b.tools[0].refs=['V'];b.skills[0].refs=['V'];
    e.records.push({ref:'V',role:'toolResult'});e.fragment.stages=[a,b,e.fragment.stages[1]];e.fragment.refs.push('V');
    return e;
  }
  return [
    {name:'same-purpose-different-tools-and-skills',expected:{eligible:true,relations:['same_workflow_candidate']},left:restore,right:alternate},
    {name:'same-verbs-different-artifacts-and-goals',expected:{eligible:false,relations:['common_practice','different','insufficient']},left:dataset,right:docs},
    {name:'same-tools-conflicting-permission-and-result',expected:{eligible:false,relations:['different','insufficient','common_practice']},left:apply,right:preview},
    {name:'same-request-missing-observed-result',expected:{eligible:false,relations:['insufficient','common_practice','different']},left:restore,right:missing},
    {name:'same-tools-and-verbs-different-resource-transition',expected:{eligible:false,relations:['different','common_practice','insufficient']},left:archive,right:credentials},
    {name:'different-parent-goals-real-shared-integrity-procedure',expected:{eligible:true,relations:['shared_subprocedure']},left:withIntegrity('Train a statistical model from a received dataset','Training requires a verified input batch','The verified dataset was consumed by the completed training job'),right:withIntegrity('Recover an archived collection of documents','Archive recovery requires a verified input batch','The verified documents were restored into the archive')}
  ];
}
module.exports={examples};
