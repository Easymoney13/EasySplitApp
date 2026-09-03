const crypto = require('crypto');

/**
 * EasySplit - Restaurant & Phone Canonicalization Engine
 * 
 * Automatically detects OCR typos, variations, and inconsistent casings
 * across restaurant names (e.g. 'COSMOPOLITAN' vs 'COsMoPoOL ITAN',
 * 'Porter & Sons' vs 'Porter  Sons' vs 'Porter  sons') and canonicalizes
 * them into their cleanest, standard form.
 * 
 * Also canonicalizes Israeli phone numbers to clean 10-digit format (05XXXXXXXX)
 * and cross-links verified user profiles with session member records.
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

/**
 * Executes a full database canonicalization on Firestore.
 * Updates sessions, groups, and restaurant metadata in place.
 */
async function refactorDatabase(firestore, { dryRun = false } = {}) {
  const [sessionsSnap, groupsSnap, usersSnap, restaurantsSnap] = await Promise.all([
    firestore.collection('sessions').get(),
    firestore.collection('groups').get(),
    firestore.collection('users').get(),
    firestore.collection('restaurants').get(),
  ]);

  // 1. Build phone lookup by UID and by clean username
  const phoneByUid = new Map();
  const phoneByUsername = new Map();

  usersSnap.forEach((doc) => {
    const data = doc.data();
    const cleanPhone = canonicalizePhone(data.phone || '');
    if (cleanPhone) {
      phoneByUid.set(doc.id, cleanPhone);
      if (data.username && typeof data.username === 'string') {
        phoneByUsername.set(data.username.trim().toLowerCase(), cleanPhone);
      }
    }
  });

  // Also collect verified phones from session hosts
  sessionsSnap.forEach((doc) => {
    const data = doc.data();
    const hostPhone = canonicalizePhone(data.hostPhone || '');
    if (hostPhone) {
      if (data.creatorUid) phoneByUid.set(data.creatorUid, hostPhone);
      if (data.hostName && typeof data.hostName === 'string') {
        phoneByUsername.set(data.hostName.trim().toLowerCase(), hostPhone);
      }
    }
  });

  // 2. Collect all restaurant name occurrences across sessions and groups
  const restaurantCounts = new Map();

  function recordName(name) {
    if (!name || typeof name !== 'string') return;
    const clean = name.trim();
    if (clean) restaurantCounts.set(clean, (restaurantCounts.get(clean) || 0) + 1);
  }

  sessionsSnap.forEach((doc) => {
    const data = doc.data();
    recordName(data.restaurant?.printedName || data.restaurant?.name || data.restaurantName || data.storeName);
  });

  groupsSnap.forEach((doc) => {
    const data = doc.data();
    (data.bills || []).forEach((bill) => {
      recordName(bill.restaurant?.printedName || bill.restaurant?.name || bill.restaurantName || bill.storeName);
    });
  });

  restaurantsSnap.forEach((doc) => {
    const data = doc.data();
    recordName(data.name || data.printedName);
  });

  // 3. Build canonical mapping for all restaurant names
  const canonicalMap = buildRestaurantCanonicalMap(restaurantCounts);

  // 4. Determine needed updates
  const sessionUpdates = [];
  const groupUpdates = [];
  const restaurantUpdates = [];

  sessionsSnap.forEach((doc) => {
    const data = doc.data();
    let changed = false;
    const patch = {};

    // Check restaurant name
    const currentRestName = data.restaurant?.printedName || data.restaurant?.name || data.restaurantName || data.storeName || '';
    const canonicalRestName = canonicalMap.get(currentRestName.trim()) || currentRestName.trim();

    if (canonicalRestName && canonicalRestName !== currentRestName) {
      patch.storeName = canonicalRestName;
      patch.restaurantName = canonicalRestName;
      if (data.restaurant && typeof data.restaurant === 'object') {
        patch.restaurant = {
          ...data.restaurant,
          name: canonicalRestName,
          printedName: canonicalRestName,
          normalizedName: normalizeCore(canonicalRestName),
        };
      }
      changed = true;
    }

    // Check host phone
    const cleanHostPhone = canonicalizePhone(data.hostPhone || '');
    if (cleanHostPhone && cleanHostPhone !== data.hostPhone) {
      patch.hostPhone = cleanHostPhone;
      changed = true;
    }

    // Check members phones
    if (Array.isArray(data.members)) {
      let membersChanged = false;
      const updatedMembers = data.members.map((member) => {
        let phone = canonicalizePhone(member.phone || '');
        if (!phone) {
          // Attempt cross-link from UID or username
          const uid = member.userId || member.uid;
          if (uid && phoneByUid.has(uid)) phone = phoneByUid.get(uid);
          else if (member.name && phoneByUsername.has(member.name.trim().toLowerCase())) {
            phone = phoneByUsername.get(member.name.trim().toLowerCase());
          }
        }
        if (phone && phone !== member.phone) {
          membersChanged = true;
          return { ...member, phone };
        }
        return member;
      });

      if (membersChanged) {
        patch.members = updatedMembers;
        changed = true;
      }
    }

    if (changed) {
      sessionUpdates.push({ id: doc.id, patch, originalName: currentRestName, newName: canonicalRestName });
    }
  });

  groupsSnap.forEach((doc) => {
    const data = doc.data();
    let changed = false;
    const patch = {};

    // Check bills in group
    if (Array.isArray(data.bills)) {
      let billsChanged = false;
      const updatedBills = data.bills.map((bill) => {
        const currentName = bill.restaurant?.printedName || bill.restaurant?.name || bill.restaurantName || bill.storeName || '';
        const canonicalName = canonicalMap.get(currentName.trim()) || currentName.trim();
        if (canonicalName && canonicalName !== currentName) {
          billsChanged = true;
          return {
            ...bill,
            storeName: canonicalName,
            restaurantName: canonicalName,
            ...(bill.restaurant && typeof bill.restaurant === 'object'
              ? {
                  restaurant: {
                    ...bill.restaurant,
                    name: canonicalName,
                    printedName: canonicalName,
                    normalizedName: normalizeCore(canonicalName),
                  },
                }
              : {}),
          };
        }
        return bill;
      });

      if (billsChanged) {
        patch.bills = updatedBills;
        changed = true;
      }
    }

    // Check group members phones
    if (Array.isArray(data.members)) {
      let membersChanged = false;
      const updatedMembers = data.members.map((member) => {
        let phone = canonicalizePhone(member.phone || '');
        if (!phone) {
          const uid = member.userId || member.uid;
          if (uid && phoneByUid.has(uid)) phone = phoneByUid.get(uid);
          else if (member.name && phoneByUsername.has(member.name.trim().toLowerCase())) {
            phone = phoneByUsername.get(member.name.trim().toLowerCase());
          }
        }
        if (phone && phone !== member.phone) {
          membersChanged = true;
          return { ...member, phone };
        }
        return member;
      });

      if (membersChanged) {
        patch.members = updatedMembers;
        changed = true;
      }
    }

    if (changed) {
      groupUpdates.push({ id: doc.id, patch });
    }
  });

  restaurantsSnap.forEach((doc) => {
    const data = doc.data();
    const currentName = data.name || data.printedName || '';
    const canonicalName = canonicalMap.get(currentName.trim()) || currentName.trim();
    if (canonicalName && canonicalName !== currentName) {
      restaurantUpdates.push({
        id: doc.id,
        patch: {
          name: canonicalName,
          printedName: canonicalName,
          normalizedName: normalizeCore(canonicalName),
        },
        originalName: currentName,
        newName: canonicalName,
      });
    }
  });

  // 5. Apply batch writes if not dryRun
  if (!dryRun) {
    let batch = firestore.batch();
    let opCount = 0;

    async function commitBatchIfNeeded() {
      if (opCount >= 400) {
        await batch.commit();
        batch = firestore.batch();
        opCount = 0;
      }
    }

    for (const update of sessionUpdates) {
      batch.update(firestore.collection('sessions').doc(update.id), update.patch);
      opCount++;
      await commitBatchIfNeeded();
    }

    for (const update of groupUpdates) {
      batch.update(firestore.collection('groups').doc(update.id), update.patch);
      opCount++;
      await commitBatchIfNeeded();
    }

    for (const update of restaurantUpdates) {
      batch.update(firestore.collection('restaurants').doc(update.id), update.patch);
      opCount++;
      await commitBatchIfNeeded();
    }

    if (opCount > 0) {
      await batch.commit();
    }
  }

  return {
    dryRun,
    canonicalMap: Object.fromEntries(canonicalMap),
    sessionUpdatesCount: sessionUpdates.length,
    groupUpdatesCount: groupUpdates.length,
    restaurantUpdatesCount: restaurantUpdates.length,
    sessionUpdates,
    groupUpdates,
    restaurantUpdates,
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
