const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Database=require('better-sqlite3');
const {getDb,closeDb}=require('../dist/db/schema');
const {HistoryIndex}=require('../dist/memory/index');
const {historyStamp,indexReadiness,storedHistoryReadiness}=require('../dist/memory/readiness');
const {sourceStamps}=require('../dist/memory/stamps');
const {scanSessions}=require('../dist/sync/collector');
const {EvidenceReader}=require('../dist/db/evidence');
const {EntryReader}=require('../dist/sync/source-files');
const {historySources}=require('../dist/memory/sources');
const OLD='2020-01-01T00:00:00.000Z',BEFORE='2020-01-02T00:00:00.000Z',NEW='2020-01-03T00:00:00.000Z',LATER='2020-01-04T00:00:00.000Z';
let root,db,cache,index,model,calls;
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'draken-live-readiness-'));fs.mkdirSync(root+'/sessions');
 Object.assign(process.env,{DRAKEN_DATA_DIR:root+'/state',DRAKEN_PI_SESSIONS_DIR:root+'/sessions',DRAKEN_PI_BIN:'/not-a-provider'});
 db=getDb();fs.mkdirSync(root+'/state/memory');cache=new Database(root+'/state/memory/index.sqlite');calls=0;
 model={fingerprint:'synthetic-live-readiness',ready:()=>true,setup:async()=>{},embed:async()=>{calls++;const vector=new Float32Array(384);vector[0]=1;return vector;}};
 index=new HistoryIndex(cache,db,model);
});
afterEach(()=>{cache.close();closeDb();fs.rmSync(root,{recursive:true,force:true});});
const message=(id,parentId,timestamp,text,role='assistant')=>({type:'message',id,parentId,timestamp,message:{role,content:text}});
function session(id='captured',at=OLD){
 fs.writeFileSync(`${root}/sessions/${id}.jsonl`,[
  {type:'session',version:3,id,cwd:'/synthetic/project',timestamp:at},
  message('user',null,at,'Synthetic captured topic','user'),
  message('answer','user',at,'Original reported result; deployment was not checked.')
 ].map(JSON.stringify).join('\n')+'\n');
}
function append(id='captured',at=NEW){
 fs.appendFileSync(`${root}/sessions/${id}.jsonl`,[
  message('next','answer',at,'A newly reported implementation, not verified deployment.'),
  message('last','next',at,'A later qualification: acceptance testing remains pending.')
 ].map(JSON.stringify).join('\n')+'\n');
}
async function scan(){assert.deepEqual((await scanSessions()).warnings,[]);}
async function prepared(){session();await scan();await index.prepare({before:BEFORE},undefined,true);assert.equal(indexReadiness(cache,db,true).ready,true);}
function snapshot(entryId='answer',created=OLD,sessionId='captured'){
 const row=db.prepare('SELECT e.*,s.name,s.cwd FROM agent_entries e JOIN agent_sessions s ON s.id=e.session_id WHERE e.session_id=? AND e.entry_id=?').get(sessionId,entryId);
 const reader=new EntryReader(db),frozen=new EvidenceReader(db);let evidence;
 try{evidence=frozen.freeze({ref:'E1',event_key:row.event_key,session_id:row.session_id,session_name:row.name,cwd:row.cwd,timestamp:row.timestamp,role:row.role,text:reader.effective(row.id),entry_id:row.entry_id,sequence:row.id});}
 finally{reader.close();frozen.close();}
 const id=Number(db.prepare("INSERT INTO syncs(created_at,snapshot_at,snapshot_version,status) VALUES(?,?,2,'open')").run(created,created).lastInsertRowid);
 db.prepare('INSERT INTO sync_items VALUES(?,?,?)').run(id,row.event_key,evidence);
 return id;
}
// Instrument the source connection, not derived-index queries. Repeated polls
// may do constant-size revision/flag reads, but must not walk source metadata.
function sourceQueries(){
 const prepare=db.prepare,counts={prepare:0,walks:0,originals:0};
 db.prepare=function(sql){
  counts.prepare++;const statement=prepare.call(this,sql);
  if (/agent_entries|agent_sessions|sync_items|FROM syncs|sync_messages/.test(sql)) {
   for(const method of ['get','all','iterate']) {
    const run=statement[method];statement[method]=function(...args){
     counts.walks++;if (/WHERE session_id=\? AND entry_id=\?/.test(sql)) counts.originals++;
     return run.apply(this,args);
    };
   }
  }
  return statement;
 };
 return {counts,reset(){counts.prepare=counts.walks=counts.originals=0;},close(){db.prepare=prepare;}};
}
function receipt(){return cache.prepare("SELECT value FROM meta WHERE key='call-history-ready-v1'").get()?.value;}
function vectors(){return cache.prepare('SELECT hash,hex(embedding) bytes FROM embedding_cache ORDER BY hash').all();}
function canonical(){return JSON.stringify(['syncs','sync_items','sync_messages','sync_coverage'].map(table=>db.prepare(`SELECT * FROM ${table}`).all()));}

