import http from 'node:http';
import { randomUUID } from 'node:crypto';

/** No proxying: this endpoint can emit only one assistant TEXT message.
 * Model tool schemas, instructions and arbitrary request options are never
 * forwarded to a provider. The host callback is a separately bounded read-only
 * service; its return value cannot become a function call in the native agent.
 */
export async function createReadOnlyBackend({ answer, authorize = () => false, onBlocked = () => {}, maxRequests = 8 } = {}) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 120) {
    throw new Error('Native backing request limit must be an integer between 1 and 120.');
  }
  const active = new Set(); let used = 0, stopped = false;
  const server = http.createServer(async (req, res) => {
    let controller, timer;
    let removeAbort = () => {};
    const stopBody = () => { if (!req.complete) req.destroy(); };
    try {
      // Admission is inside the error boundary too: URL/auth failures must not
      // escape this async listener and terminate the hosting Draken process.
      if (answer && !authorize(req.headers)) { req.resume(); res.writeHead(403); res.end('{}'); return; }
      let pathname;
      try { pathname = new URL(req.url, 'http://localhost').pathname; }
      catch { req.resume(); res.writeHead(400, { 'Content-Type': 'application/json', Connection: 'close' }); res.end('{}'); return; }
      // Native ChatGPT auth always probes catalog metadata. Deny discovery without
      // mistaking it for execution; the helper has built-in metadata.
      if (req.method === 'GET' && pathname === '/v1/models') { req.resume(); res.writeHead(403); res.end('{}'); return; }
      if (stopped || !answer || req.method !== 'POST' || pathname !== '/v1/responses' || active.size || ++used > maxRequests) {
        req.resume(); res.writeHead(403, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error: { code: 'draken_voice_read_only', message: 'No backing execution allowed.' } })); await onBlocked(); return;
      }
      controller = new AbortController(); active.add(controller);
      timer = setTimeout(() => controller.abort(), 45_000);
      controller.signal.addEventListener('abort', stopBody, { once: true });
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      if (req.headers['content-encoding']) throw new Error('Encoded backend request is not supported.');
      req.setEncoding('utf8'); let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 300_000 || controller.signal.aborted) throw new Error('Backend request exceeds its limit.'); }
      const value = JSON.parse(body);
      if (!Array.isArray(value.input) || value.input.length > 256) throw new Error('Invalid backend input.');
      const text = await Promise.race([
        Promise.resolve().then(() => answer(value.input, controller.signal)),
        new Promise((_, reject) => {
          const abort = () => reject(new Error('Backend request cancelled.'));
          removeAbort = () => controller.signal.removeEventListener('abort', abort);
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        }),
      ]);
      if (controller.signal.aborted || stopped) throw new Error('Backend request cancelled.');
      if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('Invalid backend text.');
      const id = `resp_${randomUUID()}`, itemId = `msg_${randomUUID()}`;
      const part = { type: 'output_text', text, annotations: [] };
      const item = { id: itemId, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: [part] };
      let sequence = 0;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'close' });
      const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
      event('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
      event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      event('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { ...part, text: '' } });
      event('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: text });
      event('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text });
      event('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', { response: { id, object: 'response', status: 'completed', output: [item] } });
      res.end();
    } catch {
      req.resume();
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: { code: 'draken_voice_backend_failed', message: 'No reliable read-only answer was available.' } }));
    } finally {
      clearTimeout(timer); removeAbort();
      if (controller) { controller.signal.removeEventListener('abort', stopBody); active.delete(controller); }
    }
  });
  server.requestTimeout = 50_000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`,
    async close() { stopped = true; for (const controller of active) controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
