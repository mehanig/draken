// Synthetic-only citation-heavy snapshot backed by temporary JSONL originals.
const path = require('node:path');
const { frozenEvidence } = require('./source-entry.cjs');
module.exports = function seedVoiceSources(db, syncId, count = 37) {
  // Keep originals under the caller's temporary database directory for cleanup.
  const directory = path.join(path.dirname(db.name), 'synthetic-voice-sessions');
  process.env.DRAKEN_PI_SESSIONS_DIR = directory;
  const refs = [];
  const insert = db.prepare('INSERT INTO sync_items(sync_id,event_key,evidence_json) VALUES (?,?,?)');
  for (let i = 1; i <= count; i++) {
    const ref = `E${5000 + i}`;
    refs.push(ref);
    const item = frozenEvidence(db, directory, `Module ${i}: targeted export tests passed. Deployment remains unverified.`, {
      ref, session: `synthetic-large-voice-${syncId}`, name: 'Synthetic module checks',
      cwd: `/demo/module-${i}`, id: String(i),
      timestamp: new Date(Date.now() - 86400000).toISOString(), role: 'toolResult',
    });
    insert.run(syncId, item.event_key, JSON.stringify(item));
  }
  db.prepare('UPDATE syncs SET briefing = ? WHERE id = ?')
    .run(refs.map((ref, i) => `Module ${i + 1} tests passed; deployment remains unverified [${ref}].`).join('\n'), syncId);
  return refs;
};
