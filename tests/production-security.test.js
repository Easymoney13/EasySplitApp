const test = require('node:test');
const assert = require('node:assert/strict');

const { assessProductionSecurityConfig } = require('../lib/productionSecurity');

test('missing production security secrets degrade restaurant telemetry without blocking startup', () => {
  const result = assessProductionSecurityConfig({ NODE_ENV: 'production' });

  assert.equal(result.restaurantDataProtectionReady, false);
  assert.deepEqual(result.missingSecrets, [
    'EASYSPLIT_IDENTITY_HMAC_SECRET',
    'EASYSPLIT_RESTAURANT_ATTESTATION_SECRET',
  ]);
});

test('dedicated production security secrets enable protected restaurant telemetry', () => {
  const result = assessProductionSecurityConfig({
    NODE_ENV: 'production',
    EASYSPLIT_IDENTITY_HMAC_SECRET: 'identity-secret-with-more-than-24-chars',
    EASYSPLIT_RESTAURANT_ATTESTATION_SECRET: 'attestation-secret-with-more-than-24-chars',
  });

  assert.equal(result.restaurantDataProtectionReady, true);
  assert.deepEqual(result.missingSecrets, []);
});
