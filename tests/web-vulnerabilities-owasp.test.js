const test = require('node:test');
const assert = require('node:assert/strict');
const security = require('../lib/security');
const { requirePrice, validateItems, sanitizeUserSettings, requireString } = require('../lib/validation');
const { hashAccessToken, tokenMatches, createAccessToken } = require('../lib/ids');
const { canPerformSessionAction, processSessionAction } = require('../lib/sessionActions');
const { publicRoom, stripPrivateFields } = require('../lib/roomAuth');

// =========================================================================
// OWASP A01: Broken Access Control (IDOR & Unauthorized Actions)
// =========================================================================
test('OWASP A01: Non-member cannot perform any session action', () => {
  const session = {
    id: 'sess_12345',
    status: 'active',
    members: [
      { id: 'member_host', isHost: true },
      { id: 'member_guest', isHost: false },
    ],
    items: [],
  };

  const outsiderActor = { memberId: 'member_intruder' };
  const auth = canPerformSessionAction(session, 'TOGGLE_CLAIM', outsiderActor, { itemId: 'item_1' });
  assert.equal(auth.allowed, false);
  assert.match(auth.reason, /not a member/i);
});

test('OWASP A01: Guest member cannot execute host-only actions', () => {
  const session = {
    id: 'sess_12345',
    status: 'active',
    members: [
      { id: 'member_host', isHost: true },
      { id: 'member_guest', isHost: false },
    ],
    items: [{ id: 'item_1', name: 'Pizza', price: 50, claimedBy: [] }],
  };

  const guestActor = { memberId: 'member_guest' };
  const hostOnlyActions = ['SPLIT_EVERYONE', 'ADD_ITEM', 'EDIT_ITEM', 'DELETE_ITEM', 'SET_TIP', 'SETTLE_ALL'];

  for (const action of hostOnlyActions) {
    const auth = canPerformSessionAction(session, action, guestActor, { itemId: 'item_1' });
    assert.equal(auth.allowed, false, `Guest must not be allowed to perform ${action}`);
    assert.match(auth.reason, /Only the host/i);
  }
});

test('OWASP A01: Member cannot claim items for another member or modify another member settlement', () => {
  const session = {
    id: 'sess_12345',
    status: 'active',
    members: [
      { id: 'member_alice', isHost: false },
      { id: 'member_bob', isHost: false },
    ],
    items: [{ id: 'item_1', name: 'Burger', price: 40, claimedBy: [] }],
  };

  // Alice tries to claim for Bob
  const aliceActor = { memberId: 'member_alice' };
  const claimAuth = canPerformSessionAction(session, 'TOGGLE_CLAIM', aliceActor, {
    itemId: 'item_1',
    memberId: 'member_bob',
  });
  assert.equal(claimAuth.allowed, false);
  assert.match(claimAuth.reason, /only claim items for yourself/i);

  // Alice tries to change Bob's settlement status
  const settleAuth = canPerformSessionAction(session, 'TOGGLE_SETTLED', aliceActor, {
    memberId: 'member_bob',
  });
  assert.equal(settleAuth.allowed, false);
  assert.match(settleAuth.reason, /only update your own payment status/i);
});

// =========================================================================
// OWASP A02: Cryptographic Failures & Timing Attack Resistance
// =========================================================================
test('OWASP A02: Access tokens have high entropy and timing-safe equality comparison', () => {
  const token = createAccessToken();
  assert.ok(token.length >= 40, 'Access token must have at least 256 bits of entropy');

  const tokenHash = hashAccessToken(token);
  assert.equal(tokenHash.length, 64, 'Token hash must be SHA-256 (64 hex characters)');

  // Constant-time match validation
  assert.equal(tokenMatches(token, tokenHash), true);
  assert.equal(tokenMatches('wrong_token', tokenHash), false);
  assert.equal(tokenMatches('', tokenHash), false);
  assert.equal(tokenMatches(token, ''), false);
});

