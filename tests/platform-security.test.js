const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createApiCorsMiddleware,
  createCsrfProtectionMiddleware,
  isAllowedClientOrigin,
  normalizeOrigin,
  parseAllowedOrigins,
  resolveAllowedMobileOrigins,
} = require('../lib/platformSecurity');

test('normalizes standard and Capacitor origins exactly', () => {
  assert.equal(normalizeOrigin('https://localhost/'), 'https://localhost');
  assert.equal(normalizeOrigin('capacitor://localhost/'), 'capacitor://localhost');
  assert.equal(normalizeOrigin('not a url'), '');
});

test('native Capacitor origins are exact safe defaults and explicit values only extend them', () => {
  const defaults = resolveAllowedMobileOrigins();
  assert.deepEqual([...defaults].sort(), ['capacitor://localhost', 'https://localhost'].sort());
  assert.equal(defaults.has('https://localhost.attacker.example'), false);

  const extended = resolveAllowedMobileOrigins('https://native-preview.easysplit.example');
  assert.equal(extended.has('capacitor://localhost'), true);
  assert.equal(extended.has('https://localhost'), true);
  assert.equal(extended.has('https://native-preview.easysplit.example'), true);
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
  assert.match(ios.headers.get('access-control-allow-headers'), /X-EasySplit-Client-Id/);
  assert.match(ios.headers.get('access-control-allow-headers'), /X-Firebase-AppCheck/);

  const android = run({ origin: 'https://localhost', method: 'OPTIONS' });
  assert.equal(android.statusCode, 204);
  assert.equal(android.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.match(android.headers.get('access-control-allow-headers'), /X-EasySplit-Client-Id/);

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

test('CSRF protection middleware permits valid mutations and rejects malicious cross-site forms', () => {
  const allowed = parseAllowedOrigins('capacitor://localhost,https://localhost');
  const csrfMiddleware = createCsrfProtectionMiddleware(allowed);

  function runCsrf({ method = 'POST', path = '/api/session/create', headers = {} }) {
    let statusCode = 200;
    let ended = false;
    let nextCalled = false;
    let responseBody = null;
    const req = { method, path, headers };
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { responseBody = data; ended = true; return this; },
      end() { ended = true; return this; },
    };
    csrfMiddleware(req, res, () => { nextCalled = true; });
    return { statusCode, ended, nextCalled, responseBody };
  }

  // Safe GET request passes
  const safeGet = runCsrf({ method: 'GET' });
  assert.equal(safeGet.nextCalled, true);
  assert.equal(safeGet.statusCode, 200);

  // Non-API mutation passes
  const nonApiPost = runCsrf({ path: '/other-route' });
  assert.equal(nonApiPost.nextCalled, true);

  // Legitimate same-host JSON API mutation passes
  const legitimateSameOrigin = runCsrf({
    headers: {
      host: 'easysplit.example',
      origin: 'https://easysplit.example',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-easysplit-client-id': 'client-123',
    },
  });
  assert.equal(legitimateSameOrigin.nextCalled, true);

  // Legitimate mobile Capacitor mutation passes
  const legitimateMobile = runCsrf({
    headers: {
      host: 'easysplit.example',
      origin: 'capacitor://localhost',
      'sec-fetch-site': 'cross-site',
      'content-type': 'application/json',
      'x-room-token': 'token-xyz',
    },
  });
  assert.equal(legitimateMobile.nextCalled, true);

  // Malicious cross-site form submission blocked
  const crossSiteForm = runCsrf({
    headers: {
      host: 'easysplit.example',
      origin: 'https://evil-site.attacker.com',
      'sec-fetch-site': 'cross-site',
      'content-type': 'application/x-www-form-urlencoded',
    },
  });
  assert.equal(crossSiteForm.nextCalled, false);
  assert.equal(crossSiteForm.statusCode, 403);

  // Malicious cross-origin API call blocked
  const crossOriginAttacker = runCsrf({
    headers: {
      host: 'easysplit.example',
      origin: 'https://evil-site.attacker.com',
      'content-type': 'application/json',
    },
  });
  assert.equal(crossOriginAttacker.nextCalled, false);
  assert.equal(crossOriginAttacker.statusCode, 403);
});
