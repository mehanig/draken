// Optional network-to-npm qualification. Private HOME, no real accounts or
// source histories. The only inference endpoint is our synthetic loopback SSE.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict'),{execFileSync,spawnSync}=require('node:child_process');
process.umask(0o077);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-runtime-smoke-')),home=path.join(root,'home');
fs.mkdirSync(home);
const env={};for(const key of ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),DRAKEN_DATA_DIR:path.join(root,'state'),PI_OFFLINE:'1',PI_TELEMETRY:'0'});
for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,env);
const cli=path.join(__dirname,'../dist/cli.js');
const run=args=>execFileSync(process.execPath,[cli,...args],{env,encoding:'utf8',timeout:600000,maxBuffer:4*1024*1024});
const text='Synthetic result\u2028🐉; deployment not checked.';let requests=0,reported=true;
const server=http.createServer((req,res)=>{
 let body='';req.on('data',part=>{body+=part;if(body.length>64000)req.destroy();});req.on('end',()=>{
  assert.equal(req.url,'/v1/responses');assert.equal(req.headers.authorization,'Bearer synthetic-fixture-key');
  const value=JSON.parse(body);assert.equal(value.tools?.length||0,0);assert.equal(value.model,'summary');requests++;
  res.writeHead(200,{'content-type':'text/event-stream'});let sequence=0;
  const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:sequence++,...data})}\n\n`);
  const base={id:'resp_synthetic',object:'response',created_at:Math.floor(Date.now()/1000),model:'summary',status:'in_progress',output:[]};
  const item={type:'message',id:'msg_synthetic',role:'assistant',status:'in_progress',content:[]};
  send('response.created',{response:base});send('response.output_item.added',{output_index:0,item});
  send('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  send('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:text});
  send('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text});
  const part={type:'output_text',text,annotations:[]},done={...item,status:'completed',content:[part]};
  send('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part});send('response.output_item.done',{output_index:0,item:done});
  send('response.completed',{response:{...base,status:'completed',output:[done],...(reported?{usage:{input_tokens:120,input_tokens_details:{cached_tokens:20},output_tokens:10,output_tokens_details:{reasoning_tokens:2},total_tokens:130}}:{})}});res.end();
 });
});
(async()=>{
 const install=run(['setup','--yes']);assert.match(install,/Private pi selected/);
 const {selectedPi,piPaths,PI_VERSION}=require('../dist/pi/runtime');
 const selected=selectedPi();assert.equal(selected.source,'managed');
 assert.equal(execFileSync(selected.binary,[...selected.prefix,'--version'],{env:selected.env,encoding:'utf8'}).trim(),PI_VERSION);
 const auth=spawnSync(selected.binary,[...selected.prefix,'auth','check','--model','openai/gpt-6-luna','--json','--no-refresh'],{env:selected.env,encoding:'utf8',timeout:20000});
 assert.equal(auth.status,1);assert.equal(JSON.parse(auth.stdout).reason,'credentials_not_configured');
 assert.equal(fs.existsSync(path.join(piPaths().agent,'auth.json')),false);
 run(['voice','setup']);
 const voice=JSON.parse(run(['voice','status']));
 assert.equal(voice.installed,true);assert.equal(voice.nativeLoginPresent,false);assert.equal(voice.readyForProbe,false);assert.equal(voice.audioVerified,false);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 fs.writeFileSync(path.join(piPaths().agent,'models.json'),JSON.stringify({providers:{'usage-fixture':{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-responses',apiKey:'synthetic-fixture-key',models:[{id:'summary',reasoning:true,input:['text'],contextWindow:32768,maxTokens:1024,cost:{input:1,output:2,cacheRead:.1,cacheWrite:1}}]}}}));
 const {invokePi}=require('../dist/sync/pi');let accounting;
 const options={model:'usage-fixture/summary',system:'Read-only synthetic protocol qualification.',thinking:'off',timeoutMs:30000,onAccounting:value=>accounting=value};
 assert.equal(await invokePi('Return the synthetic fixture result.',options),text);
 assert.equal(accounting.complete,true);assert.equal(accounting.responses,1);assert.ok(Math.abs(accounting.cost_usd-.000122)<1e-12);
 assert.deepEqual(accounting.tokens,{input:100,output:10,cache_read:20,cache_write:0,reasoning:2});
 reported=false;assert.equal(await invokePi('Return the synthetic result without usage.',options),text);
 assert.equal(accounting.cost_usd,null);assert.equal(accounting.complete,false);assert.equal(requests,2);
 console.log(JSON.stringify({platform:process.platform,privatePi:PI_VERSION,voice,syntheticLoopbackRequests:requests,realProviderCalls:0,realCredentialsUsed:false}));
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{
 await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});
});
