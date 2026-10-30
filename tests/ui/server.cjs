// Synthetic-only UI server. Never points at the user's pi store or provider.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-browser-'));
const root = path.join(temp, 'sessions');
fs.mkdirSync(root);
const examples = [
  { cwd: '/demo/export-service', request: 'Fix the export timeout', answer: 'Implemented a bounded retry for export uploads.', result: 'Tests: 5 passed, 0 failed' },
  { cwd: '/demo/dashboard', request: 'Investigate the dashboard refresh bug', answer: 'Found a stale subscription. Need a decision on polling versus events.', result: 'Investigation only; no files changed.' },
];
for (const [index, example] of examples.entries()) {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(root, `${id}.jsonl`), [
    { type: 'session', version: 3, id, cwd: example.cwd, timestamp },
    { type: 'message', id: `u${index}`, parentId: null, timestamp, message: { role: 'user', content: example.request } },
    { type: 'message', id: `a${index}`, parentId: `u${index}`, timestamp, message: { role: 'assistant', content: [{ type: 'text', text: example.answer }] } },
    { type: 'message', id: `t${index}`, parentId: `a${index}`, timestamp, message: { role: 'toolResult', toolName: 'bash', isError: false, content: [{ type: 'text', text: example.result }] } },
  ].map(JSON.stringify).join('\n') + '\n');
}
const fake = path.join(temp, 'pi');
fs.writeFileSync(fake, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  if (payload.user_question) console.log('The session reports targeted tests passing, not a deployment. Keep the dashboard decision open. [E1]');
  else console.log('Needs your attention\\nThe dashboard investigation needs a decision. [E2]\\n\\nProgress\\nThe export session reports a bounded retry implementation. [E3]\\n\\nSuggested discussion\\nShould we prioritize validation or the dashboard decision?');
});
`, { mode: 0o700 });
process.env.DRAKEN_DATA_DIR = path.join(temp, 'state');
process.env.DRAKEN_PI_SESSIONS_DIR = root;
process.env.DRAKEN_PI_BIN = fake;
process.env.DRAKEN_NO_AUTH = 'true';
process.env.DRAKEN_PI_MODEL = 'synthetic-test-model';
const { createApp } = require('../../dist/server');
const { closeDb } = require('../../dist/db/schema');
const server = createApp().listen(41889, '127.0.0.1');
const shutdown = () => server.close(() => { closeDb(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
