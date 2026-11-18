require('./fixtures/fake-memory.cjs');
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {getDb,closeDb}=require('../dist/db/schema'),store=require('../dist/sync/store');
const {activity}=require('../dist/sync/activity');
const {scanSessions}=require('../dist/sync/collector'),{generateReply,launchChat,cancelReply}=require('../dist/sync/manager');
const memory=require('../dist/memory/service'),{createApp}=require('../dist/server');
let root,control,log,server,originals;
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-chat-test-'));fs.mkdirSync(path.join(root,'sessions'));
 const fake=path.join(root,'pi');fs.copyFileSync(path.join(__dirname,'fixtures/fake-pi.cjs'),fake);fs.chmodSync(fake,0o700);
 control=path.join(root,'control.json');log=path.join(root,'calls.jsonl');fs.writeFileSync(control,'{}');
 Object.assign(process.env,{DRAKEN_DATA_DIR:path.join(root,'state'),DRAKEN_PI_SESSIONS_DIR:path.join(root,'sessions'),DRAKEN_PI_BIN:fake,DRAKEN_PI_SUMMARY_MODEL:'test/cheap',DRAKEN_PI_FINAL_MODEL:'test/strong',DRAKEN_FAKE_CONTROL:control,DRAKEN_TEST_CALL_LOG:log,DRAKEN_HOST:'127.0.0.1',DRAKEN_NO_AUTH:'true',DRAKEN_CODEX_BIN:path.join(root,'no-native-helper'),DRAKEN_CODEX_HOME:path.join(root,'no-native-account')});
 originals={readHistory:memory.readHistory,historyReadiness:memory.historyReadiness,searchPreparedHistory:memory.searchPreparedHistory,searchHistory:memory.searchHistory,prepareHistory:memory.prepareHistory};
});
afterEach(async()=>{for(const id of activity.busyIds)cancelReply(id);await idle();if(server)await new Promise(r=>server.close(r));server=null;Object.assign(memory,originals);closeDb();fs.rmSync(root,{recursive:true,force:true});});
async function idle(){const until=Date.now()+15000;while(activity.busy){assert.ok(Date.now()<until,'Job did not finish');await new Promise(r=>setTimeout(r,10));}}
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

test('chat requires prepared history, deduplicates delivery and retains the user immediately',async()=>{
 const {id}=await ready(),before=calls().length,coverage=store.homeOverview().covered;
 const prepared=store.getSync(id).conversation.history_before;getDb().prepare('UPDATE syncs SET conversation_before=NULL WHERE id=?').run(id);
 assert.throws(()=>launchChat(id,'What remains?',randomUUID()),/Prepare/);assert.equal(calls().length,before);
 getDb().prepare('UPDATE syncs SET conversation_before=? WHERE id=?').run(prepared,id);
 memory.historyReadiness=()=>({ready:false,before:null});assert.throws(()=>launchChat(id,'What remains?','bad'),/request ID/);
 memory.prepareHistory=async()=>{throw Error('Chat must not prepare the corpus');};memory.searchHistory=async()=>{throw Error('Chat must not use unprepared search');};
 memory.searchPreparedHistory=async query=>{assert.equal(query.kind,'sources');return{mode:'hybrid',results:[],limitations:'Synthetic no match; not proof of absence.'};};
 fs.writeFileSync(control,JSON.stringify({delay:300}));const key=randomUUID();const active=launchChat(id,'What remains?',key);
 assert.equal(active.busy,true);assert.equal(active.messages.at(-1).content,'What remains?');assert.equal(active.tree.run.request_id,key);
 assert.equal(launchChat(id,'What remains?',key).tree.run.id,active.tree.run.id);assert.throws(()=>launchChat(id,'Another question',key),/already used/);
 await idle();const done=store.getSync(id);assert.equal(done.messages.length,2);assert.equal(done.tree.run.status,'completed');assert.equal(calls().length-before,1);
 closeDb();assert.equal(launchChat(id,'What remains?',key).messages.length,2);assert.equal(calls().length-before,1,'Reloaded delivery cannot pay twice');
 assert.equal(store.homeOverview().covered,coverage);assert.equal(store.getSync(id).status,'open');assert.equal(getDb().prepare('SELECT COUNT(*) n FROM live_calls').get().n,0);
});

