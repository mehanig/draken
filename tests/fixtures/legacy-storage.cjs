const vec = require('sqlite-vec');
// Synthetic v1 search format, for testing the real one-way migration.
exports.legacyIndex = (db, records, chunks, embeddings, fingerprint) => {
  vec.load(db); db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE records(ref TEXT PRIMARY KEY,json TEXT NOT NULL,session_id TEXT,sync_id INTEGER,at TEXT,group_id TEXT NOT NULL,position INTEGER NOT NULL);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY AUTOINCREMENT,ref TEXT NOT NULL REFERENCES records(ref) ON DELETE CASCADE,offset INTEGER NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,embedded INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX chunks_hash ON chunks(hash);
    CREATE VIRTUAL TABLE words USING fts5(body,content='chunks',content_rowid='id');
    CREATE VIRTUAL TABLE vectors USING vec0(embedding float[384] distance_metric=cosine);
    CREATE TABLE embedding_cache(hash TEXT PRIMARY KEY,embedding BLOB NOT NULL);
    CREATE TRIGGER chunks_insert AFTER INSERT ON chunks BEGIN INSERT INTO words(rowid,body) VALUES(new.id,new.body); END;
    CREATE TRIGGER chunks_delete AFTER DELETE ON chunks BEGIN INSERT INTO words(words,rowid,body) VALUES('delete',old.id,old.body); DELETE FROM vectors WHERE rowid=old.id; END;`);
  db.prepare('INSERT INTO meta VALUES(?,?)').run('schema', 'history-index-v1');
  db.prepare('INSERT INTO meta VALUES(?,?)').run('model', fingerprint);
  for (const r of records) db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(r.ref, JSON.stringify(r), r.session_id, r.sync_id, r.at, r.group, r.position);
  for (const c of chunks) {
    const record=records.find(row=>row.ref===c.ref),body=c.body??`${record.title}\n${record.role}\n${record.text.slice(c.offset,c.offset+800)}`;
    db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?)').run(c.id, c.ref, c.offset, body, c.hash, c.embedded);
    if (c.embedded) db.prepare('INSERT INTO vectors(rowid,embedding) VALUES(?,?)').run(BigInt(c.id), embeddings.find(e => e.hash === c.hash).embedding);
  }
  for (const e of embeddings) db.prepare('INSERT INTO embedding_cache VALUES(?,?)').run(e.hash, e.embedding);
};
exports.legacyEntries = db => {
  db.exec(`CREATE TABLE IF NOT EXISTS retained_text(key TEXT PRIMARY KEY,text TEXT NOT NULL);
    DROP TABLE agent_entries;
    DELETE FROM sync_settings WHERE key='storage_schema';
    CREATE TABLE agent_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES agent_sessions(id),entry_id TEXT NOT NULL,parent_id TEXT,timestamp TEXT NOT NULL,type TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,effective_text TEXT NOT NULL,event_key TEXT NOT NULL,is_activity INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 0,present INTEGER NOT NULL DEFAULT 1,target_id TEXT,replacement TEXT,UNIQUE(session_id,entry_id));`);
};
