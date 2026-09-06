const test = require('node:test');
const assert = require('node:assert/strict');
const { sameRestaurantVenue, resolveRestaurantAliases } = require('../lib/restaurantResolution');

function venue(id, printedName, overrides = {}) {
  return { id, printedName, address: 'Herzl 12 Tel Aviv', phone: '0501234567',
    trustScore: 0.98, venueResolutionStatus: 'resolved',
    fieldVerification: { printedName: 'verified', address: 'verified', phone: 'verified' }, ...overrides };
}

test('verified address and phone unify an OCR spelling variant without mutating evidence', () => {
  const records = [venue('a', 'Cafe Northern'), venue('b', 'Cafe Northem')];
  const before = JSON.stringify(records);
  assert.equal(sameRestaurantVenue(...records), true);
  assert.deepEqual(resolveRestaurantAliases(records, 'b').restaurantIds, ['a', 'b']);
  assert.equal(JSON.stringify(records), before);
});

test('similar names cannot erase branch numbers, conflicting addresses, or phone conflicts', () => {
  assert.equal(sameRestaurantVenue(venue('a', 'Cafe North 1'), venue('b', 'Cafe North 2')), false);
  assert.equal(sameRestaurantVenue(venue('a', 'Cafe Northern'), venue('b', 'Cafe Northem', { address: 'Herzl 13 Tel Aviv' })), false);
  assert.equal(sameRestaurantVenue(venue('a', 'Cafe Northern'), venue('b', 'Cafe Northem', { phone: '0507654321' })), false);
});

test('name similarity and unverified OCR fields never automatically unify venues', () => {
  const a = venue('a', 'Cafe Northern');
  assert.equal(sameRestaurantVenue(a, venue('b', 'Cafe Northem', { trustScore: 0.35 })), false);
  assert.equal(sameRestaurantVenue(a, venue('b', 'Cafe Northem', { trustScore: undefined })), false);
  assert.equal(sameRestaurantVenue(a, venue('b', 'Cafe Northem', { fieldTrust: { printedName: 0.35 } })), false);
  assert.equal(sameRestaurantVenue(a, venue('b', 'Cafe Northem', { phone: '', businessId: '' })), false);
  assert.equal(sameRestaurantVenue(a, venue('b', 'Cafe Northem', { fieldVerification: { printedName: 'verified', address: 'conflicting', phone: 'verified' }, fieldTrust: { address: 0.98 } })), false);
});

test('missing evidence cannot bridge two conflicting venues', () => {
  const records = [venue('a', 'Cafe Northern'), venue('b', 'Cafe Northern', { phone: '' }), venue('c', 'Cafe Northern', { phone: '0507654321' })];
  for (const record of records) {
    const result = resolveRestaurantAliases(records, record.id);
    assert.equal(result.resolution, 'review_required');
    assert.deepEqual(result.restaurantIds, [record.id]);
  }
});
