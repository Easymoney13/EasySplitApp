const crypto = require('crypto');

function cleanText(value, maxLength = 160) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function normalizeIdentityText(value) {
  return cleanText(value)
    .toLocaleLowerCase('he-IL')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanBusinessId(value) {
  const digits = String(value || '').replace(/\D/g, '');
  // EasySplit's launch market is Israel. Israeli company/dealer identifiers
  // are nine digits; accepting arbitrary short numbers makes OCR poisoning and
  // accidental cross-restaurant merges far too easy.
  if (!/^\d{9}$/.test(digits)) return '';
  const checksum = [...digits].reduce((sum, digit, index) => {
    const product = Number(digit) * (index % 2 === 0 ? 1 : 2);
    return sum + (product > 9 ? product - 9 : product);
  }, 0);
  return checksum % 10 === 0 ? digits : '';
}

function cleanBusinessPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  return digits.length >= 9 && digits.length <= 11 ? digits : '';
}

function createRestaurantIdentity(metadata = {}, fallbackName = '', fallbackKey = '', options = {}) {
  const printedName = cleanText(metadata.printedName || metadata.name || fallbackName, 100);
  const normalizedName = normalizeIdentityText(printedName);
  // Stable identity fields must come from server-attested OCR evidence when
  // supplied. Display corrections remain useful, but cannot inherit the
  // evidence's trust merely by carrying its signature.
  const identityEvidence = options.attestedEvidence && typeof options.attestedEvidence === 'object'
    ? options.attestedEvidence
    : metadata;
  const hasAttestedEvidence = options.attestedEvidence && typeof options.attestedEvidence === 'object';
  const evidencePrintedName = cleanText(identityEvidence.printedName || identityEvidence.name, 100);
  const evidenceNormalizedName = normalizeIdentityText(identityEvidence.normalizedName || evidencePrintedName);
  const genericReceiptNames = new Set(['scanned receipt', 'receipt', 'bill session', 'חשבון']);
  const hasVenueName = Boolean(evidenceNormalizedName) && !genericReceiptNames.has(evidenceNormalizedName);
  const businessId = cleanBusinessId(identityEvidence.businessId);
  const address = cleanText(metadata.address, 160);
  const evidenceAddress = cleanText(hasAttestedEvidence ? identityEvidence.address : (identityEvidence.address || address), 160);
  const normalizedAddress = normalizeIdentityText(evidenceAddress);
  const phone = cleanBusinessPhone(metadata.phone);
  const evidencePhone = cleanBusinessPhone(hasAttestedEvidence ? identityEvidence.phone : (identityEvidence.phone || phone));
  const fieldVerification = identityEvidence.fieldVerification && typeof identityEvidence.fieldVerification === 'object'
    ? identityEvidence.fieldVerification
    : {};
  const hasPerFieldVerification = Object.keys(fieldVerification).length > 0;
  const legacyAllFieldsVerified = !hasPerFieldVerification && identityEvidence.consensusStatus === 'verified';
  const nameVerified = fieldVerification.printedName === 'verified' || legacyAllFieldsVerified;
  const addressVerified = fieldVerification.address === 'verified' || legacyAllFieldsVerified;
  const phoneVerified = fieldVerification.phone === 'verified' || legacyAllFieldsVerified;
  const suppliedTrust = Number(identityEvidence.trustScore);
  const trustScore = options.allowSuppliedTrust && Number.isFinite(suppliedTrust)
    ? Math.max(0, Math.min(1, suppliedTrust))
    : options.providerVerified && metadata.consensusStatus === 'verified'
      ? 0.98
      : options.providerVerified
        ? 0.82
        : options.userConfirmed
          ? 0.68
          : 0.35;

  let identityBasis = 'unresolved';
  let confidence = 0;
  let fingerprint = '';
  const crossSessionIdentityTrusted = trustScore >= 0.8;
  const businessIdVerified = fieldVerification.businessId === 'verified' || legacyAllFieldsVerified;
  const businessIdTrusted = crossSessionIdentityTrusted
    && businessIdVerified
    && Boolean(options.providerVerified || options.attested || options.allowSuppliedTrust);
  if (businessId && businessIdTrusted) {
    const merchantFingerprint = `business:${businessId}`;
    if (normalizedAddress && addressVerified && hasVenueName && nameVerified) {
      identityBasis = 'business_id_address';
      confidence = Math.min(0.98, trustScore);
      // One legal entity and one street can still contain distinct venues
      // (hotel restaurants, virtual kitchens). A verified printed name is a
      // branch discriminator; merchantId remains the legal-entity roll-up.
      fingerprint = `${merchantFingerprint}:address:${normalizedAddress}:name:${nameVerified ? evidenceNormalizedName : 'unresolved'}`;
    } else if (fallbackKey) {
      // One legal entity may operate multiple venues. Without branch evidence
      // the visit remains session-scoped instead of collapsing every branch.
      identityBasis = 'business_id_unresolved_venue';
      confidence = Math.min(0.75, trustScore);
      fingerprint = `${merchantFingerprint}:unresolved:${fallbackKey}`;
    }
  } else if (hasVenueName && evidencePhone && nameVerified && phoneVerified && crossSessionIdentityTrusted) {
    identityBasis = 'name_phone';
    confidence = Math.min(0.9, trustScore);
    fingerprint = `name-phone:${evidenceNormalizedName}:${evidencePhone}`;
  } else if (hasVenueName && normalizedAddress && nameVerified && addressVerified && crossSessionIdentityTrusted) {
    identityBasis = 'name_address';
    confidence = Math.min(0.82, trustScore);
    fingerprint = `name-address:${evidenceNormalizedName}:${normalizedAddress}`;
  } else if (normalizedName && fallbackKey && !genericReceiptNames.has(normalizedName)) {
    identityBasis = 'name_only_session';
    confidence = Math.min(0.5, trustScore);
    fingerprint = `name-session:${normalizedName}:${fallbackKey}`;
  } else if (fallbackKey) {
    identityBasis = 'session_unresolved';
    confidence = 0.15;
    fingerprint = `session:${fallbackKey}`;
  }

  const id = fingerprint
    ? `rest_${crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`
    : '';
  const merchantId = businessId && businessIdTrusted
    ? `merchant_${crypto.createHash('sha256').update(`business:${businessId}`).digest('hex').slice(0, 24)}`
    : '';
  const verifiedFieldTrust = Math.max(0.8, trustScore);
  const correctionTrust = options.userConfirmed ? 0.68 : 0.35;
  const fieldTrust = {
    printedName: nameVerified && normalizeIdentityText(printedName) === evidenceNormalizedName ? verifiedFieldTrust : correctionTrust,
    address: addressVerified && normalizeIdentityText(address) === normalizedAddress ? verifiedFieldTrust : correctionTrust,
    phone: phoneVerified && phone === evidencePhone ? verifiedFieldTrust : correctionTrust,
    businessId: businessIdTrusted ? verifiedFieldTrust : 0,
  };
  return {
    id,
    merchantId,
    printedName,
    normalizedName,
    businessId: businessId && businessIdTrusted ? businessId : '',
    businessIdCandidate: businessId && !businessIdTrusted ? businessId : '',
    address,
    phone,
    identityBasis,
    confidence,
    trustScore,
    candidateNameKey: normalizedName || '',
    source: identityEvidence.source || metadata.source || 'ocr',
    consensusStatus: identityEvidence.consensusStatus || metadata.consensusStatus || 'unverified',
    fieldVerification,
    fieldTrust,
    venueResolutionStatus: identityBasis === 'business_id_unresolved_venue' ? 'unresolved' : (id ? 'resolved' : 'unresolved'),
    ...(options.attested && metadata.identityEvidence ? { identityEvidence: metadata.identityEvidence } : {}),
    ...(options.attested && metadata.identityAttestation ? { identityAttestation: metadata.identityAttestation } : {}),
  };
}

module.exports = {
  cleanBusinessId,
  cleanBusinessPhone,
  createRestaurantIdentity,
  normalizeIdentityText,
};