test('real append+scan advances both cursors but preserves the captured stamp; later sessions, aliases and messages stay outside it',async()=>{
 await prepared();const oldSnapshot=snapshot();await index.prepare({before:BEFORE},undefined,true);
 const stamp=historyStamp(db,BEFORE),stamps=[...sourceStamps(db,BEFORE)],oldReceipt=receipt(),oldVectors=vectors();
 const oldRefs=[...historySources(db,undefined,undefined,{before:BEFORE})].map(row=>row.ref);
 const cursor=db.prepare("SELECT byte_offset,scanned_bytes FROM agent_sessions WHERE id='captured'").get();
 append();await scan();
 const nextCursor=db.prepare("SELECT byte_offset,scanned_bytes FROM agent_sessions WHERE id='captured'").get();
 assert.ok(nextCursor.byte_offset>cursor.byte_offset);assert.ok(nextCursor.scanned_bytes>cursor.scanned_bytes);
 assert.deepEqual([...sourceStamps(db,BEFORE)],stamps,'the reproduced bug has exactly unchanged captured source stamps');
 assert.equal(historyStamp(db,BEFORE),stamp,'cursor advancement is not a changed captured context');
 session('later-session',NEW);await scan();snapshot('answer',NEW,'later-session');
 db.prepare('INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES(?,?,?,?)').run(oldSnapshot,'user','A new chat turn supplied directly.',NEW);
 assert.deepEqual([...sourceStamps(db,BEFORE)],stamps);assert.equal(historyStamp(db,BEFORE),stamp);
 assert.equal(indexReadiness(cache,db,true).ready,true);assert.equal(indexReadiness(cache,db).ready,false,'current readiness cannot claim new data');
 assert.equal(receipt(),oldReceipt);assert.deepEqual(vectors(),oldVectors);
 const beforeRows=canonical();await index.prepare({before:LATER},undefined,true);
 assert.equal(indexReadiness(cache,db).ready,true);assert.equal(canonical(),beforeRows,'local updates never rewrite E/C snapshots, messages or coverage');
 const refs=new Set([...historySources(db)].map(row=>row.ref));for(const ref of oldRefs)assert.ok(refs.has(ref),'old H identity survives');
 for(const row of oldVectors)assert.equal(cache.prepare('SELECT hex(embedding) bytes FROM embedding_cache WHERE hash=?').get(row.hash).bytes,row.bytes);
 assert.ok((await index.search({question:'implementation',before:LATER},undefined,true)).results.some(row=>row.at===NEW),'next prepared turn can retrieve new original history');
});

test('new aliases of captured originals require links even with zero source-counter delta; post-cutoff-only aliases do not',async()=>{
 await prepared();const before=historyStamp(db,BEFORE),stamps=[...sourceStamps(db,BEFORE)],embedded=calls;
 snapshot('answer',NEW);
 assert.deepEqual([...sourceStamps(db,BEFORE)],stamps,'same original projection counts once');
 assert.notEqual(historyStamp(db,BEFORE),before,'old original timestamp, not new snapshot creation time, controls required search membership');
 assert.equal(indexReadiness(cache,db,true).ready,false);
 await index.prepare({before:BEFORE},undefined,true);assert.equal(calls,embedded,'new links reuse vectors');assert.equal(indexReadiness(cache,db,true).ready,true);
 const captured=historyStamp(db,BEFORE);append();await scan();snapshot('next',NEW);
 assert.equal(historyStamp(db,BEFORE),captured);assert.equal(indexReadiness(cache,db,true).ready,true);assert.equal(indexReadiness(cache,db).ready,false);
});

