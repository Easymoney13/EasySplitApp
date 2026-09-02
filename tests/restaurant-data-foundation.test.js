const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-restaurant-foundation-'));
const dbPath = path.join(tempDir, 'db.json');
process.env.BILLSPLIT_DB_PATH = dbPath;
process.env.EASYSPLIT_IDENTITY_HMAC_SECRET = 'restaurant-foundation-test-secret-123456';
process.env.EASYSPLIT_IDENTITY_HMAC_KEY_VERSION = 'test-v1';

const dbModule = require('../lib/db');
const db = dbModule.db || dbModule;
const { isRestaurantDataAdmin } = require('../lib/adminAuthorization');
const { createRestaurantIdentity } = require('../lib/restaurantIdentity');
const {
  analyzeBackfillDataset,
  assessVisitData,
  createIdentityHmac,
  isResolvedRestaurant,
  normalizeVisitDate,
  summarizeRestaurantAudience,
} = require('../lib/restaurantDataFoundation');

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('session-scoped restaurant names stay unresolved while verified venue evidence resolves', () => {
  const nameOnly = createRestaurantIdentity(
    { printedName: 'Foundation Cafe', consensusStatus: 'user-confirmed', source: 'manual-entry' },
    '',
    'session-name-only',
    { userConfirmed: true },
  );
  assert.equal(nameOnly.identityBasis, 'name_only_session');
  assert.equal(nameOnly.venueResolutionStatus, 'unresolved');
  assert.equal(isResolvedRestaurant(nameOnly), false);

  const verified = createRestaurantIdentity({
    printedName: 'Foundation Cafe',
    address: '1 Foundation Street',
    consensusStatus: 'verified',
    fieldVerification: { printedName: 'verified', address: 'verified' },
  }, '', '', { providerVerified: true });
  assert.equal(verified.identityBasis, 'name_address');
  assert.equal(verified.venueResolutionStatus, 'resolved');
  assert.equal(isResolvedRestaurant(verified), true);
});

test('visit quality makes missing HMAC and unresolved venues explicit', () => {
  const result = assessVisitData({
    restaurant: {
      id: 'rest_aaaaaaaaaaaaaaaaaaaaaaaa',
      identityBasis: 'name_only_session',
      venueResolutionStatus: 'unresolved',
    },
    phoneHmac: '',
    occurredAt: 1_700_000_000_000,
    visitDate: '2026-08-30',
  });
  assert.equal(result.dataQualityStatus, 'blocked');
  assert.deepEqual(result.dataQualityIssues, ['missing_phone_hmac', 'unresolved_restaurant']);
  assert.equal(normalizeVisitDate('2026-02-31'), '');
});

test('audience summary deduplicates phones and excludes deleted or weak records without returning identifiers', () => {
  const restaurant = {
    id: 'rest_aaaaaaaaaaaaaaaaaaaaaaaa',
    identityBasis: 'name_address',
    venueResolutionStatus: 'resolved',
  };
  const visits = [
    { restaurantId: restaurant.id, sessionId: 's1', occurredAt: 2000, phoneHmac: 'h1', phoneAssurance: 'format_only', sourceState: 'active' },
    { restaurantId: restaurant.id, sessionId: 's2', occurredAt: 3000, phoneHmac: 'h1', phoneAssurance: 'format_only', sourceState: 'active' },
    { restaurantId: restaurant.id, sessionId: 's3', occurredAt: 4000, phoneHmac: 'h2', phoneAssurance: 'otp_verified', sourceState: 'active' },
    { restaurantId: restaurant.id, sessionId: 'deleted', occurredAt: 5000, phoneHmac: 'h3', phoneAssurance: 'format_only', sourceState: 'active' },
    { restaurantId: restaurant.id, sessionId: 'missing', occurredAt: 6000, phoneAssurance: 'none', sourceState: 'active' },
  ];
  const result = summarizeRestaurantAudience(visits, new Set(['deleted']), {
    restaurantId: restaurant.id,
    restaurant,
    from: 1000,
    to: 7000,
  });
  assert.equal(result.matchedVisits, 5);
  assert.equal(result.linkableVisits, 3);
  assert.equal(result.uniqueLinkablePhones, 2);
  assert.equal(result.excluded.deletedSource, 1);
  assert.equal(result.excluded.missingPhoneHmac, 1);
  assert.equal(result.rawPhoneNumbersReturned, false);
  assert.equal(JSON.stringify(result).includes('h1'), false);
});

