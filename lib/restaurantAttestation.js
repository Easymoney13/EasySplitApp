const crypto = require('crypto');
const { normalizeScanId } = require('./ocrControl');

function restaurantAttestationSecret() {
  return process.env.EASYSPLIT_RESTAURANT_ATTESTATION_SECRET
    || process.env.EASYSPLIT_INVITE_HMAC_SECRET
    || process.env.EASYSPLIT_IDENTITY_HMAC_SECRET
    || process.env.EASYSPLIT_ANALYTICS_HASH_SALT
    || '';
}

function recoveryTokenHash(recoveryToken = '') {
  const clean = String(recoveryToken || '').trim();
  return clean ? crypto.createHash('sha256').update(clean).digest('hex') : '';
}

function restaurantIdentityEvidence(restaurant, scanId = '', recoveryToken = '') {
  return {
    id: String(restaurant?.id || ''),
    merchantId: String(restaurant?.merchantId || ''),
    printedName: String(restaurant?.printedName || ''),
    normalizedName: String(restaurant?.normalizedName || ''),
    businessId: String(restaurant?.businessId || ''),
    address: String(restaurant?.address || ''),
    phone: String(restaurant?.phone || ''),
    identityBasis: String(restaurant?.identityBasis || ''),
    confidence: Number(restaurant?.confidence || 0),
    trustScore: Number(restaurant?.trustScore || 0),
    consensusStatus: String(restaurant?.consensusStatus || ''),
    source: String(restaurant?.source || ''),
    fieldVerification: restaurant?.fieldVerification && typeof restaurant.fieldVerification === 'object'
      ? restaurant.fieldVerification
      : {},
    attestedScanId: normalizeScanId(scanId || restaurant?.identityEvidence?.attestedScanId || ''),
    attestedRecoveryHash: recoveryTokenHash(recoveryToken)
      || String(restaurant?.identityEvidence?.attestedRecoveryHash || restaurant?.attestedRecoveryHash || ''),
  };
}

function restaurantAttestationPayload(evidence) {
  return JSON.stringify(evidence);
}

function attestRestaurantIdentity(restaurant, scanId = '', recoveryToken = '') {
  const secret = restaurantAttestationSecret();
  const normalizedScanId = normalizeScanId(scanId);
  const normalizedRecoveryHash = recoveryTokenHash(recoveryToken);
  // A restaurant proof is useful only when it is bound to the exact scan and
  // the unguessable recovery capability that created the draft. Otherwise an
  // old signed restaurant block could be copied into an unrelated bill.
  if (!secret || !restaurant?.id || !normalizedScanId || !normalizedRecoveryHash) return restaurant;
  const identityEvidence = restaurantIdentityEvidence(restaurant, normalizedScanId, recoveryToken);
  return {
    ...restaurant,
    identityEvidence,
    identityAttestation: crypto
      .createHmac('sha256', secret)
      .update(restaurantAttestationPayload(identityEvidence))
      .digest('base64url'),
  };
}

function verifySignedEvidence(restaurant, expectedScanId, expectedRecoveryHash) {
  const secret = restaurantAttestationSecret();
  const supplied = typeof restaurant?.identityAttestation === 'string' ? restaurant.identityAttestation : '';
  const evidence = restaurant?.identityEvidence && typeof restaurant.identityEvidence === 'object'
    ? restaurantIdentityEvidence(restaurant.identityEvidence, restaurant.identityEvidence.attestedScanId)
    : null;
  if (!secret || !supplied || !evidence?.id || !expectedScanId || !expectedRecoveryHash) return false;
  if (evidence.attestedScanId !== expectedScanId) return false;
  if (evidence.attestedRecoveryHash !== expectedRecoveryHash) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(restaurantAttestationPayload(evidence))
    .digest('base64url');
  const actualBuffer = Buffer.from(supplied, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function verifyRestaurantIdentityAttestation(restaurant, scanId = '', recoveryToken = '') {
  return verifySignedEvidence(
    restaurant,
    normalizeScanId(scanId),
    recoveryTokenHash(recoveryToken),
  );
}

function verifyStoredRestaurantIdentityAttestation(restaurant, scanId = '') {
  const evidenceRecoveryHash = String(restaurant?.identityEvidence?.attestedRecoveryHash || '');
  return verifySignedEvidence(restaurant, normalizeScanId(scanId), evidenceRecoveryHash);
}

function restaurantProofId(restaurant) {
  const evidence = restaurant?.identityEvidence;
  if (!evidence?.attestedScanId || !evidence?.attestedRecoveryHash) return '';
  return crypto
    .createHash('sha256')
    .update(`restaurant-proof-v1:${evidence.attestedScanId}:${evidence.attestedRecoveryHash}`)
    .digest('hex');
}

module.exports = {
  attestRestaurantIdentity,
  restaurantProofId,
  restaurantIdentityEvidence,
  verifyRestaurantIdentityAttestation,
  verifyStoredRestaurantIdentityAttestation,
};