test('metadata checks never open source bodies, infer, write receipts, scan or start workers',async()=>{
 await prepared();const changes=db.prepare('SELECT total_changes() n').get().n,cacheChanges=cache.prepare('SELECT total_changes() n').get().n,embedded=calls;
 const open=fs.openSync,read=fs.readFileSync;
 fs.openSync=()=>{throw Error('Unexpected source open');};fs.readFileSync=()=>{throw Error('Unexpected source read');};
 try{for(let n=0;n<3;n++){assert.equal(indexReadiness(cache,db,true).ready,true);assert.equal(indexReadiness(cache,db).ready,true);historyStamp(db,BEFORE);}}
 finally{fs.openSync=open;fs.readFileSync=read;}
 assert.equal(calls,embedded);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);assert.equal(cache.prepare('SELECT total_changes() n').get().n,cacheChanges);
 assert.equal(require('../dist/memory/service').historyProgress().active,false);
});

test('alternating home/overview captured and current polls reuse bounded metadata, including frozen originals',async()=>{
 session();
 const rows=[];for(let n=0;n<120;n++)rows.push(message(`bulk-${n}`,n?`bulk-${n-1}`:'answer',OLD,`Synthetic original ${n}.`));
 fs.appendFileSync(root+'/sessions/captured.jsonl',rows.map(JSON.stringify).join('\n')+'\n');await scan();
 for(let n=0;n<62;n++)snapshot(`bulk-${n}`);
 await index.prepare({before:BEFORE},undefined,true);
 const query=sourceQueries(),lstat=fs.lstatSync;let stats=0;
 fs.lstatSync=function(...args){stats++;return lstat.apply(this,args);};
 try{
  assert.equal(indexReadiness(cache,db,true).ready,true);assert.equal(indexReadiness(cache,db).ready,true);
  assert.ok(query.counts.originals>=62,'cold current scope verifies frozen originals');
  query.reset();stats=0;
  for(let n=0;n<70;n++){
   assert.equal(indexReadiness(cache,db,true).ready,true);assert.equal(indexReadiness(cache,db).ready,true);
  }
  assert.equal(query.counts.walks,0,'no source scans, frozen JSON reads or per-original gets on warm polls');
  assert.equal(query.counts.originals,0);assert.ok(query.counts.prepare<=70*5,'only bounded revision/strict flag SQL');
  assert.equal(stats,140,'each scope still validates its required original file each time');
  db.exec("INSERT INTO sync_settings VALUES('readiness-test','revision')");query.reset();
  assert.equal(indexReadiness(cache,db,true).ready,true);assert.equal(indexReadiness(cache,db).ready,true);
  assert.ok(query.counts.originals>=124,'same-connection total_changes invalidates both slots');
  query.reset();assert.equal(indexReadiness(cache,db,true).ready,true);assert.equal(query.counts.walks,0);
 }finally{fs.lstatSync=lstat;query.close();}
});

