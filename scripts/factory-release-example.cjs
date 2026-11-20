#!/usr/bin/env node
// Explicit operator example, not a scheduler or model-quality evaluation.
// Capabilities are hand-configured for Draken release verification. No publish/merge/deploy handler exists.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {enrich,runWorkflow}=require('../dist/factory-enrichment');
const {discoveryFromProposal}=require('../dist/factory/enrichment');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function main(){
 if(process.platform==='win32')throw Error('This operator example currently requires a POSIX host');
 const [base,id,version,directory]=process.argv.slice(2),token=process.env.DRAKEN_FACTORY_TOKEN,expectedRevision=process.env.DRAKEN_FACTORY_DISCOVERY_REVISION;
 if(!base||!id||!/^\d+\.\d+\.\d+$/.test(version||'')||!directory||!token||!expectedRevision)throw Error('Usage: DRAKEN_FACTORY_TOKEN=... DRAKEN_FACTORY_DISCOVERY_REVISION=... node scripts/factory-release-example.cjs BASE_URL PROPOSAL_ID VERSION OUTPUT_DIRECTORY');
 const origin=new URL(base);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/')throw Error('Use the authenticated Factory origin, not a URL with credentials or a path');
 const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const output=path.resolve(directory);fs.mkdirSync(output,{recursive:true,mode:0o700});
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'draken-factory-release-'));
 for(const name of ['home','tmp','data'])fs.mkdirSync(path.join(scratch,name));
 const environment={PATH:process.env.PATH,HOME:path.join(scratch,'home'),TMPDIR:path.join(scratch,'tmp'),DRAKEN_DATA_DIR:path.join(scratch,'data'),DRAKEN_PI_SESSIONS_DIR:path.join(scratch,'sessions')};
 async function json(url,signal,headers={}){
  const response=await fetch(url,{headers:{'User-Agent':'Draken-Factory-example','Accept':'application/json',...headers},signal,redirect:'error',cache:'no-store'});
  if(!response.ok)throw Error(`Read failed: ${new URL(url).host} HTTP ${response.status}`);return response.json();
 }
 async function source(signal){
  let cursor;for(let page=0;page<50;page++){
   const result=await json(new URL('/api/factory'+(cursor?'?before='+cursor:''),origin),signal,{Authorization:'Bearer '+token});
   const proposal=result.proposals.find(p=>p.id===id);if(proposal)return discoveryFromProposal(proposal);
   if(result.nextCursor===null)break;cursor=result.nextCursor;
  }throw Error('Source proposal is no longer available through Factory');
 }
 function save(name,value){const file=path.join(output,name);const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return file;}
 function command(file,args,signal,allowedExit=[0]){
  return new Promise((resolve,reject)=>execFile(file,args,{cwd:scratch,env:environment,signal,timeout:120000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>{
   if(error&&!allowedExit.includes(error.code))return reject(Error(`Command ${path.basename(file)} failed: ${error.killed?'stopped':error.code||error.name}`));
   resolve({code:error?.code||0,stdout,stderr});
  }));
 }
 const implementation=hash(fs.readFileSync(__filename));
 const definitions=[
  ['input','check','Require a stable Draken version and exactly the configured verification task',[]],
  ['prepare','action','Prepare an isolated temporary package installation',['temporary-files']],
  ['registry','action','Read exact and latest Draken metadata from npm',['network-read']],
  ['check-registry','check','Require the requested version to be npm latest with integrity and provenance',[]],
  ['install','action','Install Draken without lifecycle scripts into a temporary directory and run its version command',['network-read','temporary-files','local-process']],
  ['check-install','check','Inspect the installed manifest, production files and CLI version',[]],
  ['audit','action','Audit only the installed production dependency tree',['network-read','local-process']],
  ['check-audit','check','Require a successful production audit with zero vulnerabilities',[]],
  ['release','action','Poll GitHub release and website workflow results up to 20 times, then read the public site version',['network-read']],
  ['check-release','check','Require publication, successful release and website workflows for the tag commit, and matching live site copy',[]],
  ['complete','check','Require all four verification checks to have passed',[]]
 ];
 const verifiers={'check-registry':['registry'],'check-install':['install'],'check-audit':['audit'],'check-release':['release']};
 const capabilities=definitions.map(([id,kind,description,effects])=>({id,kind,description,effects,revision:implementation,repeatable:true,...(verifiers[id]?{forActions:verifiers[id]}:{})}));
 const receipts={},passed=new Set();
 const ok=(detail,evidence)=>({ok:true,detail,evidence}),check=(valid,detail,evidence)=>({ok:!!valid,detail,evidence});
 try{
  const discovery=await source(controller.signal);
  if(discovery.revision!==expectedRevision)throw Error('Discovery differs from the explicitly selected revision');
  // This profile is deliberately selected by proposal ID, not by intent regexes or a guessed repository.
  // Its four bindings must be reviewed against the displayed method before using this operator example.
  if(discovery.method.length!==4)throw Error('This explicit example profile requires its four-step release-verification discovery');
  const policy={id:'draken-release-verification-example',revision:implementation,locationKey:discovery.locationKey,discoveryRevision:discovery.revision,
   endpoint:'Draken is npm latest; package contents and CLI version pass inspection; production audit, publication and live website checks pass',
   inputCheck:'input',prepare:'prepare',completionCheck:'complete',
   allowedCapabilities:capabilities.map(c=>c.id),allowedEffects:['network-read','temporary-files','local-process'],maxAttempts:1,timeoutMs:600000};
  const configuration={inputCheck:'input',prepare:'prepare',completionCheck:'complete',bindings:[
   {step:1,action:'registry',verify:'check-registry'},{step:2,action:'install',verify:'check-install'},
   {step:3,action:'audit',verify:'check-audit'},{step:4,action:'release',verify:'check-release'}]};
  const plan=enrich(discovery,policy,configuration,capabilities),policyText=JSON.stringify(policy,null,2)+'\n';
  save('policy.json',policy);
  const task={id:'verify-draken-'+version.replaceAll('.','-'),locationKey:discovery.locationKey,inputs:{package:'draken',githubRepository:'mehanig/draken',version}};
  const handlers={
   input:async()=>check(task.inputs.package==='draken'&&task.inputs.githubRepository==='mehanig/draken','Explicit read-only verification scope',[`draken@${version}; mehanig/draken; no publication capabilities`]),
   prepare:async()=>{receipts.prepare=save('environment.json',{temporary:true,installScripts:false,providerCalls:0});return ok('Temporary environment ready',[receipts.prepare]);},
   registry:async signal=>{receipts.registry=save('registry.json',{exact:await json(`https://registry.npmjs.org/draken/${version}`,signal),latest:await json('https://registry.npmjs.org/draken/latest',signal)});return ok('Registry metadata captured',[receipts.registry]);},
   'check-registry':async()=>{const r=JSON.parse(fs.readFileSync(receipts.registry));return check(r.exact.version===version&&r.latest.version===version&&/^sha512-/.test(r.exact.dist?.integrity)&&!!r.exact.dist?.attestations?.provenance,'npm version, integrity and provenance',[receipts.registry]);},
   install:async signal=>{const result=await command('npm',['install','--prefix',path.join(scratch,'install'),`draken@${version}`,'--omit=dev','--ignore-scripts','--no-audit','--no-fund'],signal);
    const cli=await command(process.execPath,[path.join(scratch,'install/node_modules/draken/dist/cli.js'),'--version'],signal);receipts.install=save('installation.json',{installationExit:result.code,cli});return ok('Fresh package installed and version command executed',[receipts.install]);},
   'check-install':async()=>{const root=path.join(scratch,'install/node_modules/draken'),manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),r=JSON.parse(fs.readFileSync(receipts.install));
    return check(manifest.version===version&&r.cli.code===0&&r.cli.stdout.trim()===`draken ${version}`&&['dist/factory/learning.js','public/index.html'].every(file=>fs.existsSync(path.join(root,file))),'Installed version and production files',[receipts.install]);},
   audit:async signal=>{const result=await command('npm',['audit','--prefix',path.join(scratch,'install'),'--omit=dev','--json'],signal,[0,1]);receipts.audit=save('audit.json',{code:result.code,report:JSON.parse(result.stdout)});return ok('Production audit captured',[receipts.audit]);},
   'check-audit':async()=>{const r=JSON.parse(fs.readFileSync(receipts.audit));return check(r.code===0&&r.report.metadata?.vulnerabilities?.total===0,'Production dependency audit',[receipts.audit]);},
   release:async signal=>{const base='https://api.github.com/repos/mehanig/draken',release=await json(`${base}/releases/tags/v${version}`,signal),tag=await json(`${base}/git/ref/tags/v${version}`,signal);
    const commit=tag.object.type==='tag'?(await json(`${base}/git/tags/${tag.object.sha}`,signal)).object.sha:tag.object.sha;
    let runs,website;const succeeded=values=>values.some(run=>run.head_sha===commit&&run.status==='completed'&&run.conclusion==='success');
    for(let poll=0;poll<20;poll++){
     runs=(await json(`${base}/actions/workflows/release.yml/runs?branch=v${version}&event=push&per_page=100`,signal)).workflow_runs;
     website=(await json(`${base}/actions/workflows/web-deploy.yml/runs?branch=master&per_page=100`,signal)).workflow_runs;
     if((succeeded(runs)&&succeeded(website))||![...runs,...website].some(run=>run.head_sha===commit&&run.status!=='completed'))break;
     await require('node:timers/promises').setTimeout(3000,undefined,{signal});
    }
    const site=await fetch('https://draken.mehanig.com',{signal,redirect:'error',cache:'no-store'});
    receipts.release=save('release.json',{release,commit,runs,website,site:{status:site.status,versionMatched:(await site.text()).includes(`Version ${version} / Available on npm`)}});return ok('GitHub publication and live website evidence captured',[receipts.release]);},
   'check-release':async()=>{const r=JSON.parse(fs.readFileSync(receipts.release)),succeeded=values=>values.some(run=>run.head_sha===r.commit&&run.status==='completed'&&run.conclusion==='success');return check(r.release.tag_name===`v${version}`&&!r.release.draft&&!r.release.prerelease&&!!r.release.published_at&&succeeded(r.runs)&&succeeded(r.website)&&r.site.status===200&&r.site.versionMatched,'Publication, website workflow and live version verified',[receipts.release]);},
   complete:async()=>check(['check-registry','check-install','check-audit','check-release'].every(id=>passed.has(id)),'All four independent checks passed',Object.values(receipts))
  };
  const result=await runWorkflow(plan,task,{
   capabilities,
   claim:async(task,plan)=>{save('claim.json',{task,workflowRevision:hash(JSON.stringify(plan))});save('enrichment.json',plan);},
   authorize:async(plan,task,signal)=>{if(fs.readFileSync(path.join(output,'policy.json'),'utf8')!==policyText)throw Error('Operating policy changed');const current=await source(signal);if(current.revision!==plan.discovery.revision||current.locationKey!==task.locationKey)throw Error('Discovery or source location changed');},
   record:async event=>{const fd=fs.openSync(path.join(output,'events.jsonl'),'a',0o600);try{fs.writeFileSync(fd,JSON.stringify(event)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}},
   invoke:async(id,context,signal)=>{if(!handlers[id])throw Error('Unknown capability');const outcome=await handlers[id](signal);if(outcome.ok&&id.startsWith('check-'))passed.add(id);return outcome;}
  },controller.signal);
  save('result.json',{...result,task,discoveryId:discovery.id,sourceRevision:discovery.revision,modelCalls:0,bindingOrigin:'explicit operator configuration',checks:[...passed]});
  console.log(JSON.stringify({status:result.status,detail:result.detail,checks:[...passed],output,modelCalls:0},null,2));if(result.status!=='completed')process.exitCode=1;
 }finally{fs.rmSync(scratch,{recursive:true,force:true});process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
