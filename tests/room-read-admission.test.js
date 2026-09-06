const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomReadAdmission } = require('../lib/roomReadAdmission');
const { createRoomPollPolicy } = require('../lib/roomPolling');

function response() {
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; }, json() {} };
}
function request(i, room = 'sess_test') {
  return { path: `/api/session/${room}`, params: { idOrCode: room },
    ip: '192.0.2.1', headers: { 'x-room-token': `valid-token-for-member-${i}` } };
}

test('ten guests on shared Wi-Fi can poll every three seconds for twenty virtual minutes', () => {
  let time = 0;
  let discoveries = 0;
  const admission = createRoomReadAdmission({ now: () => time, discover: (req, res, next) => { discoveries += 1; next(); } });
  const guests = Array.from({ length: 10 }, (_, i) => request(i));
  guests.forEach(req => admission.remember(req, req.params.idOrCode));
  for (time = 0; time <= 1_200_000; time += 3000) {
    for (const req of guests) {
      let passed = false;
      const res = response();
      admission.middleware(req, res, () => { passed = true; });
      assert.equal(passed, true);
      assert.equal(res.statusCode, 200);
      // Mirrors fresh membership validation in the route, not authorization caching.
      admission.remember(req, req.params.idOrCode);
    }
  }
  assert.equal(discoveries, 0);
});

test('forged tokens, other rooms and expired classifications still consume discovery budget', () => {
  let time = 0;
  let discoveries = 0;
  const admission = createRoomReadAdmission({ now: () => time, discover: () => { discoveries += 1; } });
  const req = request(1);
  admission.remember(req, 'sess_test');
  admission.middleware(request(2), response(), () => assert.fail());
  admission.middleware(request(1, 'sess_other'), response(), () => assert.fail());
  time = 600_001;
  admission.middleware(req, response(), () => assert.fail());
  assert.equal(discoveries, 3);
});

test('member read exhaustion returns Retry-After and does not consume payment-target budget', () => {
  const admission = createRoomReadAdmission({ now: () => 0, discover: () => assert.fail() });
  const req = request(1);
  admission.remember(req, 'sess_test');
  for (let i = 0; i < 600; i++) admission.middleware(req, response(), () => {});
  const blocked = response();
  admission.middleware(req, blocked, () => assert.fail());
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '600');
  const payment = { ...req, path: `${req.path}/payment-target/member` };
  let passed = false;
  admission.middleware(payment, response(), () => { passed = true; });
  assert.equal(passed, true);
});

test('polling reduces healthy traffic, prevents overlap, resumes fallback and obeys server backoff', () => {
  let time = 0;
  const policy = createRoomPollPolicy({ now: () => time });
  time = 3000;
  assert.equal(policy.begin({ connected: true }), false);
  assert.equal(policy.begin({ connected: false }), true);
  assert.equal(policy.begin({ force: true }), false);
  policy.finish(200);
  time = 33_000;
  assert.equal(policy.begin({ visible: false, force: true }), false);
  assert.equal(policy.begin({ connected: true }), true);
  policy.finish(429, '120');
  time = 150_000;
  assert.equal(policy.begin({ force: true }), false);
  time = 153_000;
  assert.equal(policy.begin({ force: true }), true);
  policy.finish(200);
  time += 3000;
  assert.equal(policy.begin({ connected: false }), true);
});
