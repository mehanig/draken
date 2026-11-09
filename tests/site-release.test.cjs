const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateCopy, waitForPublished } = require('../scripts/site-release.cjs');
test('website copy must match its committed stable npm version', () => {
  validateCopy('0.4.1', 'Version 0.4.1 / Available on npm CHANGELOG.md#041');
  assert.throws(() => validateCopy('0.4.1', 'Version 0.4.0 / Available on npm CHANGELOG.md#040'), /does not match/);
  assert.throws(() => validateCopy('0.4.1-beta', 'Version 0.4.1-beta / Available on npm CHANGELOG.md#041-beta'), /does not match/);
});
test('website waits for npm latest propagation before permitting deployment', async () => {
  let requests = 0, waits = 0;
  await waitForPublished('0.4.1', { attempts: 2, pause: async () => { waits++; }, fetcher: async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/draken/latest'); assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ version: ++requests === 1 ? '0.4.0' : '0.4.1' }) };
  } });
  assert.equal(requests, 2); assert.equal(waits, 1);
});
test('unpublished versions and registry failures cannot authorize website deployment', async () => {
  for (const version of ['0.4.0', '0.5.0']) await assert.rejects(waitForPublished('0.4.1', {
    attempts: 1, fetcher: async () => ({ ok: true, json: async () => ({ version }) }),
  }), /deployment was withheld/);
  await assert.rejects(waitForPublished('0.4.1', { attempts: 1, fetcher: async () => ({ ok: false, status: 503 }) }), /withheld/);
  await assert.rejects(waitForPublished('0.4.1', { attempts: 1, fetcher: async () => { throw Error('Network unavailable'); } }), /Network unavailable/);
});
