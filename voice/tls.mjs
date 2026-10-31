#!/usr/bin/env node
// Creates a private local CA and LAN certificate. Does NOT install trust or open a firewall.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const host = args.includes('--host') ? args[args.indexOf('--host') + 1] : process.env.DRAKEN_HOST || 'localhost';
const dir = process.env.DRAKEN_TLS_DIR || path.join(process.env.DRAKEN_DATA_DIR || path.join(os.homedir(), '.draken'), 'runtime/tls');
const ca = path.join(dir, 'draken-local-root.crt'), caKey = path.join(dir, 'draken-local-root.key');
const cert = path.join(dir, 'draken-server.crt'), key = path.join(dir, 'draken-server.key');
let locked = false;
const run = args => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
try {
  if (!host || (!net.isIP(host) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host)) || ['0.0.0.0', '::'].includes(host))
    throw new Error('Use --host with the actual LAN IP or hostname used in your browser, not a wildcard bind address.');
  process.umask(0o077); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, '.setup-lock')); locked = true;
  if (fs.existsSync(ca) !== fs.existsSync(caKey)) throw new Error('Incomplete existing CA. Refusing to overwrite it.');
  if (!fs.existsSync(ca)) {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes', '-keyout', caKey, '-out', ca,
      '-subj', '/CN=Draken local voice root', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  }
  const root = new X509Certificate(fs.readFileSync(ca));
  if (!root.ca || !root.checkPrivateKey(createPrivateKey(fs.readFileSync(caKey)))) throw new Error('The existing CA and private key do not match');
  const hosts = [...new Set([host, 'localhost', '127.0.0.1', '::1'])];
  let valid = false;
  if (fs.existsSync(cert) && fs.existsSync(key)) {
    const current = new X509Certificate(fs.readFileSync(cert));
    valid = current.verify(root.publicKey) && current.checkPrivateKey(createPrivateKey(fs.readFileSync(key))) &&
      Date.parse(current.validTo) > Date.now() + 30 * 86400000 && hosts.every(name => net.isIP(name) ? current.checkIP(name) : current.checkHost(name));
  }
  if (!valid) {
    const request = path.join(dir, 'server.csr'), extensions = path.join(dir, 'server.ext');
    fs.writeFileSync(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${hosts.map(name => `${net.isIP(name) ? 'IP' : 'DNS'}:${name}`).join(',')}\n`);
    run(['req', '-new', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', key + '.new', '-out', request, '-subj', '/CN=Draken local voice']);
    run(['x509', '-req', '-in', request, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '365', '-sha256', '-extfile', extensions, '-out', cert + '.new']);
    fs.renameSync(key + '.new', key); fs.renameSync(cert + '.new', cert);
    fs.rmSync(request); fs.rmSync(extensions);
  }
  console.log(`DRAKEN_HTTPS_PORT=44433\nDRAKEN_TLS_CERT=${cert}\nDRAKEN_TLS_KEY=${key}\nDRAKEN_TLS_CA=${ca}`);
  console.log(`\nPublic CA SHA-256 fingerprint: ${root.fingerprint256}`);
  console.log('Keep both .key files private. Install ONLY draken-local-root.crt as a trusted CA on your client device. See VOICE.md.');
  console.log('Existing CA retained on reruns. Restart Draken after configuring TLS; allow the HTTPS port on your trusted LAN if needed.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (locked) fs.rmdirSync(path.join(dir, '.setup-lock')); }
