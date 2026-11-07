const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const https = require('node:https');
const { execFileSync, spawnSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const openssl = spawnSync('openssl', ['version']).status === 0;

test('local TLS setup is reusable, trusted HTTPS retains auth, and certificate download never returns a key', { skip: !openssl }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draken-tls-test-'));
  const env = { ...process.env, DRAKEN_DATA_DIR: root, DRAKEN_TLS_DIR: path.join(root, 'tls') };
  const setup = () => execFileSync(process.execPath, ['voice/tls.mjs', '--host', '127.0.0.1'], { cwd: path.resolve(__dirname, '..'), env });
  setup(); const certFile = path.join(root, 'tls/draken-server.crt'), keyFile = path.join(root, 'tls/draken-server.key');
  const caFile = path.join(root, 'tls/draken-local-root.crt'), ca = fs.readFileSync(caFile), cert = fs.readFileSync(certFile), key = fs.readFileSync(keyFile);
  setup(); assert.deepEqual(fs.readFileSync(certFile), cert); assert.deepEqual(fs.readFileSync(caFile), ca);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  const bundle = path.join(root, 'accidental-bundle.pem');
  fs.writeFileSync(bundle, Buffer.concat([ca, fs.readFileSync(path.join(root, 'tls/draken-local-root.key'))]));
  Object.assign(process.env, { DRAKEN_DATA_DIR: root, DRAKEN_HOST: '127.0.0.1', DRAKEN_NO_AUTH: 'false', DRAKEN_USERNAME: 'test',
    DRAKEN_PASSWORD: 'test', DRAKEN_JWT_SECRET: 'tls-test-only-not-a-real-secret', DRAKEN_TLS_CA: bundle,
    DRAKEN_CODEX_HOME: path.join(root, 'empty-account'), DRAKEN_CODEX_BIN: path.join(__dirname, 'fixtures/fake-codex.cjs') });
  const { createApp, startServer } = require('../dist/server');
  const { getDb, closeDb } = require('../dist/db/schema'); getDb();
  const server = https.createServer({ cert, key }, createApp()).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const token = require('jsonwebtoken').sign({ username: 'test' }, process.env.DRAKEN_JWT_SECRET);
  const request = (url, headers = {}) => new Promise((resolve, reject) => {
    https.get({ hostname: '127.0.0.1', port: server.address().port, path: url, ca, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  try {
    assert.equal((await request('/api/voice/status')).status, 401);
    assert.equal((await request('/api/voice/certificate')).status, 401);
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await request('/api/voice/status', headers)).status, 200);
    assert.equal((await request('/api/voice/status', { ...headers, Origin: 'https://untrusted.example' })).status, 403);
    const download = await request('/api/voice/certificate', headers);
    assert.equal(download.status, 200);
    assert.deepEqual(download.body, new X509Certificate(ca).raw);
    for (const value of ['wrong', '-1', '65536', '40333']) {
      process.env.DRAKEN_HTTPS_PORT = value; process.env.DRAKEN_PORT = '40333';
      assert.throws(() => startServer(), /DRAKEN_HTTPS_PORT/);
    }
  } finally { await new Promise(resolve => server.close(resolve)); closeDb(); fs.rmSync(root, { recursive: true, force: true }); }
});
