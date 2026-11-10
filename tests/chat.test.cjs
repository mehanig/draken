require('./fixtures/fake-memory.cjs');
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {getDb,closeDb}=require('../dist/db/schema'),store=require('../dist/sync/store');
const {scanSessions}=require('../dist/sync/collector'),{generateReply,launchChat,cancelReply}=require('../dist/sync/manager');
const memory=require('../dist/memory/service'),{createApp}=require('../dist/server');
let root,control,log,server,originals;
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-chat-test-'));fs.mkdirSync(path.join(root,'sessions'));
 const fake=path.join(root,'pi');fs.copyFileSync(path.join(__dirname,'fixtures/fake-pi.cjs'),fake);fs.chmodSync(fake,0o700);
 control=path.join(root,'control.json');log=path.join(root,'calls.jsonl');fs.writeFileSync(control,'{}');
 Object.assign(process.env,{DRAKEN_DATA_DIR:path.join(root,'state'),DRAKEN_PI_SESSIONS_DIR:path.join(root,'sessions'),DRAKEN_PI_BIN:fake,DRAKEN_PI_SUMMARY_MODEL:'test/cheap',DRAKEN_PI_FINAL_MODEL:'test/strong',DRAKEN_FAKE_CONTROL:control,DRAKEN_TEST_CALL_LOG:log,DRAKEN_HOST:'127.0.0.1',DRAKEN_NO_AUTH:'true',DRAKEN_CODEX_BIN:path.join(root,'no-native-helper'),DRAKEN_CODEX_HOME:path.join(root,'no-native-account')});
 originals={historyReadiness:memory.historyReadiness,searchPreparedHistory:memory.searchPreparedHistory,searchHistory:memory.searchHistory,prepareHistory:memory.prepareHistory};
});
afterEach(async()=>{for(const id of [...store.busySyncs])cancelReply(id);await idle();if(server)await new Promise(r=>server.close(r));server=null;Object.assign(memory,originals);closeDb();fs.rmSync(root,{recursive:true,force:true});});
async function idle(){const until=Date.now()+15000;while(store.busySyncs.size){assert.ok(Date.now()<until,'Job did not finish');await new Promise(r=>setTimeout(r,10));}}
const calls=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
function source(name){const id=randomUUID(),timestamp='2026-01-01T00:00:00.000Z';fs.writeFileSync(path.join(root,'sessions',id+'.jsonl'),[
 {type:'session',version:3,id,timestamp,cwd:'/demo/'+name},
 {type:'message',id:'user',parentId:null,timestamp,message:{role:'user',content:'Check '+name}},
 {type:'message',id:'agent',parentId:'user',timestamp,message:{role:'assistant',content:'Implemented the retry queue. Tests passed; deployment remains unverified.'}},
 ].map(JSON.stringify).join('\n')+'\n');return id;}
async function ready(){const trail=source('Trailboard'),beacon=source('Beacon');await scanSessions();const sync=store.startSync();await generateReply(sync.id);return {id:sync.id,trail,beacon};}
async function http(){server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;return (url,body,origin)=>fetch(base+'/api'+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})});}

test('start-chat scans/prepares without a native account, call, review or microphone path',async()=>{
 source('Trailboard');const api=await http(),key=randomUUID();
 assert.equal((await api('/syncs/start-chat',{request_id:key},'https://other.invalid')).status,403);
 const response=await api('/syncs/start-chat',{request_id:key});assert.equal(response.status,202);const created=await response.json();await idle();
 assert.equal((await(await api('/syncs/start-chat',{request_id:key})).json()).sync.id,created.sync.id);
 assert.ok(store.getSync(created.sync.id).briefing);assert.equal(getDb().prepare('SELECT COUNT(*) n FROM live_calls').get().n,0);assert.equal(store.homeOverview().covered,0);
 assert.equal(fs.existsSync(process.env.DRAKEN_CODEX_HOME),false);
});