test('backfill dry-run reports recoverable coverage and duplicate phone clusters without PII', () => {
  const secret = 'restaurant-foundation-test-secret-123456';
  const restaurant = {
    id: 'rest_bbbbbbbbbbbbbbbbbbbbbbbb',
    identityBasis: 'name_address',
    venueResolutionStatus: 'resolved',
  };
  const dataset = {
    users: [
      { id: 'u1', phone: '0501111111' },
      { id: 'u2', phone: '+972501111111' },
      { id: 'u3', phone: 'invalid' },
    ],
    restaurants: [restaurant],
    sessions: [{
      id: 's1',
      restaurant,
      hostPhone: '0501111111',
      members: [
        { id: 'm1', phone: '0501111111', isHost: true },
        { id: 'm2', phone: '0502222222' },
        { id: 'm3', phone: '' },
      ],
    }],
    visits: [{ sessionId: 's1', memberId: 'm1', phoneHmac: '' }],
  };
  const result = analyzeBackfillDataset(dataset, secret);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.writesPerformed, 0);
  assert.equal(result.users.uniqueValidPhones, 1);
  assert.equal(result.users.duplicatePhoneClusters, 1);
  assert.equal(result.visits.existingMissingPhoneHmacRecoverable, 1);
  assert.equal(result.visits.missingVisitRecordsRecoverable, 1);
  assert.equal(result.visits.unrecoverableMissingPhone, 1);
  assert.equal(JSON.stringify(result).includes('0501111111'), false);
});

test('database audience query returns aggregate-only linkable counts and respects source deletion', () => {
  const restaurant = {
    id: 'rest_cccccccccccccccccccccccc',
    printedName: 'Canonical Test Cafe',
    identityBasis: 'name_address',
    venueResolutionStatus: 'resolved',
    confidence: 0.82,
    trustScore: 0.82,
  };
  const member = { id: 'member_foundation', name: 'Member', phone: '0503333333', isHost: true };
  const firstSession = {
    id: 'sess_foundation_1',
    code: '54321',
    createdAt: 10_000,
    date: '2026-08-30',
    restaurant,
    members: [member],
  };
  const secondSession = {
    ...firstSession,
    id: 'sess_foundation_2',
    code: '54322',
    createdAt: 20_000,
  };
  db.createSessionIfAbsent(firstSession, { restaurantVisitMembers: [member] });
  db.createSessionIfAbsent(secondSession, { restaurantVisitMembers: [member] });

  const beforeDeletion = db.queryRestaurantAudience(restaurant.id, 1, 30_000);
  assert.equal(beforeDeletion.linkableVisits, 2);
  assert.equal(beforeDeletion.uniqueLinkablePhones, 1);
  assert.equal(JSON.stringify(beforeDeletion).includes('0503333333'), false);
  assert.equal(JSON.stringify(beforeDeletion).includes(createIdentityHmac(process.env.EASYSPLIT_IDENTITY_HMAC_SECRET, '0503333333')), false);

  db.deleteSession(firstSession.id);
  const afterDeletion = db.queryRestaurantAudience(restaurant.id, 1, 30_000);
  assert.equal(afterDeletion.linkableVisits, 1);
  assert.equal(afterDeletion.excluded.deletedSource, 1);
});

test('restaurant data administration requires an explicit custom claim', () => {
  assert.equal(isRestaurantDataAdmin(null), false);
  assert.equal(isRestaurantDataAdmin({ uid: 'ordinary-user' }), false);
  assert.equal(isRestaurantDataAdmin({ uid: 'admin-user', restaurantDataAdmin: true }), true);
  assert.equal(isRestaurantDataAdmin({ uid: 'admin-user', admin: true }), true);
});