test('home/overview report checkpoints without walking history; admission still detects damaged or missing evidence',async()=>{
 await prepared();for(let n=0;n<55;n++)snapshot();
 db.prepare('UPDATE syncs SET conversation_last_user_at=?,conversation_before=?').run(new Date().toISOString(),BEFORE);
 await index.prepare({before:BEFORE},undefined,true);
 const store=require('../dist/sync/store'),memory=require('../dist/memory/service');
 const ready=memory.historyPreparationStatus,prepare=cache.prepare,lstat=fs.lstatSync;
 let queries=0,stats=0;
 memory.historyPreparationStatus=()=>indexReadiness(cache,null);
 cache.prepare=function(sql){if(/p\.embedded=0/.test(sql))queries++;return prepare.call(this,sql);};
 fs.lstatSync=function(...args){stats++;return lstat.apply(this,args);};
 const saved=canonical(),changes=cache.prepare('SELECT total_changes() n').get().n;
 try{
  for(const [view,count] of [[store.homeOverview,20],[store.overview,50]]){
   for(let n=0;n<2;n++){
    queries=stats=0;const cards=view().syncs;assert.equal(cards.length,count);
    assert.ok(cards.every(card=>card.conversation.update_state==='up_to_date'));
    assert.equal(queries,0,'status never scans passage readiness');
    assert.equal(stats,0,'status never walks original files');
   }
  }
  cache.exec('UPDATE passages SET embedded=0');queries=0;
  assert.ok(store.overview().syncs.every(card=>card.conversation.available_before===BEFORE));assert.equal(queries,0);
  assert.equal(indexReadiness(cache,db,true).ready,false,'actual admission rejects damaged passages');
  cache.exec('UPDATE passages SET embedded=1');assert.ok(store.overview().syncs.every(card=>card.conversation.available_before===BEFORE));
  fs.unlinkSync(root+'/sessions/captured.jsonl');queries=stats=0;
  assert.ok(store.homeOverview().syncs.every(card=>card.conversation.available_before===BEFORE));assert.equal(queries,0);assert.equal(stats,0);
  assert.equal(indexReadiness(cache,db,true).ready,false,'actual admission rejects missing originals');
  assert.equal(canonical(),saved);
  // Only the two explicit embedding mutations above may change derived rows.
  assert.equal(cache.prepare('SELECT total_changes() n').get().n,changes+2*cache.prepare('SELECT COUNT(*) n FROM passages').get().n);
 }finally{memory.historyPreparationStatus=ready;cache.prepare=prepare;fs.lstatSync=lstat;}
});

test('incomplete-passage query starts with the partial index, not all occurrence links; old read-only schemas remain functional',async()=>{
 await prepared();const prepare=cache.prepare;let sql;
 cache.prepare=function(query){if(/p\.embedded=0/.test(query))sql=query;return prepare.call(this,query);};
 try{assert.equal(indexReadiness(cache,db,true).ready,true);}finally{cache.prepare=prepare;}
 assert.ok(sql);
 const plans=connection=>connection.prepare('EXPLAIN QUERY PLAN '+sql).all(BEFORE).map(row=>row.detail).join('\n');
 const plan=plans(cache);
 assert.match(plan,/SCAN p USING (?:COVERING )?INDEX passages_incomplete/);
 assert.match(plan,/SEARCH c USING INDEX links_passage/);assert.doesNotMatch(plan,/SCAN c\b/);
 const marker=receipt(),sourceChanges=db.prepare('SELECT total_changes() n').get().n;
 cache.exec('DROP INDEX passages_incomplete');
 const version=cache.pragma('schema_version',{simple:true});
 const oldPlan=plans(cache);assert.match(oldPlan,/SCAN p\b/);assert.match(oldPlan,/SEARCH c USING INDEX links_passage/);assert.doesNotMatch(oldPlan,/SCAN c\b/);
 const readonly=new Database(cache.name,{readonly:true});
 try{
  readonly.pragma('query_only=ON');
  assert.equal(indexReadiness(readonly,db,true).ready,true);
  // Only derived state changes, on another connection, with warm source stamps.
  cache.exec('UPDATE passages SET embedded=0');assert.equal(indexReadiness(readonly,db,true).ready,false);
  cache.exec('UPDATE passages SET embedded=1');assert.equal(indexReadiness(readonly,db,true).ready,true);
  assert.equal(readonly.pragma('schema_version',{simple:true}),version,'read-only checks never install the new index');
 }finally{readonly.close();}
 // Raw fixture caches predating even links_passage also work without migration.
 const raw=new Database(':memory:');
 try{
  raw.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE passages(id INTEGER PRIMARY KEY,embedded INTEGER); CREATE TABLE chunk_links(passage_id INTEGER,ref TEXT); CREATE TABLE records(ref TEXT PRIMARY KEY,at TEXT);');
  for(const row of cache.prepare('SELECT * FROM meta').all())raw.prepare('INSERT INTO meta VALUES(?,?)').run(row.key,row.value);
  raw.exec(`INSERT INTO passages VALUES(1,1); INSERT INTO chunk_links VALUES(1,'old'); INSERT INTO records VALUES('old','${OLD}'); PRAGMA query_only=ON;`);
  assert.equal(indexReadiness(raw,db,true).ready,true);
  raw.exec('PRAGMA query_only=OFF; UPDATE passages SET embedded=0; PRAGMA query_only=ON;');
  assert.equal(indexReadiness(raw,db,true).ready,false);
 }finally{raw.close();}
 assert.equal(receipt(),marker);assert.equal(db.prepare('SELECT total_changes() n').get().n,sourceChanges);
});

