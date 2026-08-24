const test = require('node:test');
const assert = require('node:assert/strict');
const { getFetchInputUrl, isProtectedApi, isProtectedSameOriginApi } = require('../lib/authFetch');

const origin = 'https://billspltapp.onrender.com';

test('legacy same-origin auth behavior is preserved exactly', () => {
  assert.equal(getFetchInputUrl('/api/user/groups'), '/api/user/groups');
  assert.equal(isProtectedSameOriginApi('/api/user/groups', origin), true);
  assert.equal(isProtectedSameOriginApi('/api/exchange-rates', origin), false);
  assert.equal(isProtectedSameOriginApi('/api/network-ip', origin), false);
  assert.equal(isProtectedSameOriginApi('https://attacker.example/api/history', origin), false);
});

test('native backend origin receives auth while unrelated origins do not', () => {
  const pageOrigin = 'capacitor://localhost';
  const apiOrigin = 'https://api.easysplit.test';
  assert.equal(isProtectedApi(`${apiOrigin}/api/user/groups`, pageOrigin, apiOrigin), true);
  assert.equal(isProtectedApi(`${apiOrigin}/api/history`, pageOrigin, apiOrigin), true);
  assert.equal(isProtectedApi(`${apiOrigin}/api/exchange-rates`, pageOrigin, apiOrigin), false);
  assert.equal(isProtectedApi('https://attacker.example/api/history', pageOrigin, apiOrigin), false);
});

test('relative URLs are not accidentally authenticated to a remote backend', () => {
  assert.equal(isProtectedApi('/api/history', 'capacitor://localhost', 'https://api.easysplit.test'), false);
});
