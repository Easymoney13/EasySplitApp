const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const security = require('../lib/security');

test('normalizeIp correctly normalizes IPv4-mapped IPv6 addresses', () => {
  assert.equal(security.normalizeIp('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(security.normalizeIp('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(security.normalizeIp('192.0.2.1'), '192.0.2.1');
  assert.equal(security.normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.equal(security.normalizeIp('  ::ffff:172.16.0.5  '), '172.16.0.5');
  assert.equal(security.normalizeIp(''), 'unknown');
  assert.equal(security.normalizeIp(null), 'unknown');
  assert.equal(security.normalizeIp(undefined), 'unknown');
});

test('createIpRateLimiter groups IPv4 and IPv4-mapped IPv6 into the same bucket', () => {
  const limiter = security.createIpRateLimiter({
    windowMs: 60_000,
    max: 2,
    message: 'Rate limit exceeded',
  });

  const reqIpv6Mapped = {
    headers: {},
    socket: { remoteAddress: '::ffff:198.51.100.22' },
  };

  const reqIpv4Direct = {
    headers: {},
    socket: { remoteAddress: '198.51.100.22' },
  };

  let statusCode = 200;
  let responseBody = null;
  const mockRes = () => ({
    setHeader: () => {},
    status: (code) => {
      statusCode = code;
      return {
        json: (data) => { responseBody = data; },
      };
    },
  });

  // Request 1: using IPv4-mapped IPv6
  let nextCalled = false;
  limiter.middleware(reqIpv6Mapped, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'First request should be allowed');

  // Request 2: using plain IPv4
  nextCalled = false;
  limiter.middleware(reqIpv4Direct, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'Second request should be allowed');

  // Request 3: using IPv4-mapped IPv6 again -> MUST be blocked because max is 2!
  nextCalled = false;
  limiter.middleware(reqIpv6Mapped, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'Third request should be blocked by shared rate limit');
  assert.equal(statusCode, 429, 'Status should be 429 Too Many Requests');
  assert.equal(responseBody?.error, 'Rate limit exceeded');
});

test('createUserRateLimiter groups anonymous IPv4 and IPv4-mapped IPv6 requests', () => {
  const limiter = security.createUserRateLimiter({
    shortWindowMs: 60_000,
    shortMax: 2,
    dailyWindowMs: 86400_000,
    dailyMax: 10,
    requireAuth: false,
  });

  const reqIpv6 = { socket: { remoteAddress: '::ffff:203.0.113.50' } };
  const reqIpv4 = { socket: { remoteAddress: '203.0.113.50' } };

  let statusCode = 200;
  let responseBody = null;
  const mockRes = () => ({
    setHeader: () => {},
    status: (code) => {
      statusCode = code;
      return { json: (data) => { responseBody = data; } };
    },
  });

  let nextCalled = false;
  limiter.middleware(reqIpv6, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  nextCalled = false;
  limiter.middleware(reqIpv4, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  // Third attempt should be rate-limited
  nextCalled = false;
  limiter.middleware(reqIpv4, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 429);
});

test('sanitization guards against script injection and prototype pollution keys', () => {
  const dirty = '<script>alert("pwned")</script>Hello & World';
  assert.equal(security.sanitizeString(dirty), 'Hello & World');

  const dangerousProtocol = 'javascript:alert(1)';
  assert.equal(security.sanitizeString(dangerousProtocol), 'alert(1)');

  const inlineHandler = '<img src=x onerror=alert(1)>';
  assert.equal(security.sanitizeString(inlineHandler), '');
});

test('room and session identifiers are validated strictly', () => {
  assert.equal(security.isValidSessionId('sess_123456789_abcdef'), true);
  assert.equal(security.isValidSessionId('sess_g_123456789_abcdef'), true);
  assert.equal(security.isValidSessionId('12345'), true);
  assert.equal(security.isValidSessionId('12345678'), true);
  // Invalid inputs
  assert.equal(security.isValidSessionId('../../../etc/passwd'), false);
  assert.equal(security.isValidSessionId('sess_<script>'), false);
  assert.equal(security.isValidSessionId(''), false);
  assert.equal(security.isValidSessionId(null), false);

  assert.equal(security.isValidGroupId('grp_123456789_abcdef'), true);
  assert.equal(security.isValidGroupId('12345678'), true);
  assert.equal(security.isValidGroupId('../sensitive/data'), false);
  assert.equal(security.isValidGroupId('grp_;DROP TABLE users;'), false);
});

test('API security middleware enforces no-store Cache-Control and handles JSON syntax errors cleanly', async () => {
  const app = express();
  app.disable('x-powered-by');

  // JSON Body Parser with security error handler
  app.use(express.json({ limit: '768kb' }));
  app.use((error, req, res, nextMiddleware) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    return nextMiddleware(error);
  });

  // API Cache-Control Middleware
  app.use('/api/', (req, res, nextMiddleware) => {
    const isPublicStaticApi = req.path === '/exchange-rates' || req.originalUrl?.startsWith('/api/exchange-rates');
    if (!isPublicStaticApi) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
    }
    nextMiddleware();
  });

  app.post('/api/test-json', (req, res) => {
    res.json({ success: true, body: req.body });
  });

  app.get('/api/session/test-session', (req, res) => {
    res.json({ success: true });
  });

  app.get('/api/exchange-rates', (req, res) => {
    res.json({ success: true, rates: { USD: 1 } });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Test X-Powered-By is disabled
    const getRes = await fetch(`http://127.0.0.1:${port}/api/session/test-session`);
    assert.equal(getRes.headers.get('x-powered-by'), null, 'X-Powered-By should be suppressed');
    assert.equal(getRes.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, private');
    assert.equal(getRes.headers.get('pragma'), 'no-cache');

    // 2. Test exchange-rates is excluded from private cache-control
    const ratesRes = await fetch(`http://127.0.0.1:${port}/api/exchange-rates`);
    assert.equal(ratesRes.headers.get('cache-control'), null);

    // 3. Test malformed JSON syntax error returns clean 400 JSON (no HTML, no stack trace)
    const malformedRes = await fetch(`http://127.0.0.1:${port}/api/test-json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"unclosed": "brace"',
    });
    assert.equal(malformedRes.status, 400);
    const malformedBody = await malformedRes.json();
    assert.deepEqual(malformedBody, { error: 'Invalid JSON payload' });

    // 4. Test valid JSON succeeds
    const validRes = await fetch(`http://127.0.0.1:${port}/api/test-json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: 'Coffee' }),
    });
    assert.equal(validRes.status, 200);
    const validBody = await validRes.json();
    assert.equal(validBody.body.item, 'Coffee');
  } finally {
    server.close();
  }
});

test('WebSocket handler enforces protocol rules and terminates clients on repeated violations', async () => {
  const server = http.createServer();
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    ws.invalidMessageCount = 0;
    ws.on('message', (message) => {
      function recordViolation(reason = 'Protocol violation') {
        ws.invalidMessageCount = (ws.invalidMessageCount || 0) + 1;
        if (ws.invalidMessageCount >= 3) {
          ws.close(1008, reason);
          return true;
        }
        return false;
      }

      try {
        const data = JSON.parse(message.toString());
        if (!data.accessToken) {
          if (!recordViolation('Invalid credentials')) {
            ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid credentials' }));
          }
        }
      } catch (err) {
        if (!recordViolation('Invalid payload')) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid message' }));
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => client.on('open', resolve));

    let closeCode = null;
    let closeReason = '';
    client.on('close', (code, reason) => {
      closeCode = code;
      closeReason = reason.toString();
    });

    // Send 1st invalid frame
    client.send('invalid json 1');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(client.readyState, WebSocket.OPEN, 'Socket should remain open after 1st violation');

    // Send 2nd invalid frame
    client.send('invalid json 2');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(client.readyState, WebSocket.OPEN, 'Socket should remain open after 2nd violation');

    // Send 3rd invalid frame -> MUST trigger code 1008 termination
    client.send('invalid json 3');
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(closeCode, 1008, 'Should be disconnected with 1008');
    assert.equal(closeReason, 'Invalid payload');
  } finally {
    wss.close();
    server.close();
  }
});
