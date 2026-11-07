import http from 'node:http';
import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NativeVoice } from './native.mjs';

/** Synthetic-only lab server. Not mounted in Draken; never imports its DB or routes. */
export async function createProbeServer({ voiceFactory = () => new NativeVoice({
  // Deliberately fixed synthetic facts, not a coding model or real sync context.
  answer: async () => 'The targeted export tests passed. Deployment has not been checked.',
}), leaseMs = 10_000, lifetimeMs = 90_000 } = {}) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  let call, accepted = false, touched = Date.now(), origin, closing;
  const events = []; let sequence = 0;
  const finish = () => { if (!closing) closing = Promise.resolve().then(() => call?.close()); return closing; };
  const body = async req => {
    req.setEncoding('utf8');
    let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 64_000) throw new Error('Request too large.'); }
    return data;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const auth = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(401); res.end(); return; }
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403); res.end(); return; }
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(new URL('./probe.html', import.meta.url))); return;
      }
      if (req.method === 'GET' && ['/peer.mjs', '/probe-browser.mjs'].includes(url.pathname)) {
        res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(new URL(`.${url.pathname}`, import.meta.url))); return;
      }
      if (req.method === 'GET' && url.pathname === '/question.wav') {
        res.setHeader('Content-Type', 'audio/wav'); res.end(fs.readFileSync(fileURLToPath(new URL('../../tests/fixtures/voice-question.wav', import.meta.url)))); return;
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        const after = Number(url.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) { res.writeHead(400); res.end(); return; }
        touched = Date.now(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(events.filter(event => event.sequence > after))); return;
      }
      if (req.method === 'POST' && url.pathname === '/call') {
        if (accepted || closing) { res.writeHead(409); res.end(); return; }
        accepted = true; touched = Date.now();
        const offer = await body(req);
        if (closing) throw new Error('Call setup cancelled.');
        call = voiceFactory();
        call.subscribe(event => {
          const method = event.method;
          if (!['thread/realtime/transcript/done', 'thread/realtime/error', 'thread/realtime/closed', 'thread/realtime/started', 'draken/closed', 'draken/blocked'].includes(method)) return;
          // Only synthetic transcripts and event kinds. Never SDP, tokens, helper errors or IDs.
          const params = method === 'thread/realtime/transcript/done' && ['user', 'assistant'].includes(event.params?.role)
            ? { role: event.params.role, text: String(event.params.text || '').slice(0, 4000) } : {};
          events.push({ sequence: ++sequence, method, params }); if (events.length > 128) events.shift();
          if (['thread/realtime/error', 'thread/realtime/closed', 'draken/closed', 'draken/blocked'].includes(method)) void finish();
        });
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) { controller.abort(); void finish(); } });
        const answer = await call.open(offer, { signal: controller.signal });
        res.setHeader('Content-Type', 'application/sdp'); res.end(answer); return;
      }
      if (req.method === 'POST' && url.pathname === '/text') {
        const question = JSON.parse(await body(req)).question;
        if (!call || closing || typeof question !== 'string' || question.length > 2000) { res.writeHead(400); res.end(); return; }
        touched = Date.now(); await call.text(question); res.end('{}'); return;
      }
      if (req.method === 'POST' && url.pathname === '/end') {
        const result = await finish();
        res.setHeader('Content-Type', 'application/json');
        if (result?.helperExited === false) res.statusCode = 502;
        res.end(JSON.stringify({ helperExited: result?.helperExited !== false })); return;
      }
      res.writeHead(404); res.end();
    } catch { await finish(); if (!res.headersSent) res.writeHead(502); res.end('Native voice qualification failed. No provider fallback was attempted.'); }
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const sweep = setInterval(() => { if (accepted && Date.now() - touched > leaseMs) void finish(); }, Math.min(1000, leaseMs)); sweep.unref();
  const deadline = setTimeout(() => { void finish(); }, lifetimeMs); deadline.unref();
  return { origin, token, events,
    async close() { clearInterval(sweep); clearTimeout(deadline); await finish(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
