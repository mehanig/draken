const { test } = require('node:test');
const assert = require('node:assert/strict');
const { storedSession, saveSession, clearSession, authorizationHeaders } = require('../client/src/auth/session.ts');
const { linkClick } = require('../client/src/navigation.ts');

test('credential changes reach requests immediately and clearing leaves unrelated preferences intact', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map([['preference', 'keep']]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; });
  assert.deepEqual(authorizationHeaders(), {});
  saveSession('first-token', 'Alice');
  assert.deepEqual(storedSession(), { token: 'first-token', username: 'Alice' });
  assert.deepEqual(authorizationHeaders(), { Authorization: 'Bearer first-token' });
  saveSession('second-token', 'Bob');
  assert.deepEqual(authorizationHeaders(), { Authorization: 'Bearer second-token' });
  clearSession();
  assert.deepEqual(storedSession(), { token: null, username: null });
  assert.deepEqual(authorizationHeaders(), {});
  assert.equal(values.get('preference'), 'keep');
});

test('ordinary navigation is intercepted but modified clicks retain browser behavior', () => {
  let prevented = 0;
  const destinations = [];
  const event = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() { prevented++; } };
  const navigate = path => destinations.push(path);
  linkClick(event, navigate, '/syncs/1');
  assert.equal(prevented, 1);
  assert.deepEqual(destinations, ['/syncs/1']);
  for (const variation of [{ button: 1 }, { button: 2 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
    linkClick({ ...event, ...variation }, navigate, '/syncs/2');
  }
  assert.equal(prevented, 1);
  assert.deepEqual(destinations, ['/syncs/1']);
});