test('external DB commits invalidate cached admission even without local total_changes',async()=>{
 await prepared();snapshot();await index.prepare({before:BEFORE},undefined,true);
 assert.equal(indexReadiness(cache,db,true).ready,true);
 const query=sourceQueries(),other=new Database(db.name),changes=db.prepare('SELECT total_changes() n').get().n;
 try{
  other.exec("UPDATE agent_entries SET present=0 WHERE entry_id='answer'");
  assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
  assert.equal(indexReadiness(cache,db,true).ready,false);assert.ok(query.counts.originals>0);
  other.exec("UPDATE agent_entries SET present=1 WHERE entry_id='answer'");
  assert.equal(indexReadiness(cache,db,true).ready,true);
 }finally{other.close();query.close();}
});

test('file metadata is checked on cache hits and safe append metadata changes rebuild without hashing cursors',async()=>{
 await prepared();snapshot();await index.prepare({before:BEFORE},undefined,true);
 const file=root+'/sessions/captured.jsonl',stamp=historyStamp(db,BEFORE),query=sourceQueries();
 try{
  append();assert.equal(historyStamp(db,BEFORE),stamp);assert.ok(query.counts.originals>0,'valid size/mtime change rebuilds DB-derived state');
  query.reset();assert.equal(historyStamp(db,BEFORE),stamp);assert.equal(query.counts.walks,0);
  fs.utimesSync(file,new Date(),new Date(Date.now()+10000));
  assert.equal(historyStamp(db,BEFORE),stamp);assert.ok(query.counts.originals>0,'mtime-only change on an appended file also rebuilds');
  fs.renameSync(file,file+'.original');fs.copyFileSync(file+'.original',file);
  assert.throws(()=>historyStamp(db,BEFORE),/unavailable/,'replacement inode cannot use warm metadata');
  fs.unlinkSync(file);fs.renameSync(file+'.original',file);
  assert.equal(historyStamp(db,BEFORE),stamp);
  await scan();assert.equal(historyStamp(db,BEFORE),stamp,'advancing import cursors does not alter captured identity');
  fs.utimesSync(file,new Date(),new Date(Date.now()+20000));
  assert.throws(()=>historyStamp(db,BEFORE),/unavailable or changed/,'same-size mtime change fails closed on a warm slot');
 }finally{query.close();}
});

test('cutoff and roots replace one captured slot without evicting current metadata',async()=>{
 await prepared();snapshot();await index.prepare({before:BEFORE},undefined,true);append();await scan();
 const current=historyStamp(db),captured=historyStamp(db,BEFORE),query=sourceQueries();
 try{
  assert.notEqual(historyStamp(db,LATER),captured);assert.ok(query.counts.originals>0);
  query.reset();assert.equal(historyStamp(db),current);assert.equal(query.counts.walks,0);
  assert.equal(historyStamp(db,BEFORE),captured);assert.ok(query.counts.originals>0,'old cutoff was replaced, not retained in an unbounded map');
  query.reset();assert.notEqual(historyStamp(db,BEFORE,root+'/different'),captured);assert.ok(query.counts.originals>0);
  query.reset();assert.equal(historyStamp(db,BEFORE),captured);assert.ok(query.counts.originals>0,'resolved roots are part of cache identity');
  const priorRoot=process.env.DRAKEN_PI_SESSIONS_DIR;
  try{process.env.DRAKEN_PI_SESSIONS_DIR=root+'/different';assert.notEqual(historyStamp(db,BEFORE),captured);}
  finally{process.env.DRAKEN_PI_SESSIONS_DIR=priorRoot;}
 }finally{query.close();}
});

