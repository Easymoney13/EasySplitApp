const crypto = require('crypto');
const { normalizeIsraeliPhone } = require('./validation');

const DATA_CONTRACT_VERSION = 1;
const MAX_AUDIENCE_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const STABLE_RESTAURANT_IDENTITY_BASES = new Set([
  'business_id_address',
  'name_phone',
  'name_address',
]);

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeVisitDate(value) {
  if (typeof value !== 'string') return '';
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  const normalized = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === normalized
    ? normalized
    : '';
}

function isResolvedRestaurant(restaurant) {
  return Boolean(
    restaurant?.id
    && restaurant?.venueResolutionStatus === 'resolved'
    && STABLE_RESTAURANT_IDENTITY_BASES.has(restaurant?.identityBasis),
  );
}

function createIdentityHmac(secret, normalizedPhone) {
  if (!secret || String(secret).length < 24 || !normalizedPhone) return '';
  return crypto
    .createHmac('sha256', String(secret))
    .update(`phone:${normalizedPhone}`)
    .digest('hex');
}

function phoneAssuranceFor(member, phoneHmac) {
  if (!phoneHmac) return 'none';
  return member?.phoneVerificationStatus === 'verified' || timestampMillis(member?.phoneVerifiedAt) > 0
    ? 'otp_verified'
    : 'format_only';
}

function assessVisitData({ restaurant, phoneHmac, occurredAt, visitDate }) {
  const issues = [];
  const resolvedRestaurant = isResolvedRestaurant(restaurant);
  if (!phoneHmac) issues.push('missing_phone_hmac');
  if (!resolvedRestaurant) issues.push('unresolved_restaurant');
  if (!timestampMillis(occurredAt)) issues.push('missing_occurred_at');
  if (!normalizeVisitDate(visitDate)) issues.push('missing_visit_date');
  return {
    dataContractVersion: DATA_CONTRACT_VERSION,
    restaurantResolutionStatus: resolvedRestaurant ? 'resolved' : 'unresolved',
    dataQualityStatus: issues.length === 0
      ? 'complete'
      : issues.includes('missing_phone_hmac')
        ? 'blocked'
        : 'unresolved',
    dataQualityIssues: issues,
  };
}

function validateAudienceRange(from, to) {
  const fromMs = timestampMillis(from);
  const toMs = timestampMillis(to);
  if (!fromMs || !toMs || toMs <= fromMs) {
    const error = new Error('A valid audience date range is required');
    error.statusCode = 400;
    throw error;
  }
  if (toMs - fromMs > MAX_AUDIENCE_RANGE_MS) {
    const error = new Error('Audience previews are limited to 366 days');
    error.statusCode = 400;
    throw error;
  }
  return { fromMs, toMs };
}

function summarizeRestaurantAudience(visits, sourceDeletions, {
  restaurantId,
  restaurant,
  from,
  to,
  truncated = false,
} = {}) {
  const { fromMs, toMs } = validateAudienceRange(from, to);
  const deletedSources = sourceDeletions instanceof Set
    ? sourceDeletions
    : new Set((sourceDeletions || []).map((entry) => entry?.sessionId || entry?.id).filter(Boolean));
  const uniquePhones = new Set();
  const assurance = { otp_verified: 0, format_only: 0, none: 0 };
  const excluded = {
    outsideRange: 0,
    wrongRestaurant: 0,
    deletedSource: 0,
    inactiveSource: 0,
    unresolvedRestaurant: 0,
    missingPhoneHmac: 0,
    invalidOccurredAt: 0,
  };
  let matchedVisits = 0;
  let linkableVisits = 0;

  for (const visit of visits || []) {
    if (visit?.restaurantId !== restaurantId) {
      excluded.wrongRestaurant += 1;
      continue;
    }
    const occurredAt = timestampMillis(visit?.occurredAt || visit?.joinedAt || visit?.lastSeenAt);
    if (!occurredAt) {
      excluded.invalidOccurredAt += 1;
      continue;
    }
    if (occurredAt < fromMs || occurredAt >= toMs) {
      excluded.outsideRange += 1;
      continue;
    }
    matchedVisits += 1;
    if (deletedSources.has(visit?.sessionId)) {
      excluded.deletedSource += 1;
      continue;
    }
    if (visit?.sourceState && visit.sourceState !== 'active') {
      excluded.inactiveSource += 1;
      continue;
    }
    const resolved = restaurant
      ? isResolvedRestaurant(restaurant)
      : visit?.restaurantResolutionStatus === 'resolved'
        || STABLE_RESTAURANT_IDENTITY_BASES.has(visit?.restaurantIdentityBasis);
    if (!resolved) {
      excluded.unresolvedRestaurant += 1;
      continue;
    }
    if (!visit?.phoneHmac) {
      excluded.missingPhoneHmac += 1;
      continue;
    }
    linkableVisits += 1;
    uniquePhones.add(visit.phoneHmac);
    const level = Object.prototype.hasOwnProperty.call(assurance, visit.phoneAssurance)
      ? visit.phoneAssurance
      : 'none';
    assurance[level] += 1;
  }

  return {
    restaurantId,
    from: fromMs,
    to: toMs,
    matchedVisits,
    linkableVisits,
    uniqueLinkablePhones: uniquePhones.size,
    assurance,
    excluded,
    truncated: Boolean(truncated),
    rawPhoneNumbersReturned: false,
  };
}

