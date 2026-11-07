const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PiOutput}=require('../dist/sync/pi-output');
const usage={input:100,output:10,cacheRead:20,cacheWrite:5,reasoning:2,totalTokens:135,cost:{input:.001,output:.002,cacheRead:.0001,cacheWrite:.0002,total:.0033}};
const message=(text='hello',extra={})=>({role:'assistant',provider:'fixture',model:'cheap',content:[{type:'thinking',thinking:'PRIVATE_THINKING',signature:'PRIVATE_SIGNATURE'},{type:'text',text}],stopReason:'stop',usage,...extra});
const start={type:'message_start',message:{role:'assistant',content:[]}};
const end=message=>({type:'message_end',message});
const settled={type:'agent_settled',aborted:false};
const send=(parser,...events)=>parser.push(events.map(JSON.stringify).join('\n')+'\n');

test('strict LF stream extracts Unicode text, ignores thinking/echoes and counts final usage once',()=>{
 const parser=new PiOutput(64000,false),msg=message('hello\u2028🐉\u2029done');
 const events=[{type:'session',version:3},{type:'agent_start'},{type:'message_end',message:{role:'user',content:'PRIVATE_PROMPT'.repeat(10000)}},start,
 {type:'message_update',usage,assistantMessageEvent:{type:'text_delta',delta:'hello'}},{type:'message_update',usage,assistantMessageEvent:{type:'thinking_delta',delta:'PRIVATE_THINKING'}},end(msg),end(msg),{type:'turn_end',message:msg},{type:'agent_end',messages:[msg]},settled];
 const wire=events.map(JSON.stringify).join('\r\n')+'\r\n';for(let at=0;at<wire.length;at+=71)parser.push(wire.slice(at,at+71));
 const accounting=parser.finish(true);assert.equal(parser.result(),msg.content[1].text);assert.equal(accounting.cost_usd,.0033);assert.equal(accounting.responses,1);assert.equal(accounting.complete,true);
 assert.deepEqual(accounting.tokens,{input:100,output:10,cache_read:20,cache_write:5,reasoning:2});assert.deepEqual(accounting.models,['fixture/cheap']);
 assert.doesNotMatch(JSON.stringify(accounting),/PRIVATE_|hello|signature|content/);
});
test('multiple turns and compaction cost are included without counting repeated terminal information',()=>{
 const p=new PiOutput(64000,false);send(p,start,end(message('failed',{stopReason:'error'})),{type:'compaction_end',result:{usage,summary:'PRIVATE_COMPACTION'}},start,end(message()),settled);
 const a=p.finish(true);assert.equal(a.responses,3);assert.ok(Math.abs(a.cost_usd-.0099)<1e-12);assert.equal(a.complete,true);assert.equal(p.result(),'hello');assert.doesNotMatch(JSON.stringify(a),/PRIVATE_/);
});
test('missing, zero-filled, malformed usage and zero/invalid catalog pricing are unavailable, not free',()=>{
 for(const value of [undefined,{...usage,input:-1},{...usage,reasoning:11},{input:0,output:0,cacheRead:0,cacheWrite:0,cost:usage.cost},{...usage,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},{...usage,cost:{...usage.cost,total:999}},{...usage,cost:{...usage.cost,total:'0.1'}}]){
  const p=new PiOutput(64000,false);send(p,start,end(message('hello',{usage:value})),settled);const a=p.finish(true);assert.equal(a.cost_usd,null);assert.equal(a.complete,false);assert.equal(p.result(),'hello');
 }
});
test('failed retry with unknown usage leaves a partial subtotal, not a complete total',()=>{
 const p=new PiOutput(64000,false);send(p,start,end(message('',{usage:undefined,stopReason:'error'})),{type:'auto_retry_start'},start,end(message()),settled);
 const a=p.finish(true);assert.equal(a.cost_usd,.0033);assert.equal(a.complete,false);assert.equal(a.responses,2);assert.equal(p.result(),'hello');
});
test('cancellation retains latest cumulative usage as partial, never sums streaming updates',()=>{
 const p=new PiOutput(64000,false);send(p,start,{type:'message_update',usage,assistantMessageEvent:{type:'text_delta',delta:'unfinished'}},{type:'message_update',usage,assistantMessageEvent:{type:'thinking_delta',delta:'hidden'}});
 const a=p.finish(false);assert.equal(a.cost_usd,.0033);assert.equal(a.responses,1);assert.equal(a.complete,false);assert.throws(()=>p.result(),/settled/);
});
test('unsettled/truncated/error responses fail even when some price was reported',()=>{
 for(const reason of ['length','error','aborted','toolUse']){const p=new PiOutput(64000,false);send(p,start,end(message('partial',{stopReason:reason})),settled);p.finish(true);assert.throws(()=>p.result(),/No incomplete result/);}
 const p=new PiOutput(64000,false);send(p,start,end(message()));assert.equal(p.finish(true).complete,false);assert.throws(()=>p.result(),/settled/);
 const q=new PiOutput(64000,false);send(q,start,end(message()),settled);q.push('{"type":"unclosed"}');assert.equal(q.finish(true).complete,false);assert.throws(()=>q.result(),/settled/);
});
test('JSON framing, per-record/output limits and tool-free boundary fail closed without echoing payloads',()=>{
 const p=new PiOutput(10,false);assert.throws(()=>p.push('PRIVATE_INVALID_JSON\n'),/Invalid pi JSON event stream/);
 const q=new PiOutput(10,true);send(q,start);assert.throws(()=>send(q,{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'🐉'.repeat(3)}}),/too much output/);
 const r=new PiOutput(10,true);send(r,start);assert.throws(()=>send(r,end(message('🐉'.repeat(3)))),/too much output/);
 assert.throws(()=>new PiOutput(10,false).push('x'.repeat(8*1024**2+1)),/safety limit/);
 assert.throws(()=>send(new PiOutput(10,false),{type:'tool_execution_start',args:{command:'PRIVATE_COMMAND'}}),/Unexpected tool activity/);
});
