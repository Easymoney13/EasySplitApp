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
  return digits.length >= 5 && digits.length <= 15 ? digits : '';
}

function cleanBusinessPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  return digits.length >= 9 && digits.length <= 11 ? digits : '';
}

function createRestaurantIdentity(metadata = {}, fallbackName = '', fallbackKey = '') {
  const printedName = cleanText(metadata.printedName || metadata.name || fallbackName, 100);
  const normalizedName = normalizeIdentityText(printedName);
  const businessId = cleanBusinessId(metadata.businessId || metadata.taxId);
  const address = cleanText(metadata.address, 160);
  const normalizedAddress = normalizeIdentityText(address);
  const phone = cleanBusinessPhone(metadata.phone);

  let identityBasis = 'unresolved';
  let confidence = 0;
  let fingerprint = '';
  if (businessId) {
    identityBasis = 'business_id';
    confidence = 0.99;
    fingerprint = `business:${businessId}`;
  } else if (normalizedName && phone) {
    identityBasis = 'name_phone';
    confidence = 0.9;
    fingerprint = `name-phone:${normalizedName}:${phone}`;
  } else if (normalizedName && normalizedAddress) {
    identityBasis = 'name_address';
    confidence = 0.82;
    fingerprint = `name-address:${normalizedName}:${normalizedAddress}`;
  } else if (normalizedName && !['scanned receipt', 'receipt', 'bill session', 'חשבון'].includes(normalizedName)) {
    identityBasis = 'name_only';
    confidence = 0.58;
    fingerprint = `name:${normalizedName}`;
  } else if (fallbackKey) {
    identityBasis = 'session_unresolved';
    confidence = 0.15;
    fingerprint = `session:${fallbackKey}`;
  }

  const id = fingerprint
    ? `rest_${crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24)}`
    : '';
  return {
    id,
    printedName,
    normalizedName,
    businessId,
    address,
    phone,
    identityBasis,
    confidence,
    source: metadata.source || 'ocr',
  };
}

module.exports = {
  cleanBusinessId,
  cleanBusinessPhone,
  createRestaurantIdentity,
  normalizeIdentityText,
};
