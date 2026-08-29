const REQUIRED_PRODUCTION_SECRETS = [
  'EASYSPLIT_IDENTITY_HMAC_SECRET',
  'EASYSPLIT_RESTAURANT_ATTESTATION_SECRET',
];

function assessProductionSecurityConfig(env = process.env) {
  const missingSecrets = REQUIRED_PRODUCTION_SECRETS.filter((key) => (
    !env[key] || String(env[key]).length < 24
  ));

  return {
    missingSecrets,
    restaurantDataProtectionReady: missingSecrets.length === 0,
  };
}

module.exports = {
  REQUIRED_PRODUCTION_SECRETS,
  assessProductionSecurityConfig,
};
