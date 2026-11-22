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
 const result=await real.createAgentSession(options);let call=0,prompts=0;const prompt=result.session.prompt.bind(result.session);
 result.session.prompt=(...args)=>{if(++prompts!==1)throw Error('Unexpected enrichment prompt during execution');return prompt(...args);};
 result.session.agent.getApiKey=async()=> 'fixture-no-provider';
 result.session.agent.streamFunction=(model,context)=>{
  call++;const stream=new AssistantMessageEventStream(),names=result.session.getActiveToolNames();let content,stopReason='stop';
  if(names.sort().join(',')!=='bash,edit,read,write'||!JSON.stringify(context.messages).includes('factory-workflow-enrichment-v4'))throw Error('Missing saved enrichment or wrong tools');
   if(call===1){content=[{type:'toolCall',id:'read-fixture',name:'read',arguments:{path:'index.cjs'}}];stopReason='toolUse';}
   else content=[{type:'text',text:JSON.stringify({status:'completed',summary:'SDK contract fixture only'})}];
  const message={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,stopReason,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
  stream.push({type:'done',reason:stopReason,message});stream.end();return stream;
 };return result;
}`);
 process.env.DRAKEN_FACTORY_PI_SDK=path.join(sdk,'dist/index.js');const operations=[];
 const workflow={id:'fixture',revision:'1',locationKey:'fixture',purpose:'Repair parser',appliesWhen:'Bug',method:['Reproduce','Fix'],limitations:[]},saved=require('./fixtures/workflow-enrichment.cjs')(workflow);
 const result=await runAgent({directory:path.join(root,'run'),brief:{...sessionPlan(workflow,'Fix parser','fixture',saved,4),repository:root,locationKey:'fixture',commit:'fixture'},environment:{},invoke:async r=>{operations.push(r.op);if(r.op==='read')return {base64:Buffer.from('module.exports = 1;').toString('base64')};if(r.op==='access')return {};throw Error('Unexpected operation');},authorize:async()=>{},signal:new AbortController().signal,record:()=>{},maxCalls:4});
 assert.equal(result.modelCalls,2);assert.equal(result.completedCalls,2);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'run/enrichment.json'))),saved);assert.equal(result.accountingComplete,true);assert.ok(operations.includes('read'));
 const metadata=JSON.parse(fs.readFileSync(path.join(root,'run/session.json'))),messages=fs.readFileSync(metadata.file,'utf8').trim().split('\n').map(JSON.parse);assert.equal(messages.filter(e=>e.type==='message'&&e.message.role==='assistant').length,2);
 console.log(JSON.stringify({directory:root,sdk:pkg.version,oneSession:true,savedEnrichmentReused:true,containerAdapterInvoked:true,simulatedRequests:2,providerRequests:0}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
