import fs from 'node:fs';
import path from 'node:path';
export const SettingsManager={inMemory:value=>value};
export const ModelRuntime={create:async()=>({getModel:()=>({id:'fixture',provider:'fixture'})})};
export const createExtensionRuntime=()=>({});
export const SessionManager={create:(_cwd,dir)=>{fs.mkdirSync(dir,{recursive:true});return {getSessionId:()=> 'fixture-session',getSessionFile:()=>path.join(dir,'fixture.jsonl')};}};
const factory=name=>(_cwd,options)=>({name,parameters:{type:'object',properties:{}},execute:async(_id,args)=>{
 if(!options?.operations)throw Error('Host fallback was invoked');
 if(name==='read')return options.operations.readFile(args.path);
 if(name==='write')return options.operations.writeFile(args.path,args.content);
 if(name==='edit'){const old=await options.operations.readFile(args.path);return options.operations.writeFile(args.path,old.toString()+args.content);}
 throw Error('Unexpected built-in bash execution');
}});
export const createReadTool=factory('read'),createWriteTool=factory('write'),createEditTool=factory('edit'),createBashTool=factory('bash');
export async function createAgentSession(options){
 if(options.settingsManager.compaction.enabled||options.settingsManager.retry.enabled||options.settingsManager.cacheWarming!=='off')throw Error('Automatic model work enabled');
 if(options.resourceLoader.getExtensions().extensions.length||options.resourceLoader.getAgentsFiles().agentsFiles.length)throw Error('Resource discovery enabled');
 const listeners=[],controller=new AbortController();const active=options.tools;let answer='',prompts=0;
 const session={messages:[],agent:{streamFunction:async()=>{fs.appendFileSync(path.join(options.cwd,'fixture-provider-calls'),'call\n');}},getActiveToolNames:()=>[...active],subscribe:f=>listeners.push(f),clearQueue:()=>{},abort:async()=>{controller.abort();},dispose:()=>{},getLastAssistantText:()=>answer,
 prompt:async text=>{
  if(++prompts!==1)throw Error('Run must not add an enrichment prompt');
  if(!options.resourceLoader.getSystemPrompt().includes('normal Docker bridge network access'))throw Error('Agent was not told normal networking is available');
  if(active.join(',')!=='read,write,edit,bash'||!text.includes('factory-workflow-enrichment-v4'))throw Error('Execution did not receive saved enrichment');
  for(let i=0;i<2;i++){
   await session.agent.streamFunction({},{});
   if(i===0&&text.includes('"task":"fixture-edit-files"')){
    for(const file of ['verify.cjs','package.json','tests/existing.cjs','scripts/existing.cjs','.github/workflows/existing.yml'])await options.customTools.find(t=>t.name==='write').execute('edit',{path:file,content:'changed by workflow\n'},controller.signal);
    const result=await options.customTools.find(t=>t.name==='bash').execute('check',{command:'test "$WORKFLOW_TEST_TOKEN" = configured-for-worker && test "$(git rev-list --count HEAD)" = 2 && test "$(git remote get-url origin)" = https://github.com/mehanig/draken.git && git add . && git commit -qm "Workflow edits"'},controller.signal);if(result.isError)throw Error('Ordinary configured tools failed');
   }
   if(text.includes('"task":"fixture-cancel"')){
    await options.customTools.find(t=>t.name==='write').execute('write',{path:'cancelled.txt',content:'retained before cancellation\n'},controller.signal);
    for(const listener of listeners)listener({type:'tool_execution_start',toolName:'bash',toolCallId:'long-command'});
    await options.customTools.find(t=>t.name==='bash').execute('long-command',{command:'sleep 240'},controller.signal);
   }
   answer=JSON.stringify(text.includes('"task":"fixture-blocked"')?{status:'blocked',summary:'Missing workflow credential'}:{status:'completed',summary:'Fixture finished'});
  const message={role:'assistant',stopReason:'stop',usage:{input:10,output:2,cacheRead:0,cacheWrite:0,cost:{total:0.001}}};session.messages.push(message);
  for(const listener of listeners)listener({type:'message_end',message});
  }
  for(const listener of listeners)listener({type:'agent_settled'});
 }};return {session};
}
