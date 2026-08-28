const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserRateLimiter } = require('../lib/security');

test('createUserRateLimiter enforces authentication when requireAuth is enabled', () => {
  const limiter = createUserRateLimiter({
    requireAuth: true,
    unauthMessage: 'Sign in required',
  });

  const req = { body: { imageBase64: 'fake-data' }, user: null, ip: '127.0.0.1' };
  let statusSet = 0;
  let jsonSent = null;
  const res = {
    status(code) {
      statusSet = code;
      return this;
    },
    json(payload) {
      jsonSent = payload;
      return this;
    },
    setHeader() {},
  };

  let nextCalled = false;
  limiter.middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusSet, 401);
  assert.equal(jsonSent?.errorCode, 'AUTH_REQUIRED');
});

test('createUserRateLimiter enforces short-window cap for authenticated users', () => {
  const limiter = createUserRateLimiter({
    shortWindowMs: 10 * 60 * 1000,
    shortMax: 3,
    dailyWindowMs: 24 * 60 * 60 * 1000,
    dailyMax: 10,
    requireAuth: true,
  });

  const makeReq = () => ({
    body: { imageBase64: 'fake-data' },
    user: { uid: 'test-user-123' },
    ip: '127.0.0.1',
  });

  const createMockRes = () => {
    const headers = {};
    let status = 200;
    let json = null;
    return {
      setHeader(k, v) { headers[k] = v; },
      status(code) { status = code; return this; },
      json(payload) { json = payload; return this; },
      getStatus: () => status,
      getJson: () => json,
      getHeaders: () => headers,
    };
  };

  // 1st request -> allowed
  let allowed1 = false;
  limiter.middleware(makeReq(), createMockRes(), () => { allowed1 = true; });
  assert.equal(allowed1, true);

  // 2nd request -> allowed
  let allowed2 = false;
  limiter.middleware(makeReq(), createMockRes(), () => { allowed2 = true; });
  assert.equal(allowed2, true);

  // 3rd request -> allowed
  let allowed3 = false;
  limiter.middleware(makeReq(), createMockRes(), () => { allowed3 = true; });
  assert.equal(allowed3, true);

  // 4th request -> blocked by short window cap
  let allowed4 = false;
  const res4 = createMockRes();
  limiter.middleware(makeReq(), res4, () => { allowed4 = true; });
  assert.equal(allowed4, false);
  assert.equal(res4.getStatus(), 429);
  assert.equal(res4.getJson()?.errorCode, 'RATE_LIMIT_EXCEEDED');
});

test('createUserRateLimiter enforces daily cap across multiple short windows', () => {
  const limiter = createUserRateLimiter({
    shortWindowMs: 1000,
    shortMax: 2,
    dailyWindowMs: 10_000,
    dailyMax: 3,
    requireAuth: true,
  });

  const userKey = 'user:daily-test-uid';
  let now = 1000;

  // 1st call
  let res1 = limiter.check(userKey, now);
  assert.equal(res1.allowed, true);

  // 2nd call
  let res2 = limiter.check(userKey, now + 100);
  assert.equal(res2.allowed, true);

  // 3rd call in same short window -> blocked by short
  let res3 = limiter.check(userKey, now + 200);
  assert.equal(res3.allowed, false);
  assert.equal(res3.reason, 'short');

  // Advance time past short window (1500ms later) -> 3rd daily call allowed
  now += 1500;
  let res4 = limiter.check(userKey, now);
  assert.equal(res4.allowed, true);

  // Advance time past short window again -> but daily cap (3 calls) is reached!
  now += 1500;
  let res5 = limiter.check(userKey, now);
  assert.equal(res5.allowed, false);
  assert.equal(res5.reason, 'daily');
  assert.equal(res5.message.includes('Daily'), true);
});

test('createUserRateLimiter skips rate limiting for manual/confirmed bills', () => {
  const limiter = createUserRateLimiter({
    requireAuth: true,
  });

  // Client-confirmed draft has parsedBill but NO imageBase64 or rawText
  const req = {
    body: {
      parsedBill: { storeName: 'Manual Cafe', items: [{ name: 'Coffee', price: 15 }] },
    },
    user: null, // Even without auth, manual creation proceeds
    ip: '127.0.0.1',
  };

  let nextCalled = false;
  limiter.middleware(req, {}, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});
