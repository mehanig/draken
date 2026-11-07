import type Database from 'better-sqlite3';

/** One physical passage/vector, many scoped occurrences. `chunks` and
 * `embedding_cache` are read views, not additional text/vector stores. */
export function initHistoryStorage(db: Database.Database, fingerprint: string): void {
  const version = 'history-index-v3-contentless';
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const prior = (db.prepare("SELECT value FROM meta WHERE key='schema'").get() as any)?.value;
  if ((prior && !['history-index-v1', 'history-index-v2-pointers', version].includes(prior)) || (!prior && db.prepare("SELECT 1 FROM sqlite_schema WHERE name IN ('records','chunks','vectors','passages')").get())) throw new Error('Unknown history storage version; existing data was not reset');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS records(ref TEXT PRIMARY KEY,json TEXT NOT NULL,session_id TEXT,sync_id INTEGER,at TEXT,group_id TEXT NOT NULL,position INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS records_group ON records(group_id,at,position);
      CREATE TABLE IF NOT EXISTS passages(id INTEGER PRIMARY KEY AUTOINCREMENT,hash TEXT NOT NULL UNIQUE,body TEXT,embedded INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chunk_links(id INTEGER PRIMARY KEY AUTOINCREMENT,ref TEXT NOT NULL REFERENCES records(ref) ON DELETE CASCADE,offset INTEGER NOT NULL,passage_id INTEGER NOT NULL REFERENCES passages(id));
      CREATE INDEX IF NOT EXISTS links_ref ON chunk_links(ref);
      CREATE INDEX IF NOT EXISTS links_passage ON chunk_links(passage_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS passage_vectors USING vec0(embedding float[384] distance_metric=cosine);
    `);
    if (prior === 'history-index-v1') {
      const sequence = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='chunks'").get() as any)?.seq || 0;
      const insert = db.prepare('INSERT OR IGNORE INTO passages(hash,body) VALUES(?,?)');
      const id = db.prepare('SELECT id,body FROM passages WHERE hash=?');
      const link = db.prepare('INSERT INTO chunk_links(id,ref,offset,passage_id) VALUES(?,?,?,?)');
      for (const row of db.prepare('SELECT * FROM chunks ORDER BY id').all() as any[]) {
        insert.run(row.hash, row.body); const passage = id.get(row.hash) as any;
        if (passage.body !== row.body) throw new Error('Conflicting passage hash');
        link.run(row.id, row.ref, row.offset, passage.id);
      }
      if (!db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='chunk_links'").run(sequence).changes && sequence) db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run('chunk_links', sequence);
      const cache = db.prepare('SELECT embedding FROM embedding_cache WHERE hash=?');
      const vector = db.prepare('SELECT embedding FROM vectors WHERE rowid=?');
      const save = db.prepare('INSERT INTO passage_vectors(rowid,embedding) VALUES(?,?)');
      // Cache-only rows are retained too; ordinary admission refresh may later
      // prune genuinely unreferenced data, just as before this migration.
      for (const row of db.prepare('SELECT hash FROM embedding_cache').all() as any[]) insert.run(row.hash, null);
      for (const passage of db.prepare('SELECT id,hash FROM passages ORDER BY id').all() as any[]) {
        let bytes = (cache.get(passage.hash) as any)?.embedding as Buffer | undefined;
        for (const row of db.prepare('SELECT id FROM chunks WHERE hash=? AND embedded=1').all(passage.hash) as any[]) {
          const saved = (vector.get(BigInt(row.id)) as any)?.embedding as Buffer | undefined;
          if (!saved || (bytes && !saved.equals(bytes))) throw new Error('Existing embeddings disagree; migration refused');
          bytes ||= saved;
        }
        if (!bytes) continue;
        if (bytes.length !== 1536 || [...new Float32Array(Uint8Array.from(bytes).buffer)].some(value => !Number.isFinite(value))) throw new Error('Invalid retained embedding');
        save.run(BigInt(passage.id), bytes); db.prepare('UPDATE passages SET embedded=1 WHERE id=?').run(passage.id);
      }
      // Preserve the external-content FTS index and occurrence IDs, including
      // its document frequencies. Only its backing table becomes a join view.
      db.exec('DROP TRIGGER IF EXISTS chunks_insert; DROP TRIGGER IF EXISTS chunks_delete; DROP TABLE chunks; DROP TABLE vectors; DROP TABLE embedding_cache');
      if (!db.prepare("SELECT 1 FROM meta WHERE key='covered-tails-removed'").get()) {
        const remove = db.prepare('DELETE FROM chunk_links WHERE id=?');
        for (const row of db.prepare(`SELECT c.id,c.offset,r.json FROM chunk_links c JOIN records r ON r.ref=c.ref
          WHERE c.offset>0 AND NOT EXISTS(SELECT 1 FROM chunk_links n WHERE n.ref=c.ref AND n.offset>c.offset)
          AND EXISTS(SELECT 1 FROM chunk_links p WHERE p.ref=c.ref AND p.offset=c.offset-700)`).all() as any[]) {
          const text = JSON.parse(row.json).text;
          if (typeof text === 'string' && row.offset + 100 >= text.length) {
            // External-content FTS needs an explicit delete before its link is removed.
            const body = (db.prepare('SELECT body FROM passages p JOIN chunk_links c ON p.id=c.passage_id WHERE c.id=?').get(row.id) as any).body;
            db.prepare("INSERT INTO words(words,rowid,body) VALUES('delete',?,?)").run(row.id, body); remove.run(row.id);
          }
        }
      }
      db.exec("UPDATE records SET json=json_remove(json,'$.text')");
    }
    if ((db.pragma('table_info(passages)') as { name: string }[]).some(column => column.name === 'body')) {
      if (db.prepare('SELECT 1 FROM chunk_links c JOIN passages p ON p.id=c.passage_id WHERE p.body IS NULL LIMIT 1').get()) throw new Error('A stored search passage is missing; conversion refused');
      // FTS retains token postings/positions, not original passage strings.
      // Re-tokenize existing inputs only; vector bytes and IDs do not change.
      db.exec(`CREATE VIRTUAL TABLE words_source USING fts5(body,content='',contentless_delete=1);
        INSERT INTO words_source(rowid,body) SELECT c.id,p.body FROM chunk_links c JOIN passages p ON p.id=c.passage_id;
        DROP TRIGGER IF EXISTS links_insert; DROP TRIGGER IF EXISTS links_delete;
        DROP VIEW IF EXISTS chunks; DROP TABLE IF EXISTS words;
        ALTER TABLE words_source RENAME TO words;
        ALTER TABLE passages DROP COLUMN body;`);
    }
    db.exec(`
      CREATE VIEW IF NOT EXISTS chunks AS SELECT c.id,c.ref,c.offset,p.hash,p.embedded FROM chunk_links c JOIN passages p ON p.id=c.passage_id;
      CREATE VIEW IF NOT EXISTS embedding_cache AS SELECT p.hash,v.embedding FROM passages p JOIN passage_vectors v ON v.rowid=p.id;
      CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(body,content='',contentless_delete=1);
      CREATE TRIGGER IF NOT EXISTS links_delete AFTER DELETE ON chunk_links BEGIN DELETE FROM words WHERE rowid=old.id; END;
      CREATE TRIGGER IF NOT EXISTS passage_delete AFTER DELETE ON passages BEGIN DELETE FROM passage_vectors WHERE rowid=old.id; END;
    `);
    const oldModel = (db.prepare("SELECT value FROM meta WHERE key='model'").get() as any)?.value;
    if (oldModel && oldModel !== fingerprint) {
      // A real fingerprint change invalidates derived passages, never canonical records.
      db.exec('DELETE FROM records; DELETE FROM passages');
    }
    const metadata = db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE meta.value!=excluded.value');
    metadata.run('schema', version); metadata.run('model', fingerprint);
    db.prepare("INSERT OR IGNORE INTO meta VALUES('covered-tails-removed','1')").run();
  })();
}