test('unbounded metadata expires when future timestamps become eligible without SQL writes',async()=>{
 await prepared();const sync=snapshot();append();await scan();
 db.prepare('INSERT INTO sync_messages(sync_id,role,content,created_at) VALUES(?,?,?,?)').run(sync,'user','Future message.',LATER);
 db.prepare("UPDATE syncs SET status='completed',completed_at=?,decisions='Future decision.' WHERE id=?").run('2020-01-05T00:00:00.000Z',sync);
 const dateNow=Date.now,query=sourceQueries();let now=Date.parse(BEFORE);Date.now=()=>now;
 try{
  const captured=historyStamp(db,BEFORE),initial=historyStamp(db);assert.equal(initial,captured);
  query.reset();now++;assert.equal(historyStamp(db),initial);assert.equal(query.counts.walks,0);
  now=Date.parse(NEW);const entries=historyStamp(db);assert.notEqual(entries,initial);assert.ok(query.counts.walks>0);
  assert.equal(historyStamp(db,BEFORE),captured);
  now=Date.parse(LATER);const messages=historyStamp(db);assert.notEqual(messages,entries);
  now=Date.parse('2020-01-05T00:00:00.000Z');assert.notEqual(historyStamp(db),messages);
  now=Date.parse(BEFORE);assert.equal(historyStamp(db),initial,'clock rollback cannot reuse later admission');
 }finally{Date.now=dateNow;query.close();}
});

test('strict scan failure is enforced even after captured mode warms the identical scope',async()=>{
 await prepared();db.exec("UPDATE sync_settings SET value='0' WHERE key='source-scan-complete-v1'");
 historyStamp(db,BEFORE,undefined,true);historyStamp(db,undefined,undefined,true);
 assert.throws(()=>historyStamp(db,BEFORE),/import has not completed/);
 assert.throws(()=>historyStamp(db),/import has not completed/);
 assert.equal(indexReadiness(cache,db,true).ready,true);assert.equal(indexReadiness(cache,db).ready,false);
});

test('old admission, branch, pointer and import damage all fail closed',async()=>{
 await prepared();
 const mutations=[
  ["UPDATE agent_sessions SET included=0 WHERE id='captured'","UPDATE agent_sessions SET included=1 WHERE id='captured'"],
  ["UPDATE agent_sessions SET missing=1 WHERE id='captured'","UPDATE agent_sessions SET missing=0 WHERE id='captured'"],
  ["UPDATE agent_sources SET enabled=0 WHERE id='pi'","UPDATE agent_sources SET enabled=1 WHERE id='pi'"],
  ["UPDATE agent_entries SET active=0 WHERE entry_id='answer'","UPDATE agent_entries SET active=1 WHERE entry_id='answer'"],
  ["UPDATE agent_entries SET present=0 WHERE entry_id='answer'","UPDATE agent_entries SET present=1 WHERE entry_id='answer'"],
  ["INSERT INTO sync_settings VALUES('history_since','2021-01-01T00:00:00.000Z')","DELETE FROM sync_settings WHERE key='history_since'"]
 ];
 for(const [change,restore] of mutations){db.exec(change);assert.equal(indexReadiness(cache,db,true).ready,false,change);db.exec(restore);assert.equal(indexReadiness(cache,db,true).ready,true,restore);}
 const row=db.prepare("SELECT scanned_bytes,byte_offset FROM agent_sessions WHERE id='captured'").get();
 for(const bytes of [-1,0,row.byte_offset-1]){db.prepare("UPDATE agent_sessions SET scanned_bytes=? WHERE id='captured'").run(bytes);assert.equal(indexReadiness(cache,db,true).ready,false);}
 db.prepare("UPDATE agent_sessions SET scanned_bytes=? WHERE id='captured'").run(row.scanned_bytes);
 db.prepare("UPDATE agent_sessions SET byte_offset=1 WHERE id='captured'").run();assert.equal(indexReadiness(cache,db,true).ready,false,'captured pointers must fit the imported prefix');
 db.prepare("UPDATE agent_sessions SET byte_offset=? WHERE id='captured'").run(row.byte_offset);
 const hash=db.prepare("SELECT record_hash FROM agent_entries WHERE entry_id='answer'").get().record_hash;
 db.prepare("UPDATE agent_entries SET record_hash=? WHERE entry_id='answer'").run('0'.repeat(64));assert.equal(indexReadiness(cache,db,true).ready,false);
 db.prepare("UPDATE agent_entries SET record_hash=? WHERE entry_id='answer'").run(hash);assert.equal(indexReadiness(cache,db,true).ready,true);
 cache.exec('UPDATE passages SET embedded=0');assert.equal(indexReadiness(cache,db,true).ready,false,'an incomplete captured embedding cannot be called ready');
});

