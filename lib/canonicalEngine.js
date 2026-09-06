/**
 * EasySplit - Restaurant & Phone Canonicalization Engine
 * 
 * Automatically detects OCR typos, variations, and inconsistent casings
 * across restaurant names (e.g. 'COSMOPOLITAN' vs 'COsMoPoOL ITAN',
 * 'Porter & Sons' vs 'Porter  Sons' vs 'Porter  sons') and canonicalizes
 * them into their cleanest, standard form.
 * 
 * Also canonicalizes Israeli phone numbers to clean 10-digit format (05XXXXXXXX)
 * and links explicit account IDs only. Similar names are suggestions, not identity proof.
 */

function normalizeCore(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .normalize('NFKC')
    .replace(/[&]/g, ' ')
    .replace(/[^a-z0-9\u0590-\u05FF]+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

function areRestaurantNamesSimilar(nameA, nameB) {
  if (!nameA || !nameB) return false;
  if (nameA === nameB) return true;

  const normA = normalizeCore(nameA);
  const normB = normalizeCore(nameB);
  if (!normA || !normB) return false;
  // Numeric branch discriminators must survive fuzzy name matching.
  if (JSON.stringify(normA.match(/\d+/g) || []) !== JSON.stringify(normB.match(/\d+/g) || [])) return false;
  if (normA === normB) return true;

  // Compare without spaces for glued/spaced OCR typos (e.g. 'cosmopool itan' vs 'cosmopolitan')
  const squishA = normA.replace(/\s+/g, '');
  const squishB = normB.replace(/\s+/g, '');
  if (squishA === squishB) return true;

  const maxLen = Math.max(squishA.length, squishB.length);
  // Short words (under 4 chars) must match exactly to avoid false positives
  if (maxLen < 5) return false;

  const dist = levenshtein(squishA, squishB);
  // Allow 1 character typo for 5-7 chars, 2 character typos for 8+ chars
  const maxAllowedDist = maxLen >= 8 ? 2 : 1;
  return dist <= maxAllowedDist;
}

function scoreCandidate(name, occurrenceCount = 1) {
  let score = occurrenceCount * 10;

  // Heavily penalize erratic OCR mixed casing like 'COsMoPoOL ITAN'
  const hasErraticMixedCase = /[a-z][A-Z][a-z]|[A-Z][a-z][A-Z]/.test(name);
  if (hasErraticMixedCase) score -= 40;

  // Favor proper punctuation '&' over missing spaces or multi-spaces
  if (name.includes('&')) score += 15;
  if (/ {2,}/.test(name)) score -= 15;

  // Favor Title Case or consistent casing
  const words = name.split(/\s+/).filter(Boolean);
  const titleCasedWords = words.filter((w) => /^[A-Z\u0590-\u05FF]/.test(w)).length;
  score += titleCasedWords * 3;

  // Penalize trailing or leading punctuation noise
  if (/^[^a-z0-9\u0590-\u05FF]|[^a-z0-9\u0590-\u05FF]$/i.test(name)) score -= 5;

  return score;
}

function buildRestaurantCanonicalMap(nameOccurrences) {
  // nameOccurrences: Map<string, number> or Array<{ name: string, count: number }>
  const counts = new Map();
  if (nameOccurrences instanceof Map) {
    for (const [name, count] of nameOccurrences) counts.set(name.trim(), (counts.get(name.trim()) || 0) + count);
  } else if (Array.isArray(nameOccurrences)) {
    for (const item of nameOccurrences) {
      const name = typeof item === 'string' ? item.trim() : String(item?.name || '').trim();
      const count = typeof item === 'object' && Number.isFinite(item?.count) ? item.count : 1;
      if (name) counts.set(name, (counts.get(name) || 0) + count);
    }
  }

  const allNames = [...counts.keys()];
  const canonicalMap = new Map(); // originalName -> canonicalName
  const visited = new Set();

  for (let i = 0; i < allNames.length; i++) {
    const currentName = allNames[i];
    if (visited.has(currentName)) continue;

    const cluster = [currentName];
    visited.add(currentName);

    for (let j = i + 1; j < allNames.length; j++) {
      const otherName = allNames[j];
      if (visited.has(otherName)) continue;

      if (areRestaurantNamesSimilar(currentName, otherName)) {
        cluster.push(otherName);
        visited.add(otherName);
      }
    }

    // Pick the best candidate in this cluster
    let bestName = cluster[0];
    let bestScore = scoreCandidate(bestName, counts.get(bestName) || 1);

    for (let k = 1; k < cluster.length; k++) {
      const candidate = cluster[k];
      const score = scoreCandidate(candidate, counts.get(candidate) || 1);
      if (score > bestScore) {
        bestScore = score;
        bestName = candidate;
      }
    }

    // Normalize any multi-spaces in bestName
    bestName = bestName.replace(/\s+/g, ' ').trim();

    for (const member of cluster) {
      canonicalMap.set(member, bestName);
    }
  }

  return canonicalMap;
}

function canonicalizePhone(value) {
  if (typeof value !== 'string') return '';
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  if (digits.length === 9 && !digits.startsWith('0')) digits = `0${digits}`;
  return /^05\d{8}$/.test(digits) ? digits : '';
}

function explicitMemberUid(member) {
  const uid = member?.userId || member?.uid;
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && !uid.includes('/') ? uid : '';
}

function buildPhonePatch(data, phonesByUid) {
  const patch = {};
  const hostPhone = canonicalizePhone(data.hostPhone);
  if (hostPhone && hostPhone !== data.hostPhone) patch.hostPhone = hostPhone;
  if (Array.isArray(data.members)) {
    let changed = false;
    const members = data.members.map((member) => {
      if (!member || typeof member !== 'object') return member;
      const phone = canonicalizePhone(member.phone) || phonesByUid.get(explicitMemberUid(member));
      if (!phone || phone === member.phone) return member;
      changed = true;
      return { ...member, phone };
    });
    if (changed) patch.members = members;
  }
  return patch;
}

function snapshotRecords(snapshot) {
  const records = [];
  snapshot.forEach((doc) => records.push({ ...doc.data(), id: doc.id }));
  return records;
}

/**
 * Preview maintenance by default. Applying phone corrections is explicit and
 * transactional: derive every patch from the current room AND account records.
 * Receipt names/evidence, bills and restaurant identities are never rewritten by
 * fuzzy string similarity. Verified aliases are resolved by restaurantResolution.
 */
async function refactorDatabase(firestore, { dryRun = true } = {}) {
  if (!dryRun && typeof firestore.runTransaction !== 'function') {
    throw new Error('Canonical maintenance requires Firestore transactions');
  }
  const [sessionsSnap, groupsSnap, usersSnap, restaurantsSnap] = await Promise.all([
    firestore.collection('sessions').get(),
    firestore.collection('groups').get(),
    firestore.collection('users').get(),
    firestore.collection('restaurants').get(),
  ]);
  const sessions = snapshotRecords(sessionsSnap);
  const groups = snapshotRecords(groupsSnap);
  const users = snapshotRecords(usersSnap);
  const restaurants = snapshotRecords(restaurantsSnap);
  const phonesByUid = new Map(users.map((user) => [user.id, canonicalizePhone(user.phone)]));
  const restaurantCounts = new Map();
  function recordName(value) {
    const name = value?.restaurant?.printedName || value?.restaurant?.name
      || value?.restaurantName || value?.storeName || value?.printedName || value?.name;
    if (typeof name === 'string' && name.trim()) {
      restaurantCounts.set(name.trim(), (restaurantCounts.get(name.trim()) || 0) + 1);
    }
  }
  sessions.forEach(recordName);
  groups.forEach((group) => (group.bills || []).forEach(recordName));
  restaurants.forEach(recordName);

  async function updateRooms(collection, records) {
    const updates = [];
    for (const record of records) {
      if (record.status === 'deleting') continue;
      const candidatePatch = buildPhonePatch(record, phonesByUid);
      if (!Object.keys(candidatePatch).length) continue;
      if (dryRun) {
        updates.push({ id: record.id, patch: candidatePatch });
        continue;
      }
      const ref = firestore.collection(collection).doc(record.id);
      const update = await firestore.runTransaction(async (transaction) => {
        const currentSnapshot = await transaction.get(ref);
        if (!currentSnapshot.exists) return null;
        const current = currentSnapshot.data();
        if (current.status === 'deleting') return null;
        // Read all identity sources before writing, including on every retry.
        // No name lookup, no inferred UID and no phone from another room's host.
        const uids = [...new Set((Array.isArray(current.members) ? current.members : [])
          .filter((member) => !canonicalizePhone(member?.phone))
          .map(explicitMemberUid).filter(Boolean))];
        const userSnapshots = await Promise.all(uids.map((uid) => (
          transaction.get(firestore.collection('users').doc(uid))
        )));
        const currentPhones = new Map(userSnapshots
          .filter((snapshot) => snapshot.exists)
          .map((snapshot) => [snapshot.id, canonicalizePhone(snapshot.data().phone)]));
        const patch = buildPhonePatch(current, currentPhones);
        if (!Object.keys(patch).length) return null;
        transaction.update(ref, patch);
        return { id: record.id, patch };
      });
      if (update) updates.push(update);
    }
    return updates;
  }

  const sessionUpdates = await updateRooms('sessions', sessions);
  const groupUpdates = await updateRooms('groups', groups);
  return {
    dryRun,
    canonicalMap: Object.fromEntries(buildRestaurantCanonicalMap(restaurantCounts)),
    canonicalMapPurpose: 'review_only',
    sessionUpdatesCount: sessionUpdates.length,
    groupUpdatesCount: groupUpdates.length,
    restaurantUpdatesCount: 0,
    sessionUpdates,
    groupUpdates,
    restaurantUpdates: [],
  };
}

module.exports = {
  normalizeCore,
  areRestaurantNamesSimilar,
  scoreCandidate,
  buildRestaurantCanonicalMap,
  canonicalizePhone,
  refactorDatabase,
};