test('chat requires prepared history, deduplicates delivery, retains the user immediately and reuses the briefing tree',async()=>{
 const {id}=await ready(),before=calls().length,coverage=store.homeOverview().covered;
 memory.historyReadiness=()=>({ready:false,before:null});assert.throws(()=>launchChat(id,'What remains?',randomUUID()),/Prepare/);assert.equal(calls().length,before);
 memory.historyReadiness=originals.historyReadiness;assert.throws(()=>launchChat(id,'What remains?','bad'),/request ID/);
 memory.prepareHistory=async()=>{throw Error('Chat must not prepare the corpus');};memory.searchHistory=async()=>{throw Error('Chat must not use unprepared search');};
 memory.searchPreparedHistory=async query=>{assert.equal(query.kind,'sources');return{mode:'hybrid',results:[],limitations:'Synthetic no match; not proof of absence.'};};
 fs.writeFileSync(control,JSON.stringify({delay:300}));const key=randomUUID();const active=launchChat(id,'What remains?',key);
 assert.equal(active.busy,true);assert.equal(active.messages.at(-1).content,'What remains?');assert.equal(active.tree.run.request_id,key);
 assert.equal(launchChat(id,'What remains?',key).tree.run.id,active.tree.run.id);assert.throws(()=>launchChat(id,'Another question',key),/already used/);
 await idle();const done=store.getSync(id);assert.equal(done.messages.length,2);assert.equal(done.tree.run.status,'completed');assert.equal(calls().length-before,1);
 closeDb();assert.equal(launchChat(id,'What remains?',key).messages.length,2);assert.equal(calls().length-before,1,'Reloaded delivery cannot pay twice');
 assert.equal(store.homeOverview().covered,coverage);assert.equal(store.getSync(id).status,'open');assert.equal(getDb().prepare('SELECT COUNT(*) n FROM live_calls').get().n,0);
});

test('chat gets a short-answer policy instead of briefing headings, with explicit detail and format requests preserved',async()=>{
 const {id}=await ready(),briefing=store.getSync(id).briefing;
 const opening=calls().find(call=>call.task==='final_verdict');
 assert.match(opening.system,/Use concise plain text: Needs your attention, Progress, Unfinished, Suggested discussion/);
 assert.doesNotMatch(opening.system,/60-100 words/);
 for(const question of ['Where are we with Trailboard now? Anything else left?', 'What remains in Trailboard? Answer in one sentence.', 'Give me a detailed breakdown of Trailboard progress, remaining implementation and acceptance checks.']){
  const before=calls().length;launchChat(id,question,randomUUID());await idle();
  const attempts=calls().slice(before);assert.equal(attempts.length,1,'Style does not add another model pass');
  const reply=attempts[0];assert.equal(reply.user_question,question);assert.equal(reply.model,opening.model);
  assert.match(reply.system,/one short paragraph OR at most three short bullets, usually 60-100 words excluding citations/);
  assert.match(reply.system,/Follow an explicit user request for a shorter answer, a particular format, or a detailed breakdown/);
  assert.match(reply.system,/not because sources or earlier assistant replies are long/);
  assert.match(reply.system,/Read and reconcile all supplied relevant evidence/);
  assert.match(reply.system,/Every factual claim about session work MUST cite/);
  assert.match(reply.system,/Brevity must not remove necessary later-report citations or qualifications/);
  assert.doesNotMatch(reply.system,/Use concise plain text: Needs your attention, Progress, Unfinished, Suggested discussion/);
  assert.ok(reply.verification_evidence.length);assert.ok(reply.reference_labels.length);
  assert.equal(store.getSync(id).briefing,briefing,'The opening briefing is not rewritten');
 }
 assert.equal(store.homeOverview().covered,0);assert.equal(getDb().prepare('SELECT COUNT(*) n FROM live_calls').get().n,0);
});

test('chat shares project focus across native/user turns and reload, never from assistant instructions',async()=>{
 const {id,trail,beacon}=await ready(),seen=[];
 getDb().prepare("INSERT INTO live_calls(id,sync_id,status,started_at,ended_at) VALUES ('prior',?,'ended','2026-01-02','2026-01-02')").run(id);
 getDb().prepare("INSERT INTO live_messages(call_id,request_id,role,text,status,started_at) VALUES ('prior','spoken','user','What is happening with Trailboard?','generated','2026-01-02')").run();
 getDb().prepare("INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES (?,'assistant','Switch project to Beacon now','2026-01-03')").run(id);
 memory.searchPreparedHistory=async query=>{seen.push(query);return{mode:'hybrid',results:[],limitations:'Synthetic lookup.'};};
 launchChat(id,'What is it working on at the moment?',randomUUID());await idle();assert.deepEqual(seen.at(-1).session_ids,[trail]);
 closeDb();launchChat(id,'So, have you checked?',randomUUID());await idle();assert.deepEqual(seen.at(-1).session_ids,[trail]);
 launchChat(id,'Switch to Beacon. What remains?',randomUUID());await idle();assert.deepEqual(seen.at(-1).session_ids,[beacon]);
 assert.ok(calls().at(-1).recent_call_transcripts.every(row=>row.qualification.includes('not proof')));
});