test('a failed discovery outside the capture blocks global readiness, not an intact captured context',async()=>{
 await prepared();session('later-session',NEW);await scan();
 db.exec("UPDATE sync_settings SET value='0' WHERE key='source-scan-complete-v1'; UPDATE agent_sessions SET scanned_bytes=0 WHERE id='later-session'");
 assert.equal(indexReadiness(cache,db,true).ready,true);assert.equal(indexReadiness(cache,db).ready,false);
 await assert.rejects(index.prepare({before:BEFORE},undefined,true),/import has not completed/,'no new receipt over an incomplete scan');
 db.exec("UPDATE agent_sessions SET scanned_bytes=0 WHERE id='captured'");assert.equal(indexReadiness(cache,db,true).ready,false,'the captured import itself must remain complete');
});

test('missing originals and real old-content rewrites remain unavailable before and after scan',async()=>{
 await prepared();const file=root+'/sessions/captured.jsonl';
 fs.renameSync(file,file+'.missing');assert.equal(indexReadiness(cache,db,true).ready,false);fs.renameSync(file+'.missing',file);assert.equal(indexReadiness(cache,db,true).ready,true);
 const original=fs.readFileSync(file,'utf8');fs.writeFileSync(file,original.replace('Synthetic captured topic','Synthetic modified topic'));
 fs.utimesSync(file,new Date(),new Date(Date.now()+10000));assert.equal(indexReadiness(cache,db,true).ready,false);
 await scan();assert.equal(indexReadiness(cache,db,true).ready,false,'a first-user edit changes presentation names as well as true original content');
 await index.prepare({before:BEFORE},undefined,true);assert.equal(indexReadiness(cache,db,true).ready,true,'explicit preparation establishes only verified current projections');
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('Original reported result','Modified reported result'));append();
 await scan();assert.equal(indexReadiness(cache,db,true).ready,false,'old rewrite plus append is not mistaken for a harmless cursor update');
});

test('post-cutoff context edits to captured content invalidate readiness without rewriting the frozen E snapshot',async()=>{
 await prepared();const id=snapshot('user');await index.prepare({before:BEFORE},undefined,true);
 const frozen=db.prepare('SELECT evidence_json FROM sync_items WHERE sync_id=?').get(id).evidence_json;
 fs.appendFileSync(root+'/sessions/captured.jsonl',JSON.stringify({type:'context_edit',id:'edit',parentId:'answer',targetId:'user',timestamp:NEW,replacement:'A corrected original request; not the earlier proposal.'})+'\n');
 await scan();assert.equal(indexReadiness(cache,db,true).ready,false,'cutoff filters entry time, not a historical reconstruction of mutable projections');
 assert.equal(db.prepare('SELECT evidence_json FROM sync_items WHERE sync_id=?').get(id).evidence_json,frozen);
 const reader=new EvidenceReader(db);try{assert.equal(reader.read(frozen).text,'Synthetic captured topic');}finally{reader.close();}
 await index.prepare({before:BEFORE},undefined,true);assert.equal(indexReadiness(cache,db,true).ready,true);
});

