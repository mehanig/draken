#!/usr/bin/env node
// Explicit, local installation. No API account, Docker, sudo, or runtime model downloads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.DRAKEN_VOICE_DATA_DIR || path.join(process.env.DRAKEN_DATA_DIR || path.join(os.homedir(), '.draken'), 'voice');
const uvVersion = '0.13.6';
const targets = {
  'linux-x64': ['x86_64-unknown-linux-gnu', 'f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d'],
  'darwin-x64': ['x86_64-apple-darwin', '63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02'],
  'darwin-arm64': ['aarch64-apple-darwin', '60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472'],
};
const whisper = 'https://huggingface.co/Systran/faster-whisper-base.en/resolve/3d3d5dee26484f91867d81cb899cfcf72b96be6c';
const kokoro = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
const models = [
  ['whisper-base.en/config.json', `${whisper}/config.json`, 'f3bc3821e9fc76a27bae538e11ae5b677dcdd352b4600429ce7951d398569aeb'],
  ['whisper-base.en/model.bin', `${whisper}/model.bin`, '2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef'],
  ['whisper-base.en/tokenizer.json', `${whisper}/tokenizer.json`, '929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df'],
  ['whisper-base.en/vocabulary.txt', `${whisper}/vocabulary.txt`, 'ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf'],
  ['kokoro-v1.0.int8.onnx', `${kokoro}/kokoro-v1.0.int8.onnx`, '6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb'],
  ['voices-v1.0.bin', `${kokoro}/voices-v1.0.bin`, 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d'],
];
async function hash(file) {
  const digest = createHash('sha256');
  for await (const part of fs.createReadStream(file)) digest.update(part);
  return digest.digest('hex');
}
async function download(url, destination, sha) {
  if (fs.existsSync(destination) && await hash(destination) === sha) return;
  if (process.argv.includes('--check')) throw new Error(`Missing or incorrect file: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + `.partial-${process.pid}`;
  try {
    console.log(`Downloading ${path.basename(destination)} from ${new URL(url).hostname}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
    if (await hash(temporary) !== sha) throw new Error(`Checksum mismatch: ${path.basename(destination)}`);
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
}
async function smoke(python) {
  await new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(here, 'worker.py')], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', DRAKEN_VOICE_DATA_DIR: root, DRAKEN_VOICE_THREADS: process.env.DRAKEN_VOICE_THREADS || '4', DRAKEN_VOICE_SPEAKER: process.env.DRAKEN_VOICE_SPEAKER || 'af_heart' } });
    let buffer = '', done = false;
    const finish = error => {
      if (done) return; done = true; clearTimeout(timer); child.kill('SIGTERM');
      const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1500); kill.unref();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('Local speech startup timed out')), 90000);
    child.stdout.setEncoding('utf8'); child.stderr.on('data', () => {});
    child.stdout.on('data', data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready') child.stdin.write(JSON.stringify({ id: 1, op: 'synthesize', text: 'Local speech is ready.' }) + '\n');
          else if (message.id === 1 && message.audio && message.duration > 0) finish();
          else if (message.error) finish(new Error(message.error));
        } catch { finish(new Error('Invalid local audio startup response')); }
      }
    });
    child.stdin.on('error', finish); child.on('error', finish); child.on('exit', () => { if (!done) finish(new Error('Local speech could not start')); });
  });
}
try {
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error('Automatic voice setup supports Linux and macOS. The tested server is Linux x64.');
  process.umask(0o077); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const python = process.env.DRAKEN_VOICE_PYTHON || path.join(root, 'venv/bin/python');
  if (!process.argv.includes('--check')) {
    const [platform, sha] = target;
    const uv = path.join(root, `uv-${platform}`, 'uv');
    if (!fs.existsSync(uv)) {
      const archive = path.join(root, `uv-${platform}.tar.gz`);
      await download(`https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-${platform}.tar.gz`, archive, sha);
      execFileSync('tar', ['-xzf', archive, '-C', root]); fs.rmSync(archive);
    }
    if (!execFileSync(uv, ['--version'], { encoding: 'utf8' }).startsWith(`uv ${uvVersion} `)) throw new Error('Unexpected uv version in voice directory');
    const env = { ...process.env, UV_NO_PROGRESS: '1' };
    if (!fs.existsSync(python)) execFileSync(uv, ['venv', '--python', '3.12', path.join(root, 'venv')], { stdio: 'inherit', env });
    execFileSync(uv, ['pip', 'install', '--python', python, '-r', path.join(here, 'requirements.txt')], { stdio: 'inherit', env });
  }
  if (!fs.existsSync(python)) throw new Error('Voice Python runtime is missing');
  for (const [name, url, sha] of models) await download(url, path.join(root, 'models', name), sha);
  await smoke(python);
  console.log(`Local speech is ready in ${root}. No pi/provider invocation was made.`);
  console.log('Open Draken on localhost or trusted HTTPS, prepare a briefing, then choose Call Draken. See VOICE.md for LAN setup.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
