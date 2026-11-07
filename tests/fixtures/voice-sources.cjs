// Synthetic-only citation-heavy snapshot. No copied user sessions or responses.
module.exports = function seedVoiceSources(db, syncId, count = 37) {
  const refs = [];
  const insert = db.prepare('INSERT INTO sync_items(sync_id,event_key,evidence_json) VALUES (?,?,?)');
  for (let i = 1; i <= count; i++) {
    const ref = `E${5000 + i}`, key = `synthetic-voice-${syncId}-${i}`;
    refs.push(ref);
    const item = { ref, session_id: 'synthetic-large-voice', session_name: 'Synthetic module checks',
      cwd: `/demo/module-${i}`, entry_id: String(i), event_key: key, source_path: '/synthetic/large-voice.jsonl',
      timestamp: new Date(Date.now() - 86400000).toISOString(), role: 'toolResult',
      text: `Module ${i}: targeted export tests passed. Deployment remains unverified.` };
    insert.run(syncId, key, JSON.stringify(item));
  }
  db.prepare('UPDATE syncs SET briefing = ? WHERE id = ?')
    .run(refs.map((ref, i) => `Module ${i + 1} tests passed; deployment remains unverified [${ref}].`).join('\n'), syncId);
  return refs;
};