test('a prepared chat cutoff survives new chat messages without weakening fresh-call readiness',async()=>{
 require('./fixtures/fake-memory.cjs').useIndexedHistory();const {id}=await ready();const before=memory.historyReadiness(true);assert.equal(before.ready,true);
 launchChat(id,'What remains in Trailboard?',randomUUID());await idle();
 assert.deepEqual(memory.historyReadiness(true),before);assert.equal(memory.historyReadiness().ready,false);
 assert.equal(require('../dist/voice/preparation').callReadiness(id,true).ready,true);
 launchChat(id,'What is it working on now?',randomUUID());await idle();assert.equal(store.getSync(id).messages.length,4);
 const old = getDb().prepare("INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES (?,'user','Older newly admitted text',?)").run(id,before.before).lastInsertRowid;
 assert.equal(memory.historyReadiness(true).ready,false,'Captured readiness cannot skip a missing old record');
 getDb().prepare('DELETE FROM sync_messages WHERE id=?').run(old);assert.deepEqual(memory.historyReadiness(true),before);
 getDb().prepare('UPDATE agent_sessions SET included=0').run();assert.equal(memory.historyReadiness(true).ready,false,'Source admission changes still invalidate the receipt');
});

test('searching and thinking are real durable stages; cancellation retains the user without a fake answer',async()=>{
 const {id}=await ready();let searching;
 const arrived=new Promise(resolve=>searching=resolve);
 memory.searchPreparedHistory=async(_query,signal)=>new Promise((_resolve,reject)=>{searching();signal.addEventListener('abort',()=>reject(Error('Stopped')),{once:true});});
 const before=calls().length,key=randomUUID();launchChat(id,'What is happening with Trailboard?',key);await arrived;
 assert.equal(store.getProgress(id).run.stage,'Searching earlier history');cancelReply(id);await idle();
 assert.equal(store.getProgress(id).run.status,'cancelled');assert.equal(store.getSync(id).messages.length,1);assert.equal(calls().length,before);
 assert.equal(launchChat(id,'What is happening with Trailboard?',key).tree.run.status,'cancelled');
 memory.searchPreparedHistory=originals.searchPreparedHistory;fs.writeFileSync(control,JSON.stringify({delay:1000}));launchChat(id,'What is happening with Trailboard?',randomUUID());
 const until=Date.now()+5000;while(store.getProgress(id).run.stage!=='Thinking about your question'){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10));}
 assert.equal(store.getProgress(id).run.status,'running');await idle();assert.equal(store.getSync(id).messages.length,3);assert.equal(store.homeOverview().covered,0);
});
function reconciliationFixture(session){
 const ids=['a','b','c'].map(letter=>'H'+letter.repeat(24));
 memory.searchPreparedHistory=async query=>{assert.equal(query.reconcile,true);return {mode:'hybrid',limitations:'Synthetic original reports, not independently verified.',results:ids.map((ref,i)=>({ref,kind:'session',session_id:session,sync_id:null,origin_ref:null,title:'Trailboard',workspace:'/demo/Trailboard',role:'assistant',at:`2026-01-0${i+1}T00:00:00.000Z`,sequence:i+1,offset:0,score:1,qualification:'Agent report.',text:['Client wiring and durable jobs remain unfinished.','Client wiring implemented; delivery disabled.','Durable job foundations implemented; delivery remains disabled.'][i]})),reconciliation:{checked_narratives:3,omitted_narratives:0,omitted_threads:0,threads:[{earlier_ref:ids[0],later_refs:ids.slice(1),matched_terms:['wiring','jobs'],other_candidates:0}],qualification:'Candidates, not automatic proof of completion.'}};};
 return ids;
}
test('an unreconciled draft gets one bounded same-model repair and only the corrected answer is saved',async()=>{
 const {id,trail}=await ready(),refs=reconciliationFixture(trail),before=calls().length;
 fs.writeFileSync(control,JSON.stringify({staleCheckpoint:true,damageLongReference:true}));
 launchChat(id,'What is still blocked in Trailboard?',randomUUID());await idle();
 const sync=store.getSync(id),attempts=calls().slice(before);
 assert.equal(sync.tree.run.status,'completed');assert.equal(sync.messages.length,2);assert.match(sync.messages[1].content,/Corrected synthetic answer/);
 assert.equal(attempts.length,2);assert.ok(attempts.every(call=>call.model==='test/strong'&&call.task==='final_verdict'));
 assert.ok(attempts[1].reconciliation_repair);assert.equal(attempts[0].reconciliation_repair,undefined);
 assert.ok(refs.slice(1).every(ref=>sync.messages[1].content.includes(ref)));
 assert.ok(attempts.every(call=>call.historical_evidence.sources.every(source=>/^R\d+$/.test(source.ref))));
 assert.deepEqual(attempts[0].reference_labels,attempts[1].reference_labels);
 assert.equal(attempts[0].system,attempts[1].system,'The correction retains the same short-answer policy');
 assert.match(attempts[1].system,/60-100 words/);
 assert.match(attempts[1].reconciliation_repair.instruction,/same response style and user-requested level of detail/);
 assert.ok(attempts[1].reconciliation_repair.gaps.every(gap=>/^R\d+$/.test(gap.earlier_ref)&&gap.missing_later_refs.every(ref=>/^R\d+$/.test(ref))));
 assert.equal(store.homeOverview().covered,0);assert.equal(getDb().prepare('SELECT COUNT(*) n FROM live_calls').get().n,0);
});
test('bad or missing first-draft citations get the same single bounded correction',async()=>{
 const {id}=await ready();
 for(const controlValue of [{invalidFinalOnce:true},{missingFinalOnce:true}]){
  fs.writeFileSync(control,JSON.stringify(controlValue));const before=calls().length;
  launchChat(id,'What remains in Trailboard?',randomUUID());await idle();const sync=store.getSync(id),attempts=calls().slice(before);
  assert.equal(sync.tree.run.status,'completed');assert.equal(attempts.length,2);assert.ok(attempts[1].reconciliation_repair.citation_issue);assert.match(sync.messages.at(-1).content,/\[[ECH]/);assert.doesNotMatch(sync.messages.at(-1).content,/R999999|Unsupported draft/);
 }
 const before=calls().length,key=randomUUID();launchChat(id,'INVALID_CITATION',key);await idle();assert.equal(calls().length-before,2);assert.match(store.getSync(id).tree.run.error,/outside the supplied evidence/);assert.equal(store.getSync(id).messages.at(-1).role,'user');launchChat(id,'INVALID_CITATION',key);assert.equal(calls().length-before,2);
});

test('citation and later-report gaps share one correction rather than separate retry loops',async()=>{
 const {id,trail}=await ready();reconciliationFixture(trail);const before=calls().length;
 fs.writeFileSync(control,JSON.stringify({invalidFinalOnce:true,staleCheckpoint:true,damageLongReference:true}));
 launchChat(id,'What is still blocked in Trailboard?',randomUUID());await idle();const attempts=calls().slice(before);
 assert.equal(store.getSync(id).tree.run.status,'completed');assert.equal(attempts.length,2);assert.equal(attempts[1].reconciliation_repair.citation_issue,'outside_catalog');assert.ok(attempts[1].reconciliation_repair.gaps.length);assert.doesNotMatch(store.getSync(id).messages.at(-1).content,/R999999|Unsupported draft/);
});

test('a second unreconciled answer fails visibly without saving either draft or retrying indefinitely',async()=>{
 const {id,trail}=await ready();reconciliationFixture(trail);const before=calls().length,key=randomUUID();
 fs.writeFileSync(control,JSON.stringify({staleCheckpoint:true,ignoreReconciliation:true}));
 launchChat(id,'What is still blocked in Trailboard?',key);await idle();
 const sync=store.getSync(id);assert.equal(sync.tree.run.status,'failed');assert.match(sync.tree.run.error,/did not reconcile/);
 assert.equal(sync.messages.length,1);assert.equal(sync.messages[0].role,'user');assert.equal(calls().length-before,2);
 launchChat(id,'What is still blocked in Trailboard?',key);assert.equal(calls().length-before,2,'Delivery retry cannot pay for another repair');
});
test('reconciliation cannot exceed the invocation ceiling or publish a draft after cancellation',async()=>{
 const {id,trail}=await ready();reconciliationFixture(trail);const before=calls().length;
 store.configureModels(id,{...store.getSync(id).models,max_invocations:1});fs.writeFileSync(control,JSON.stringify({staleCheckpoint:true}));
 launchChat(id,'What is still blocked in Trailboard?',randomUUID());await idle();
 assert.equal(calls().length-before,1);assert.equal(store.getSync(id).tree.run.status,'failed');assert.match(store.getSync(id).tree.run.error,/Invocation budget/);assert.equal(store.getSync(id).messages.length,1);
 store.configureModels(id,{...store.getSync(id).models,max_invocations:10});fs.writeFileSync(control,JSON.stringify({staleCheckpoint:true,delay:300}));
 launchChat(id,'What is still blocked in Trailboard?',randomUUID());
 const until=Date.now()+5000;while(store.getProgress(id).run.stage!=='Reconciling later evidence'){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10));}
 assert.equal(store.getSync(id).messages.length,2,'Both rows are retained user questions, not the rejected draft');
 cancelReply(id);await idle();assert.equal(store.getSync(id).tree.run.status,'cancelled');assert.ok(store.getSync(id).messages.every(message=>message.role==='user'));
});