function analyzeBackfillDataset({ users = [], sessions = [], restaurants = [], visits = [] } = {}, secret = '') {
  const restaurantById = new Map(restaurants.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  const visitByKey = new Map(visits.map((visit) => [`${visit?.sessionId || ''}:${visit?.memberId || ''}`, visit]));
  const phoneClusters = new Map();
  let validUserPhones = 0;
  for (const user of users) {
    const normalizedPhone = normalizeIsraeliPhone(user?.phone || '');
    if (!normalizedPhone) continue;
    validUserPhones += 1;
    phoneClusters.set(normalizedPhone, (phoneClusters.get(normalizedPhone) || 0) + 1);
  }

  const result = {
    mode: 'dry-run',
    writesPerformed: 0,
    source: {
      users: users.length,
      sessions: sessions.length,
      restaurants: restaurants.length,
      visits: visits.length,
    },
    users: {
      validPhoneDocuments: validUserPhones,
      uniqueValidPhones: phoneClusters.size,
      duplicatePhoneClusters: [...phoneClusters.values()].filter((count) => count > 1).length,
      invalidOrMissingPhoneDocuments: users.length - validUserPhones,
    },
    visits: {
      missingVisitRecordsRecoverable: 0,
      existingMissingPhoneHmacRecoverable: 0,
      unrecoverableMissingPhone: 0,
      resolvedRestaurant: 0,
      unresolvedRestaurant: 0,
    },
    configuration: {
      identityHmacReady: String(secret || '').length >= 24,
    },
  };

  for (const session of sessions) {
    const restaurant = restaurantById.get(session?.restaurant?.id) || session?.restaurant;
    const resolved = isResolvedRestaurant(restaurant);
    for (const member of Array.isArray(session?.members) ? session.members : []) {
      if (!member?.id || member.active === false || !session?.restaurant?.id) continue;
      if (resolved) result.visits.resolvedRestaurant += 1;
      else result.visits.unresolvedRestaurant += 1;
      const phone = normalizeIsraeliPhone(member.phone || (member.isHost ? session.hostPhone || '' : ''));
      const existing = visitByKey.get(`${session.id}:${member.id}`);
      if (!existing && phone) {
        result.visits.missingVisitRecordsRecoverable += 1;
      } else if (existing && !existing.phoneHmac && phone) {
        result.visits.existingMissingPhoneHmacRecoverable += 1;
      } else if (!phone) {
        result.visits.unrecoverableMissingPhone += 1;
      }
    }
  }

  return result;
}

module.exports = {
  DATA_CONTRACT_VERSION,
  MAX_AUDIENCE_RANGE_MS,
  STABLE_RESTAURANT_IDENTITY_BASES,
  analyzeBackfillDataset,
  assessVisitData,
  createIdentityHmac,
  isResolvedRestaurant,
  normalizeVisitDate,
  phoneAssuranceFor,
  summarizeRestaurantAudience,
  timestampMillis,
  validateAudienceRange,
};
