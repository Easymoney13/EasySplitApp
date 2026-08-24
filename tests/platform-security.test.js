const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createApiCorsMiddleware,
  isAllowedClientOrigin,
  normalizeOrigin,
  parseAllowedOrigins,
} = require('../lib/platformSecurity');

test('normalizes standard and Capacitor origins exactly', () => {
  assert.equal(normalizeOrigin('https://localhost/'), 'https://localhost');
  assert.equal(normalizeOrigin('capacitor://localhost/'), 'capacitor://localhost');
  assert.equal(normalizeOrigin('not a url'), '');
});

test('origin allowlist preserves same-origin web and admits only configured native origins', () => {
  const allowed = parseAllowedOrigins('capacitor://localhost, https://localhost');
  assert.equal(isAllowedClientOrigin('https://easysplit.example', 'easysplit.example', allowed), true);
  assert.equal(isAllowedClientOrigin('capacitor://localhost', 'easysplit.example', allowed), true);
  assert.equal(isAllowedClientOrigin('https://localhost', 'easysplit.example', allowed), true);
  assert.equal(isAllowedClientOrigin('https://attacker.example', 'easysplit.example', allowed), false);
  assert.equal(isAllowedClientOrigin('', 'easysplit.example', allowed), true);
});

test('CORS middleware leaves web requests untouched and only opens exact configured native origins', () => {
  const allowed = parseAllowedOrigins('capacitor://localhost,https://localhost');
  const middleware = createApiCorsMiddleware(allowed);

  function run({ origin, host = 'api.easysplit.test', method = 'GET', path = '/api/session/x' }) {
    const headers = new Map();
    let statusCode = 200;
    let ended = false;
    let nextCalled = false;
    const req = { method, path, headers: { origin, host } };
    const res = {
      setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
      getHeader(name) { return headers.get(name.toLowerCase()); },
      status(code) { statusCode = code; return this; },
      end() { ended = true; return this; },
    };
    middleware(req, res, () => { nextCalled = true; });
    return { headers, statusCode, ended, nextCalled };
  }

  const web = run({ origin: 'https://api.easysplit.test' });
  assert.equal(web.nextCalled, true);
  assert.equal(web.headers.has('access-control-allow-origin'), false);

  const ios = run({ origin: 'capacitor://localhost', method: 'OPTIONS' });
  assert.equal(ios.statusCode, 204);
  assert.equal(ios.ended, true);
  assert.equal(ios.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  assert.match(ios.headers.get('access-control-allow-headers'), /X-Room-Token/);

  const android = run({ origin: 'https://localhost', method: 'OPTIONS' });
  assert.equal(android.statusCode, 204);
  assert.equal(android.headers.get('access-control-allow-origin'), 'https://localhost');

  const attacker = run({ origin: 'https://attacker.example', method: 'OPTIONS' });
  assert.equal(attacker.statusCode, 403);
  assert.equal(attacker.headers.has('access-control-allow-origin'), false);

  const attackerSimpleRequest = run({ origin: 'https://attacker.example', method: 'GET' });
  assert.equal(attackerSimpleRequest.statusCode, 403);
  assert.equal(attackerSimpleRequest.ended, true);
  assert.equal(attackerSimpleRequest.nextCalled, false);

  const iosGet = run({ origin: 'capacitor://localhost', method: 'GET' });
  assert.equal(iosGet.statusCode, 200);
  assert.equal(iosGet.nextCalled, true);
  assert.equal(iosGet.headers.get('access-control-allow-origin'), 'capacitor://localhost');
});

test('origin matching is exact and resists localhost lookalikes', () => {
  const allowed = parseAllowedOrigins('capacitor://localhost,https://localhost');
  assert.equal(isAllowedClientOrigin('https://localhost.attacker.example', 'api.easysplit.test', allowed), false);
  assert.equal(isAllowedClientOrigin('capacitor://localhost.attacker.example', 'api.easysplit.test', allowed), false);
  assert.equal(isAllowedClientOrigin('https://localhost:444', 'api.easysplit.test', allowed), false);
});