test('actual chat route survives appended/scanned originals and adopts newly indexed H evidence only on the next turn',async()=>{
 require('./fixtures/fake-memory.cjs').useIndexedHistory();const {id,trail}=await ready(),api=await http();
 const initial=store.getSync(id),originalItems=JSON.stringify(initial.items),before=initial.conversation.history_before;
 assert.equal((await api(`/syncs/${id}/chat/messages`,{message:'What remains in Trailboard?',request_id:randomUUID()})).status,202);await idle();
 await new Promise(r=>setTimeout(r,5));const timestamp=new Date().toISOString();
 fs.appendFileSync(path.join(root,'sessions',trail+'.jsonl'),JSON.stringify({type:'message',id:'later',parentId:'agent',timestamp,message:{role:'assistant',content:'Trailboard delivery service enabled and validated with synthetic acceptance checks. Fresh original update.'}})+'\n');
 await scanSessions();assert.equal(memory.historyReadiness().ready,false);
 assert.equal(require('../dist/sync/preparation').callReadiness(id,true).ready,true);
 assert.equal(require('../dist/sync/preparation').callReadiness(id,false).ready,true,'New source evidence cannot block prepared voice readiness either');
 assert.equal((await api(`/syncs/${id}/chat/messages`,{message:'What remains in Trailboard?',request_id:randomUUID()})).status,202);await idle();
 assert.equal(store.getSync(id).tree.run.status,'completed');assert.equal(store.getSync(id).conversation.history_before,before);
 await memory.prepareHistory(new Date().toISOString(),new AbortController().signal);
 const next=memory.historyReadiness(true).before;assert.ok(next>before);
 assert.equal(store.getSync(id).conversation.history_before,before,'Polling never adopts new history');
 assert.equal((await api(`/syncs/${id}/chat/messages`,{message:'What remains in Trailboard?',request_id:randomUUID()})).status,202);await idle();
 const done=store.getSync(id);assert.equal(done.conversation.history_before,next);assert.equal(done.tree.run.status,'completed');
 assert.equal(JSON.stringify(done.items),originalItems);assert.equal(done.briefing,initial.briefing);assert.equal(store.homeOverview().covered,0);
 assert.ok(calls().at(-1).historical_evidence.sources.some(item=>item.text.includes('Fresh original update')),'New original is supplied separately as H history');
 assert.ok(done.messages.some(item=>/\[H[a-f0-9]{24}\]/.test(item.content))||calls().at(-1).historical_evidence.sources.length>0);
 // Damage outside the supplied evidence is not a chat admission veto.
 fs.writeFileSync(path.join(root,'sessions',trail+'.jsonl'),'damaged original\n');
 assert.equal((await api(`/syncs/${id}/chat/messages`,{message:'Continue',request_id:randomUUID()})).status,202);await idle();
 assert.equal(store.getSync(id).tree.run.status,'completed');
 assert.deepEqual(calls().at(-1).historical_evidence.sources,[]);
});

test('history cutoff stays pinned for the whole answer; unavailable updates are qualified, not a different search mode',async()=>{
 const {id}=await ready(),first=store.getSync(id).conversation.history_before;
 const next=new Date(Date.parse(first)+1).toISOString();let entered,finish;
 const searching=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>finish=resolve),seen=[];
 memory.historyReadiness=()=>({ready:true,before:first});
 memory.searchPreparedHistory=async query=>{seen.push(query.before);entered();await blocked;return {mode:'hybrid',results:[],limitations:'Captured synthetic search.'};};
 launchChat(id,'What remains in Trailboard?',randomUUID());await searching;
 memory.historyReadiness=()=>({ready:true,before:next});assert.equal(store.getSync(id).conversation.history_before,first);finish();await idle();
 assert.deepEqual(seen,[first]);assert.equal(store.getSync(id).conversation.history_before,first);
 memory.searchPreparedHistory=async query=>{seen.push(query.before);throw Error('Background update unavailable');};
 memory.searchHistory=async()=>{throw Error('Never substitute unprepared search');};
 launchChat(id,'What remains in Trailboard?',randomUUID());await idle();
 assert.deepEqual(seen,[first,next]);assert.equal(store.getSync(id).tree.run.status,'completed');
 const packet=calls().at(-1).historical_evidence;assert.deepEqual(packet.sources,[]);assert.match(packet.limitations,/temporarily unavailable or updating/);
});