test('rewrites/removals of frozen-only old branch records are rejected after scan, even though immutable frozen stamps never change',async()=>{
 await prepared();snapshot();
 // A later branch bypasses the frozen assistant entry. Its original bytes are
 // still retained and searchable through the snapshot, not the live projection.
 fs.appendFileSync(root+'/sessions/captured.jsonl',JSON.stringify(message('branch','user',NEW,'A different branch report.'))+'\n');await scan();
 assert.equal(db.prepare("SELECT active FROM agent_entries WHERE entry_id='answer'").get().active,0);
 await index.prepare({before:BEFORE},undefined,true);const stamps=[...sourceStamps(db,BEFORE)];
 const file=root+'/sessions/captured.jsonl',bytes=fs.readFileSync(file,'utf8');
 fs.writeFileSync(file,bytes.replace('Original reported result','Modified reported result'));fs.utimesSync(file,new Date(),new Date(Date.now()+10000));await scan();
 assert.deepEqual([...sourceStamps(db,BEFORE)],stamps,'frozen hashes are historical, not a signal that the original remains intact');
 assert.equal(indexReadiness(cache,db,true).ready,false);
 fs.writeFileSync(file,bytes);fs.utimesSync(file,new Date(),new Date(Date.now()+20000));await scan();assert.equal(indexReadiness(cache,db,true).ready,true);
 fs.writeFileSync(file,bytes.split('\n').filter(line=>!line.includes('"id":"answer"')).join('\n'));await scan();
 assert.equal(indexReadiness(cache,db,true).ready,false,'removal of a frozen-only original is also unavailable');
});

test('legacy hash receipts require an explicit cached migration, never regenerated vectors',async()=>{
 await prepared();const original=JSON.parse(receipt()),bytes=vectors(),embedded=calls;
 delete original.version;cache.prepare("UPDATE meta SET value=? WHERE key='call-history-ready-v1'").run(JSON.stringify(original));
 const legacy=receipt();assert.equal(indexReadiness(cache,db,true).ready,false);assert.equal(receipt(),legacy,'readiness GET does not migrate');
 await index.prepare({before:BEFORE},undefined,true);assert.equal(indexReadiness(cache,db,true).ready,true);assert.equal(JSON.parse(receipt()).version,2);assert.equal(calls,embedded);assert.deepEqual(vectors(),bytes);
 const changes=cache.prepare('SELECT total_changes() n').get().n;await index.prepare({before:LATER},undefined,true);assert.equal(cache.prepare('SELECT total_changes() n').get().n,changes,'unchanged migration is not repeated merely to move a clock');
});

test('a failed delta preparation leaves the original captured receipt usable without falsely covering the new tail',async()=>{
 await prepared();const marker=receipt(),bytes=vectors();append();await scan();
 model.embed=async()=>{throw Error('Synthetic delta failure');};await assert.rejects(index.prepare({before:LATER},undefined,true),/Synthetic delta failure/);
 assert.equal(receipt(),marker);assert.deepEqual(vectors(),bytes);assert.equal(indexReadiness(cache,db,true).ready,true);assert.equal(indexReadiness(cache,db).ready,false);
});

test('session/kind/sync/cutoff-scoped preparation never claims global coverage',async()=>{
 session();await scan();const sync=snapshot();
 for(const scope of [{session_id:'captured'},{session_ids:['captured']},{kind:'sources'},{kind:'conversation'},{sync_id:sync},{before:BEFORE}]){
  const scoped=new Database(':memory:');try{
   const local=new HistoryIndex(scoped,db,model);await local.prepare(scope);
   assert.equal(indexReadiness(scoped,db,true).ready,false,JSON.stringify(scope));
   assert.equal(scoped.prepare("SELECT value FROM meta WHERE key='call-history-ready-v1'").get(),undefined);
   assert.deepEqual(JSON.parse(scoped.prepare("SELECT value FROM meta WHERE key='background-source-stamps-v1'").get().value),[]);
  }finally{scoped.close();}
 }
});

test('stored readiness still rejects missing pinned model files without attempting a download',async()=>{
 await prepared();const {MODEL_ID}=require('../dist/memory/model-files');
 cache.prepare("UPDATE meta SET value=? WHERE key='model'").run(MODEL_ID);
 cache.prepare("UPDATE meta SET value=? WHERE key='call-history-ready-v1'").run(JSON.stringify({...JSON.parse(receipt()),model:MODEL_ID}));
 assert.equal(indexReadiness(cache,db,true).ready,true);const embedded=calls;
 assert.equal(storedHistoryReadiness(root+'/state',db,true).ready,false);assert.equal(calls,embedded);assert.equal(fs.existsSync(root+'/state/memory/model'),false);
});
