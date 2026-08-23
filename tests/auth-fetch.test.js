const test = require('node:test');
const assert = require('node:assert/strict');

const { getFetchInputUrl, isProtectedSameOriginApi } = require('../lib/authFetch');

const origin = 'https://billspltapp.onrender.com';

test('fetch interception accepts strings, URL objects, and Request-like inputs', () => {
  assert.equal(getFetchInputUrl('/api/user/groups'), '/api/user/groups');
  assert.equal(getFetchInputUrl(new URL('/session/example', origin)), `${origin}/session/example`);
  assert.equal(getFetchInputUrl({ url: `${origin}/api/history` }), `${origin}/api/history`);
  assert.equal(getFetchInputUrl({}), '');
});

test('auth is attached only to protected same-origin API requests', () => {
  assert.equal(isProtectedSameOriginApi('/api/user/groups', origin), true);
  assert.equal(isProtectedSameOriginApi(new URL('/api/history', origin), origin), true);
  assert.equal(isProtectedSameOriginApi({ url: `${origin}/api/groups` }, origin), true);
  assert.equal(isProtectedSameOriginApi('/session/example', origin), false);
  assert.equal(isProtectedSameOriginApi('/api/exchange-rates', origin), false);
  assert.equal(isProtectedSameOriginApi('/api/network-ip', origin), false);
  assert.equal(isProtectedSameOriginApi('https://attacker.example/api/history', origin), false);
  assert.equal(isProtectedSameOriginApi({ url: undefined }, origin), false);
});