test('prepared chat never traverses the summary tree, reads the frozen corpus or starts indexing',async t=>{
 const {id}=await ready(),initial=store.getSync(id),before=calls().length;
 getDb().prepare('DELETE FROM summary_planning_context WHERE sync_id=?').run(id); // Pre-receipt briefing upgrade.
 const {SummaryTree}=require('../dist/sync/tree'),{EvidenceReader}=require('../dist/db/evidence');
 const forbidden=()=>{throw Error('Chat entered a preparation/full-snapshot path');};
 for(const method of ['beforePreparation','build','beforeFinal','verifyFinal'])t.mock.method(SummaryTree.prototype,method,forbidden);
 t.mock.method(EvidenceReader.prototype,'read',forbidden);
 t.mock.method(memory,'historyPreparationStatus',()=>({ready:true,before:initial.conversation.history_before}));
 t.mock.method(memory,'historyReadiness',forbidden);t.mock.method(memory,'prepareHistory',forbidden);
 const api=await http(),key=randomUUID();
 assert.equal((await api(`/syncs/${id}/chat/messages`,{message:'What remains?',request_id:key})).status,202);await idle();
 const done=await(await api(`/syncs/${id}?evidence=false`)).json();
 assert.equal(done.tree.run.status,'completed');assert.equal(done.messages.length,2);
 assert.equal(done.briefing,initial.briefing);assert.equal(calls().length-before,1);
 assert.equal(calls().at(-1).opening_briefing,initial.briefing.replace(/\[([EC]\d+)\]/g,'(quoted reference $1)'));assert.deepEqual(calls().at(-1).summary_tree,[]);
 assert.equal(done.item_count,initial.items.length);assert.equal(store.homeOverview().covered,0);
 assert.equal((await api(`/syncs/${id}/messages`,{message:'And now?'})).status,202);await idle();
 assert.equal(store.getProgress(id).run.status,'completed');assert.equal(calls().length-before,2,'Legacy discussion uses the same fast path');
 assert.equal(getDb().prepare('SELECT COUNT(*) n FROM summary_planning_context WHERE sync_id=?').get(id).n,0,'Chat must not manufacture preparation provenance');
});

test('explicit frozen citations read only the requested original and reject revoked source access',async t=>{
 const {id}=await ready(),item=store.getSync(id).items[0],before=calls().length;
 const {EvidenceReader}=require('../dist/db/evidence'),read=EvidenceReader.prototype.read;let reads=0;
 t.mock.method(EvidenceReader.prototype,'read',function(value,...args){const metadata=typeof value==='string'?JSON.parse(value):value;assert.equal(metadata.ref,item.ref);reads++;return read.call(this,value,...args);});
 launchChat(id,`Explain ${item.ref}`,randomUUID());await idle();
 assert.equal(store.getProgress(id).run.status,'completed');assert.equal(reads,1);assert.equal(calls().length-before,1);
 assert.ok(calls().at(-1).retrieved_evidence.some(source=>source.sequence===item.sequence));
 store.setIncluded(item.session_id,false);
 launchChat(id,`Explain ${item.ref}`,randomUUID());await idle();
 assert.equal(store.getProgress(id).run.status,'failed');assert.equal(calls().length-before,1,'Revoked evidence cannot reach another model request');
});

test('a history implementation that returns after cancellation cannot reach the final model',async()=>{
 const {id}=await ready(),before=calls().length;let entered,finish;
 const arrived=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>finish=resolve);
 memory.searchPreparedHistory=async()=>{entered();await blocked;return {mode:'hybrid',results:[],limitations:'Synthetic result after cancellation.'};};
 launchChat(id,'What remains?',randomUUID());await arrived;cancelReply(id);finish();await idle();
 const done=store.getSync(id);assert.equal(done.tree.run.status,'cancelled');assert.equal(done.messages.length,1);
 assert.equal(done.messages[0].role,'user');assert.equal(calls().length,before);assert.equal(done.busy,false);
});

