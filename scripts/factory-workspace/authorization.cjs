const fs=require('node:fs');
const {workflowLocation}=require('../../dist/factory/location');
const {discoveryFromProposal}=require('../../dist/factory/enrichment');
const {sessionPlan}=require('../../dist/factory-enrichment');
function loadBrief(file,repository,commit){
 const original=fs.readFileSync(file,'utf8'),request=JSON.parse(original),p=request.plan;
 if(!p||p.format!=='factory-agent-session-v1'||JSON.stringify(sessionPlan(p.workflow,p.task,p.policy.locationKey,p.policy.maxCalls))!==JSON.stringify(p))throw Error('Invalid whole-workflow session plan');
 const location=workflowLocation(repository);if(location.kind!=='repository'||location.key!==p.policy.locationKey)throw Error('Workflow belongs to a different repository');
 const source=request.authorization;
 if(!source||!['operator','discovery'].includes(source.kind))throw Error('Explicit workflow authority required');
 if(source.kind==='discovery'){
  const url=new URL(source.origin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||!process.env.DRAKEN_FACTORY_TOKEN)throw Error('Authenticated Factory source required');
 }
 const authorize=async signal=>{
  signal?.throwIfAborted();if(fs.readFileSync(file,'utf8')!==original||workflowLocation(repository).key!==location.key)throw Error('Workflow policy or repository changed');
  if(source.kind==='discovery'){
   let before,found;
   for(let i=0;i<50;i++){
    const response=await fetch(new URL('/api/factory'+(before?'?before='+before:''),source.origin),{signal,redirect:'error',cache:'no-store',headers:{Authorization:'Bearer '+process.env.DRAKEN_FACTORY_TOKEN}});
    if(!response.ok)throw Error('Workflow source unavailable');const page=await response.json();found=page.proposals.find(v=>v.id===p.workflow.id);if(found||page.nextCursor===null)break;before=page.nextCursor;
   }
   if(!found||JSON.stringify(discoveryFromProposal(found))!==JSON.stringify(p.workflow))throw Error('Workflow source changed or permission was revoked');
  }
  signal?.throwIfAborted();
 };
 return {sessionDirectory:source.kind==='discovery'?require('node:path').join(require('../../dist/sources/registry').getSourceRoots().pi[0],'draken-factory'):undefined,brief:{...p,repository,locationKey:location.key,commit},authorize};
}
module.exports={loadBrief};
