const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { modelFilesPresent, prepareModelFiles, verifyModelFiles } = require('../dist/memory/model-assets');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('pool and dashboard readiness load without importing an inference runtime', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const Module = require('node:module'), load = Module._load;
    Module._load = function(name, ...args) {
      if (name.startsWith('onnxruntime-web') || name === '@huggingface/tokenizers') throw Error('Inference loaded outside its lane');
      return load.call(this, name, ...args);
    };
    const { EmbeddingPool } = require('./dist/memory/embedding-pool');
    require('./dist/memory/readiness');
    new EmbeddingPool('/synthetic/missing-model').ready();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});

test('optional real-model qualification commands fail clearly without downloading absent weights', t => {
  const missing = path.join(directory(t), 'missing');
  for (const args of [['memory-real.cjs'], ['memory-performance.cjs'], ['memory-performance.cjs', '--child', '--baseline']]) {
    const child = spawnSync(process.execPath, [path.join(__dirname, args[0]), ...args.slice(1), `--model-dir=${missing}`], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000,
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /Model absent/);
    assert.doesNotMatch(child.stderr, /Invalid embedding thread budget|is not a function/);
    assert.equal(fs.existsSync(missing), false);
  }
});

test('metadata checks never create files and no-download preparation fails closed', async t => {
  const root = path.join(directory(t), 'missing');
  t.mock.method(global, 'fetch', () => { throw Error('Unexpected download'); });
  assert.equal(modelFilesPresent(root), false);
  await assert.rejects(prepareModelFiles(root, undefined, false), /Prepare history before calling/);
  await assert.rejects(verifyModelFiles(root), /missing or damaged/);
  assert.equal(fs.existsSync(root), false);
  assert.equal(fetch.mock.callCount(), 0);
});

test('truncated model download never replaces existing bytes and removes its temporary file', async t => {
  const root = directory(t), file = path.join(root, 'onnx/model_quantized.onnx');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'existing damaged model');
  t.mock.method(global, 'fetch', async url => {
    assert.match(url, /^https:\/\/huggingface\.co\/Xenova\/multilingual-e5-small\/resolve\/[a-f0-9]{40}\/onnx\/model_quantized\.onnx$/);
    return new Response('truncated');
  });
  const updates = [];
  await assert.rejects(prepareModelFiles(root, value => updates.push(value)), /checksum mismatch/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing damaged model');
  assert.equal(fs.existsSync(file + '.part'), false);
  assert.equal(modelFilesPresent(root), false);
  assert.ok(updates.some(value => value.stage === 'downloading' && value.downloaded_bytes > 0));
});