test('accepted user time survives retries/restart; an in-flight answer finishes before ending and reservations are released',async()=>{
 const {id}=await ready(),clock=Date.now,started=clock(),key=randomUUID();let now=started;
 Date.now=()=>now;
 try {
  fs.writeFileSync(control,JSON.stringify({delay:300}));launchChat(id,'What remains?',key);
  const accepted=store.getSync(id).conversation.last_user_at;assert.equal(accepted,new Date(started).toISOString());
  now+=30*60_000;require('../dist/sync/conversation').expireConversations();assert.equal(store.getSync(id).conversation.ended_at,null);
  assert.equal(launchChat(id,'What remains?',key).conversation.last_user_at,accepted);await idle();
  const done=store.getSync(id);assert.equal(done.tree.run.status,'completed');assert.equal(done.messages.length,2);assert.ok(done.conversation.ended_at);
  const paid=calls().length;closeDb();assert.equal(launchChat(id,'What remains?',key).messages.length,2);assert.equal(calls().length,paid);
  assert.throws(()=>launchChat(id,'Continue',randomUUID()),error=>error.status===410);assert.equal(store.homeOverview().covered,0);
  const next=store.startConversationSync(randomUUID());assert.notEqual(next.id,id);assert.deepEqual(next.items.map(item=>item.event_key),done.items.map(item=>item.event_key));
  assert.equal(store.getSync(id).briefing,done.briefing);assert.equal(store.getSync(id).messages.length,2);assert.equal(store.homeOverview().covered,0);
 } finally {Date.now=clock;}
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

test('a prepared conversation cutoff survives new chat messages for both text and voice readiness',async()=>{
 require('./fixtures/fake-memory.cjs').useIndexedHistory();const {id}=await ready();const before=memory.historyReadiness(true);assert.equal(before.ready,true);
 launchChat(id,'What remains in Trailboard?',randomUUID());await idle();
 assert.deepEqual(memory.historyReadiness(true),before);assert.equal(memory.historyReadiness().ready,false);
 assert.equal(require('../dist/sync/preparation').callReadiness(id,true).ready,true);
 assert.equal(require('../dist/sync/preparation').callReadiness(id,false).ready,true);
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
 const records=ids.map((ref,i)=>({ref,kind:'session',session_id:session,sync_id:null,origin_ref:null,title:'Trailboard',workspace:'/demo/Trailboard',role:'assistant',at:`2026-01-0${i+1}T00:00:00.000Z`,sequence:i+1,offset:0,score:1,qualification:'Agent report.',text:['Client wiring and durable jobs remain unfinished.','Client wiring implemented; delivery disabled.','Durable job foundations implemented; delivery remains disabled.'][i]}));
 memory.searchPreparedHistory=async()=>({mode:'hybrid',limitations:'Synthetic originals.',results:records});
 memory.readHistory=async ref=>({record:records.find(item=>item.ref===ref),offset:0,total:100,neighbors:[]});
 return ids;
}
test('chat uses the configured summary model to select evidence and the final model to answer',async()=>{
 const {id,trail}=await ready();reconciliationFixture(trail);const before=calls().length;
 launchChat(id,'What remains in Trailboard?',randomUUID());await idle();
 const used=calls().slice(before),sync=store.getSync(id);
 assert.deepEqual(used.map(call=>[call.task,call.model]),[['select_evidence','test/cheap'],['final_verdict','test/strong']]);
 assert.equal(sync.tree.run.invocations,2);assert.equal(sync.tree.run.metrics.length,2);
 assert.equal(used[1].historical_evidence.sources.length,3);
 assert.ok(sync.messages.at(-1).content.includes('H'));assert.equal(store.homeOverview().covered,0);
});

test('invalid selection fails the message without an answer call or automatic retry',async()=>{
 const {id,trail}=await ready();reconciliationFixture(trail);const before=calls().length,key=randomUUID();
 fs.writeFileSync(control,JSON.stringify({badSelection:true}));launchChat(id,'What remains?',key);await idle();
 const sync=store.getSync(id);assert.equal(sync.tree.run.status,'failed');assert.match(sync.tree.run.error,/Evidence selection/);
 assert.equal(sync.tree.run.invocations,1);assert.equal(calls().length-before,1);assert.equal(sync.messages.length,1);
 launchChat(id,'What remains?',key);assert.equal(calls().length-before,1);
});

test('selection reserves the answer call and cancellation never publishes a partial reply',async()=>{
 const {id,trail}=await ready();reconciliationFixture(trail);const before=calls().length;
 store.configureModels(id,{...store.getSync(id).models,max_invocations:1});
 launchChat(id,'What remains?',randomUUID());await idle();
 assert.equal(store.getProgress(id).run.invocations,0);assert.equal(calls().length,before);assert.match(store.getProgress(id).run.error,/Invocation budget/);
 store.configureModels(id,{...store.getSync(id).models,max_invocations:3});fs.writeFileSync(control,JSON.stringify({delay:1000}));
 launchChat(id,'What remains?',randomUUID());
 const until=Date.now()+5000;while(store.getProgress(id).run.invocations!==1){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10));}
 assert.equal(store.getProgress(id).run.stage,'Selecting evidence');cancelReply(id);await idle();
 assert.equal(store.getProgress(id).run.status,'cancelled');assert.equal(store.getProgress(id).run.invocations,1);
 assert.ok(store.getSync(id).messages.every(message=>message.role==='user'));
});

test('bad or missing first-draft citations get one correction after evidence selection',async()=>{
 const {id,trail}=await ready();reconciliationFixture(trail);
 for(const controlValue of [{invalidFinalOnce:true},{missingFinalOnce:true}]){
  fs.writeFileSync(control,JSON.stringify(controlValue));const before=calls().length;
  launchChat(id,'What remains in Trailboard?',randomUUID());await idle();const sync=store.getSync(id),attempts=calls().slice(before);
  assert.equal(sync.tree.run.status,'completed');assert.equal(attempts.length,3);assert.equal(attempts[0].task,'select_evidence');assert.ok(attempts[2].citation_repair.citation_issue);assert.match(sync.messages.at(-1).content,/\[[ECH]/);assert.doesNotMatch(sync.messages.at(-1).content,/R999999|Unsupported draft/);
 }
 const before=calls().length,key=randomUUID();launchChat(id,'INVALID_CITATION',key);await idle();assert.equal(calls().length-before,3);assert.match(store.getSync(id).tree.run.error,/outside the supplied evidence/);assert.equal(store.getSync(id).messages.at(-1).role,'user');launchChat(id,'INVALID_CITATION',key);assert.equal(calls().length-before,3);
});

test('citation correction cannot exceed the invocation ceiling or publish a draft after cancellation',async()=>{
 const {id,trail}=await ready();reconciliationFixture(trail);const before=calls().length;
 store.configureModels(id,{...store.getSync(id).models,max_invocations:2});fs.writeFileSync(control,JSON.stringify({invalidFinalOnce:true}));
 launchChat(id,'What is still blocked in Trailboard?',randomUUID());await idle();
 assert.equal(calls().length-before,2);assert.equal(store.getSync(id).tree.run.status,'failed');assert.match(store.getSync(id).tree.run.error,/Invocation budget/);assert.equal(store.getSync(id).messages.length,1);
 store.configureModels(id,{...store.getSync(id).models,max_invocations:10});fs.writeFileSync(control,JSON.stringify({invalidFinalOnce:true,delay:300}));
 launchChat(id,'What is still blocked in Trailboard?',randomUUID());
 const until=Date.now()+5000;while(store.getProgress(id).run.stage!=='Checking evidence references'){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10));}
 assert.equal(store.getSync(id).messages.length,2,'Both rows are retained user questions, not the rejected draft');
 cancelReply(id);await idle();assert.equal(store.getSync(id).tree.run.status,'cancelled');assert.ok(store.getSync(id).messages.every(message=>message.role==='user'));
});
