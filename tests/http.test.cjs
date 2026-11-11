const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const express = require('express');
const { route, connected } = require('../dist/routes/http');
const { HttpError } = require('../dist/errors');

test('async routes deliver successful replies and forward synchronous and asynchronous errors', async t => {
  const app = express();
  app.get('/ok', route(async (_req, res) => res.json({ ready: true })));
  app.get('/sync-error', route(() => { throw new HttpError(409, 'busy'); }));
  app.get('/async-error', route(async () => { throw new HttpError(503, 'unavailable'); }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, status, body] of [
    ['/ok', 200, { ready: true }],
    ['/sync-error', 409, { error: 'busy' }],
    ['/async-error', 503, { error: 'unavailable' }],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
  }
});

function response() {
  return Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
}

test('disconnect cancels an in-flight operation and releases its close listener', async () => {
  const res = response();
  const result = connected(res, signal => new Promise(resolve => signal.addEventListener('abort', () => resolve('cancelled'), { once: true })));
  res.emit('close');
  assert.equal(await result, 'cancelled');
  assert.equal(res.listenerCount('close'), 0);
});

test('completed responses do not cancel work and successful operations retain their result', async () => {
  const res = response();
  let signal;
  const value = await connected(res, async current => {
    signal = current;
    res.writableEnded = true;
    res.emit('close');
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(signal.aborted, false);
  assert.equal(res.listenerCount('close'), 0);
});

test('already-disconnected responses supply an aborted signal', async () => {
  const res = response(); res.destroyed = true;
  await connected(res, async signal => assert.equal(signal.aborted, true));
  assert.equal(res.listenerCount('close'), 0);
});

test('operation failures propagate unchanged and do not retain response listeners', async () => {
  const error = new Error('operation failed');
  for (const operation of [() => { throw error; }, async () => { throw error; }]) {
    const res = response();
    await assert.rejects(connected(res, operation), actual => actual === error);
    assert.equal(res.listenerCount('close'), 0);
  }
});
