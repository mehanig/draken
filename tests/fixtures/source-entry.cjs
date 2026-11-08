// Synthetic real JSONL pointers for tests that do not exercise discovery itself.
const fs=require('node:fs'),path=require('node:path');
const {normalizeEntry,digest}=require('../../dist/sync/normalize');
exports.sourceEntry=(db,directory,text,options={})=>{
  fs.mkdirSync(directory,{recursive:true});
  const session=options.session||'session-a',id=options.id||String(db.prepare('SELECT COUNT(*) n FROM agent_entries').get().n+1),timestamp=options.timestamp||'2020-01-02T00:00:00.000Z';
  const file=path.join(directory,session+'.jsonl');
  let s=db.prepare('SELECT * FROM agent_sessions WHERE id=?').get(session);
  if(!s){db.prepare('INSERT INTO agent_sessions(id,path,cwd,name,modified_at) VALUES(?,?,?,?,?)').run(session,file,options.cwd||'/demo',options.name||'Synthetic history',timestamp);s=db.prepare('SELECT * FROM agent_sessions WHERE id=?').get(session);}
  if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:session,cwd:s.cwd,timestamp})+'\n');
  const raw=options.raw||{type:'message',id,parentId:s.leaf_id||null,timestamp,message:{role:options.role||'assistant',content:text}};
  const normalized=normalizeEntry(raw,options.normalization||2),bytes=Buffer.from(JSON.stringify(raw)+'\n'),offset=fs.statSync(file).size;
  fs.appendFileSync(file,bytes);const stat=fs.statSync(file);
  db.prepare('UPDATE agent_sessions SET path=?,file_identity=?,byte_offset=?,scanned_bytes=?,modified_at=?,leaf_id=? WHERE id=?').run(file,`${stat.dev}:${stat.ino}`,stat.size,stat.size,stat.mtime.toISOString(),normalized.entry_id,session);
  const result=db.prepare(`INSERT INTO agent_entries(session_id,entry_id,parent_id,timestamp,type,role,event_key,is_activity,active,present,target_id,record_offset,record_bytes,record_hash,text_length,replacement_length,effective_length,normalization)
    VALUES(@session,@entry_id,@parent_id,@timestamp,@type,@role,@event_key,@is_activity,1,1,@target_id,@offset,@bytes,@hash,@text_length,@replacement_length,@text_length,@normalization)`).run({...normalized,session,offset,bytes:bytes.length,hash:digest(bytes),text_length:normalized.text.length,replacement_length:normalized.replacement?.length||0,normalization:options.normalization||2});
  return Number(result.lastInsertRowid);
};
exports.editEntry=(db,directory,id,text)=>{
  const original=db.prepare('SELECT * FROM agent_entries WHERE id=?').get(id),session=db.prepare('SELECT leaf_id FROM agent_sessions WHERE id=?').get(original.session_id);
  const editId=exports.sourceEntry(db,directory,'',{session:original.session_id,raw:{type:'context_edit',id:`edit-${db.prepare('SELECT COUNT(*) n FROM agent_entries').get().n+1}`,parentId:session.leaf_id,targetId:original.entry_id,timestamp:original.timestamp,replacement:text}});
  const edit=db.prepare('SELECT replacement_length FROM agent_entries WHERE id=?').get(editId);
  db.prepare('UPDATE agent_entries SET effective_id=?,effective_length=? WHERE id=?').run(editId,edit.replacement_length,id);
};
