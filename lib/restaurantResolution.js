'use strict';

const { areRestaurantNamesSimilar, scoreCandidate } = require('./canonicalEngine');
const { normalizeIdentityText, cleanBusinessId, cleanBusinessPhone } = require('./restaurantIdentity');

function verifiedValue(record, field, normalize) {
  if (record.venueResolutionStatus !== 'resolved' || !(Number(record.trustScore) >= 0.8)) return '';
  if (record.fieldTrust?.[field] != null && !(Number(record.fieldTrust[field]) >= 0.8)) return '';
  const verification = record.fieldVerification || {};
  const verified = verification[field] === 'verified'
    || (!verification[field] && Number(record.fieldTrust?.[field]) >= 0.8)
    || (!Object.keys(verification).length && record.consensusStatus === 'verified');
  return verified ? normalize(record[field] || '') : '';
}

// Name similarity proposes a match; independently verified venue evidence decides it.
// Legal entities and shared phone numbers alone cannot distinguish branches.
function sameRestaurantVenue(left, right) {
  const nameA = verifiedValue(left, 'printedName', normalizeIdentityText);
  const nameB = verifiedValue(right, 'printedName', normalizeIdentityText);
  if (!nameA || !nameB || nameA.length > 200 || nameB.length > 200) return false;
  const normalizers = { businessId: cleanBusinessId, address: normalizeIdentityText, phone: cleanBusinessPhone };
  const matches = {};
  for (const [field, normalize] of Object.entries(normalizers)) {
    const a = verifiedValue(left, field, normalize);
    const b = verifiedValue(right, field, normalize);
    if (a && b && a !== b) return false;
    matches[field] = Boolean(a && b && a === b);
  }
  if (!matches.address || !areRestaurantNamesSimilar(nameA, nameB)) return false;
  if (nameA === nameB) return matches.address;
  return matches.address && (matches.businessId || matches.phone);
}

function resolveRestaurantAliases(records, requestedId) {
  const byId = new Map(records.filter((record) => record?.id).map((record) => [record.id, record]));
  const requested = byId.get(requestedId);
  if (!requested) return null;
  // Explore the connected component, then reject ambiguous transitive matches.
  // A~B and B~C never suffice to conclude A~C.
  const component = [requested];
  const included = new Set([requestedId]);
  for (let index = 0; index < component.length; index += 1) {
    for (const candidate of byId.values()) {
      if (!included.has(candidate.id) && sameRestaurantVenue(component[index], candidate)) {
        if (component.length >= 100) return { canonicalId: requestedId, restaurantIds: [requestedId], resolution: 'review_required' };
        component.push(candidate);
        included.add(candidate.id);
      }
    }
  }
  const ambiguous = component.some((left, i) => component.slice(i + 1).some((right) => !sameRestaurantVenue(left, right)));
  const aliases = ambiguous ? [requested] : component;
  aliases.sort((a, b) => (Number(a.firstSeenAt) || 0) - (Number(b.firstSeenAt) || 0) || a.id.localeCompare(b.id));
  const display = [...aliases].sort((a, b) => Number(b.trustScore || 0) - Number(a.trustScore || 0)
    || scoreCandidate(b.printedName || '') - scoreCandidate(a.printedName || ''))[0];
  return {
    canonicalId: aliases[0].id,
    canonicalPrintedName: display.printedName || '',
    restaurantIds: aliases.map((record) => record.id),
    resolution: ambiguous ? 'review_required' : aliases.length > 1 ? 'verified_aliases' : 'single_record',
  };
}

module.exports = { sameRestaurantVenue, resolveRestaurantAliases };
