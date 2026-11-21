// Opt-in actual Pi SDK protocol test. Provider transport and container operations are fixtures; no paid requests.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const {runAgent}=require('../scripts/factory-workspace/agent.cjs'),{sessionPlan}=require('../dist/factory-enrichment');
async function main(){
 const entry=fs.realpathSync(process.env.DRAKEN_FACTORY_PI_SDK),pkg=JSON.parse(fs.readFileSync(path.resolve(entry,'../../package.json')));assert.equal(pkg.version,'1.4.0');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'factory-real-sdk-')),sdk=path.join(root,'sdk');fs.mkdirSync(path.join(sdk,'dist'),{recursive:true});
 fs.writeFileSync(path.join(sdk,'package.json'),JSON.stringify({type:'module',name:pkg.name,version:pkg.version}));
 const streamFile=path.resolve(entry,'../../../pi-ai/dist/utils/event-stream.js');
 fs.writeFileSync(path.join(sdk,'dist/index.js'),`export * from ${JSON.stringify(pathToFileURL(entry).href)};
import * as real from ${JSON.stringify(pathToFileURL(entry).href)};
import {AssistantMessageEventStream} from ${JSON.stringify(pathToFileURL(streamFile).href)};
export async function createAgentSession(options){
 const result=await real.createAgentSession(options);let call=0;
 result.session.agent.getApiKey=async()=> 'fixture-no-provider';
 result.session.agent.streamFunction=(model,context)=>{
  call++;const stream=new AssistantMessageEventStream(),names=result.session.getActiveToolNames();let content,stopReason='stop';
  if(call===1){if(names.length)throw Error('Enrichment exposed tools');content=[{type:'text',text:JSON.stringify({steps:[{step:1,approach:'Reproduce defect',checks:['Record failure']},{step:2,approach:'Fix parser',checks:['Regression passes']}],review:['Review edge cases and repair findings'],completion:['Requested behavior is checked'],risks:[]})}];}
  else {if(names.sort().join(',')!=='bash,edit,read,write'||!JSON.stringify(context.messages).includes('factory-workflow-enrichment-v2'))throw Error('Missing enrichment or wrong tools');
   if(call===2){content=[{type:'toolCall',id:'read-fixture',name:'read',arguments:{path:'index.cjs'}}];stopReason='toolUse';}
   else content=[{type:'text',text:JSON.stringify({status:'completed',summary:'SDK contract fixture only'})}];
  }
  const message={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,stopReason,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
  stream.push({type:'done',reason:stopReason,message});stream.end();return stream;
 };return result;
}`);
 process.env.DRAKEN_FACTORY_PI_SDK=path.join(sdk,'dist/index.js');const operations=[];
 const result=await runAgent({directory:path.join(root,'run'),brief:{...sessionPlan({id:'fixture',revision:'1',locationKey:'fixture',purpose:'Repair parser',appliesWhen:'Bug',method:['Reproduce','Fix'],limitations:[]},'Fix parser','fixture',4),repository:root,locationKey:'fixture',commit:'fixture'},baseline:{},environment:{},invoke:async r=>{operations.push(r.op);if(r.op==='read')return {base64:Buffer.from('module.exports = 1;').toString('base64')};if(r.op==='access')return {};throw Error('Unexpected operation');},authorize:async()=>{},signal:new AbortController().signal,record:()=>{},maxCalls:4});
 assert.equal(result.modelCalls,3);assert.equal(result.completedCalls,3);assert.equal(result.accountingComplete,true);assert.ok(operations.includes('read'));
 const metadata=JSON.parse(fs.readFileSync(path.join(root,'run/session.json'))),messages=fs.readFileSync(metadata.file,'utf8').trim().split('\n').map(JSON.parse);assert.equal(messages.filter(e=>e.type==='message'&&e.message.role==='assistant').length,3);
 console.log(JSON.stringify({directory:root,sdk:pkg.version,oneSession:true,enrichmentThenExecution:true,containerAdapterInvoked:true,simulatedRequests:3,providerRequests:0}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