// =========================================================================
// OWASP A03: Injection (XSS, Path Traversal, SQLi, Script Injection)
// =========================================================================
test('OWASP A03: Sanitization purges malicious scripts and dangerous handlers', () => {
  const xssPayloads = [
    '<script>evilCode()</script>',
    '<SCRIPT SRC="https://evil.com/xss.js"></SCRIPT>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">Click</a>',
    '<style>body{background:url("javascript:alert(1)")}</style>',
  ];

  for (const payload of xssPayloads) {
    const clean = security.sanitizeString(payload);
    assert.doesNotMatch(clean, /<script/i);
    assert.doesNotMatch(clean, /onerror=/i);
    assert.doesNotMatch(clean, /javascript:/i);
    assert.doesNotMatch(clean, /<style/i);
  }
});

test('OWASP A03: Path traversal and SQL injection in session/group IDs are rejected', () => {
  const dangerousIds = [
    '../../../etc/passwd',
    '..\\..\\windows\\system32',
    'sess_123; DROP TABLE users;--',
    'grp_123" OR 1=1--',
    'sess_123<script>',
    'sess_%2e%2e%2f',
  ];

  for (const id of dangerousIds) {
    assert.equal(security.isValidSessionId(id), false, `Invalid session ID should be rejected: ${id}`);
    assert.equal(security.isValidGroupId(id), false, `Invalid group ID should be rejected: ${id}`);
  }
});

// =========================================================================
// OWASP A04: Insecure Design & Input Boundaries
// =========================================================================
test('OWASP A04: Financial prices reject negative, zero, and infinite values', () => {
  assert.throws(() => requirePrice(-10, 'price'), /must be between/i);
  assert.throws(() => requirePrice(0, 'price'), /must be between/i);
  assert.throws(() => requirePrice(Infinity, 'price'), /must be between/i);
  assert.throws(() => requirePrice(NaN, 'price'), /must be between/i);
  assert.throws(() => requirePrice(50001, 'price'), /must be between/i);

  // Valid prices accepted and rounded to 2 decimals
  assert.equal(requirePrice(19.994), 19.99);
  assert.equal(requirePrice('25.50'), 25.5);
});

test('OWASP A04: Item lists reject excessive elements to prevent resource exhaustion', () => {
  const maxItems = 5;
  const oversizedList = Array.from({ length: 6 }, (_, i) => ({
    name: `Item ${i}`,
    price: 10,
    claimedBy: [],
  }));

  assert.throws(() => validateItems(oversizedList, { maxItems }), /cannot contain more than 5 items/i);
});

// =========================================================================
// OWASP A08: Software & Data Integrity (Prototype Pollution Defense)
// =========================================================================
test('OWASP A08: Injected prototype keys do not pollute Object.prototype', () => {
  const maliciousSettings = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"hacked":true}},"language":"en"}');

  const sanitized = sanitizeUserSettings(maliciousSettings);
  assert.equal(sanitized.language, 'en');

  // Verify Object.prototype was NOT polluted
  const cleanObject = {};
  assert.equal(cleanObject.polluted, undefined, 'Object.prototype must not have polluted property');
  assert.equal(cleanObject.hacked, undefined, 'Object.prototype must not have hacked property');
});

// =========================================================================
// OWASP A09: Security Logging & Information Exposure Defense
// =========================================================================
test('OWASP A09: stripPrivateFields purges secret hashes and sensitive telemetry credentials', () => {
  const internalRoom = {
    id: 'sess_abc',
    accessTokenHash: 'secret_hash_value',
    accessTokenHashes: ['hash_1', 'hash_2'],
    hostTokenHash: 'host_secret',
    inviteTokenHash: 'invite_secret',
    identityAttestation: 'sensitive_sig',
    scanId: 'scan_internal_id',
    name: 'Lunch Split',
  };

  const sanitized = stripPrivateFields(internalRoom);
  assert.equal(sanitized.name, 'Lunch Split');
  assert.equal(sanitized.accessTokenHash, undefined);
  assert.equal(sanitized.accessTokenHashes, undefined);
  assert.equal(sanitized.hostTokenHash, undefined);
  assert.equal(sanitized.inviteTokenHash, undefined);
  assert.equal(sanitized.identityAttestation, undefined);
  assert.equal(sanitized.scanId, undefined);
});
