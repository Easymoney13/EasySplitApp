const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCore,
  areRestaurantNamesSimilar,
  scoreCandidate,
  buildRestaurantCanonicalMap,
  canonicalizePhone,
} = require('../lib/canonicalEngine');

test('areRestaurantNamesSimilar detects OCR typos and casing variations', () => {
  // Test case 1: Cosmopolitan variation with OCR stutter
  assert.equal(areRestaurantNamesSimilar('COSMOPOLITAN', 'COsMoPoOL ITAN'), true);

  // Test case 2: Porter & Sons variations
  assert.equal(areRestaurantNamesSimilar('Porter & Sons', 'Porter  Sons'), true);
  assert.equal(areRestaurantNamesSimilar('Porter & Sons', 'Porter  sons'), true);
  assert.equal(areRestaurantNamesSimilar('Porter  Sons', 'Porter  sons'), true);

  // Distinct restaurants must NOT be matched
  assert.equal(areRestaurantNamesSimilar('Burger Palace', 'Burger Shop'), false);
  assert.equal(areRestaurantNamesSimilar('Tokyo Ramen', 'Manual Pizza'), false);
  assert.equal(areRestaurantNamesSimilar('אורכידאה', 'האופים'), false);
});

test('buildRestaurantCanonicalMap chooses the cleanest canonical name', () => {
  const nameOccurrences = [
    { name: 'COsMoPoOL ITAN', count: 3 },
    { name: 'COSMOPOLITAN', count: 8 },
    { name: 'Porter  Sons', count: 2 },
    { name: 'Porter  sons', count: 1 },
    { name: 'Porter & Sons', count: 5 },
    { name: 'Tokyo Ramen & Sushi Bar', count: 2 },
  ];

  const canonicalMap = buildRestaurantCanonicalMap(nameOccurrences);

  // Both Cosmopolitan variations map to COSMOPOLITAN
  assert.equal(canonicalMap.get('COsMoPoOL ITAN'), 'COSMOPOLITAN');
  assert.equal(canonicalMap.get('COSMOPOLITAN'), 'COSMOPOLITAN');

  // All Porter variations map to Porter & Sons
  assert.equal(canonicalMap.get('Porter  Sons'), 'Porter & Sons');
  assert.equal(canonicalMap.get('Porter  sons'), 'Porter & Sons');
  assert.equal(canonicalMap.get('Porter & Sons'), 'Porter & Sons');

  // Single restaurant maps to itself
  assert.equal(canonicalMap.get('Tokyo Ramen & Sushi Bar'), 'Tokyo Ramen & Sushi Bar');
});

test('canonicalizePhone normalizes Israeli phone numbers to 10-digit format', () => {
  assert.equal(canonicalizePhone('054-1234567'), '0541234567');
  assert.equal(canonicalizePhone('+972-54-1234567'), '0541234567');
  assert.equal(canonicalizePhone('972587616088'), '0587616088');
  assert.equal(canonicalizePhone('587616088'), '0587616088');
  assert.equal(canonicalizePhone('058 761 6088'), '0587616088');

  // Invalid / non-mobile formats return empty string
  assert.equal(canonicalizePhone('830344'), '');
  assert.equal(canonicalizePhone('0584661'), '');
  assert.equal(canonicalizePhone(''), '');
  assert.equal(canonicalizePhone(null), '');
});
