#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.DRAKEN_VOICE_DATA_DIR;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
function wave(seconds = 1) {
  const n = 24000 * seconds, buffer = Buffer.alloc(44 + n * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buffer.writeInt16LE(Math.round(Math.sin(i * 220 * 2 * Math.PI / 24000) * 1000), 44 + i * 2);
  return buffer.toString('base64');
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  buffer += data;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const job = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const file = path.join(root, 'audio-control.json');
    const control = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    fs.appendFileSync(path.join(root, 'audio-jobs.log'), JSON.stringify({ id: job.id, op: job.op }) + '\n');
    setTimeout(() => {
      if (control.fail === job.op) emit({ id: job.id, error: 'Synthetic failure' });
      else if (job.op === 'transcribe') emit({ id: job.id, text: control.text ?? 'Did the export tests pass?', elapsed_ms: 20 });
      else emit({ id: job.id, audio: wave(control.seconds || 1), duration: control.seconds || 1, elapsed_ms: 20 });
    }, control.delay || 20);
  }
});
emit({ type: 'ready' });
