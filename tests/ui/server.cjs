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
    ...Array.from({ length: 32 }, (_, position) => ({ type: 'message', id: `extra${index}-${position}`,
      parentId: position ? `extra${index}-${position - 1}` : `t${index}`,
      timestamp: new Date(Date.now() + position + 1).toISOString(),
      message: { role: 'toolResult', toolName: 'bash', isError: false, content: [{ type: 'text', text: `${example.result} — synthetic check ${position + 1}` }] } })),
  ].map(JSON.stringify).join('\n') + '\n');
}
const fake = path.join(temp, 'pi');
fs.copyFileSync(path.join(__dirname, '../fixtures/fake-pi.cjs'), fake);
fs.chmodSync(fake, 0o700);
process.env.DRAKEN_DATA_DIR = path.join(temp, 'state');
process.env.DRAKEN_PI_SESSIONS_DIR = root;
process.env.DRAKEN_PI_BIN = fake;
process.env.DRAKEN_NO_AUTH = 'true';
process.env.DRAKEN_PI_MODEL = 'test/strong';
process.env.DRAKEN_PI_SUMMARY_MODEL = 'test/cheap';
const control = path.join(root, 'fake-control.json');
fs.writeFileSync(control, JSON.stringify({ delay: 400 }));
process.env.DRAKEN_FAKE_CONTROL = control;
const { createApp } = require('../../dist/server');
const { closeDb } = require('../../dist/db/schema');
const server = createApp({ staticDir: process.env.DRAKEN_TEST_STATIC_DIR }).listen(41889, '127.0.0.1');
const shutdown = () => server.close(() => { closeDb(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(0); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
