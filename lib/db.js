const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createEntityId, createUniqueRoomCode } = require('./ids');
const { sanitizeUserSettings } = require('./validation');
const {
  GROUP_STATUS,
  BILL_STATUS,
  getGroupStatus,
  getBillStatus,
  assertGroupActive,
} = require('./groupLifecycle');

if (process.env.NODE_ENV === 'production' && process.env.BILLSPLIT_DB_PATH) {
  throw new Error('Refusing to start production with BILLSPLIT_DB_PATH: Firestore must remain the authoritative datastore.');
}

const DB_PATH = process.env.BILLSPLIT_DB_PATH
  ? path.resolve(process.env.BILLSPLIT_DB_PATH)
  : null;
const TMP_PATH = DB_PATH ? `${DB_PATH}.tmp` : null;

// Local JSON storage is available only to tests that opt in with an explicit
// temporary path. Every normal runtime, including local development, uses
// Firestore and can no longer fall back to a repository db.json file.
const isTesting = !!DB_PATH;
const SESSION_ADMISSION_TTL_MS = Math.max(
  60 * 60 * 1000,
  Math.min(7 * 24 * 60 * 60 * 1000, Number(process.env.EASYSPLIT_SESSION_ADMISSION_TTL_MS) || 24 * 60 * 60 * 1000),
);

function dateLikeMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  return Number(value || 0);
}

function sessionAdmissionActive(record, now = Date.now()) {
  const explicitExpiry = dateLikeMillis(record?.admissionExpiresAt);
  if (explicitExpiry) return explicitExpiry > now;
  const activatedAt = dateLikeMillis(record?.activatedAt || record?.createdAt);
  if (activatedAt) return activatedAt + SESSION_ADMISSION_TTL_MS > now;
  return isTesting;
}

function ensureDbExists() {
  if (!DB_PATH) {
    throw new Error('Local JSON storage requires an explicit BILLSPLIT_DB_PATH test fixture.');
  }
  if (!fs.existsSync(DB_PATH)) {
    const defaultData = { users: {}, sessions: {}, history: [], groups: {}, restaurants: {}, restaurantVisits: {}, restaurantObservations: {}, restaurantVisitSourceDeletions: {}, receiptProofUses: {}, rateLimits: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
}

function readDb() {
  ensureDbExists();
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.users) parsed.users = {};
    if (!parsed.sessions) parsed.sessions = {};
    if (!parsed.history) parsed.history = [];
    if (!parsed.groups) parsed.groups = {};
    if (!parsed.restaurants) parsed.restaurants = {};
    if (!parsed.restaurantVisits) parsed.restaurantVisits = {};
    if (!parsed.restaurantObservations) parsed.restaurantObservations = {};
    if (!parsed.restaurantVisitSourceDeletions) parsed.restaurantVisitSourceDeletions = {};
    if (!parsed.receiptProofUses) parsed.receiptProofUses = {};
    if (!parsed.rateLimits) parsed.rateLimits = {};
    return parsed;
  } catch (err) {
    throw new Error(`Could not read the database safely: ${err.message}`);
  }
}

function writeDb(data) {
  try {
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(TMP_PATH, content, 'utf-8');
    fs.renameSync(TMP_PATH, DB_PATH);
  } catch (err) {
    try {
      if (fs.existsSync(TMP_PATH)) fs.unlinkSync(TMP_PATH);
    } catch (_) {}
    throw new Error(`Could not write the database safely: ${err.message}`);
  }
}

function getUserKey(username, phone) {
  const cleanName = (username || '').toString().trim().toLowerCase();
  const cleanPhone = (phone || '').toString().trim();
  if (cleanName && cleanPhone) return `${cleanName}_${cleanPhone}`;
  if (cleanName) return cleanName;
  if (cleanPhone) return cleanPhone;
  return null;
}

let firestoreInstance = null;
function getFirestore() {
  if (!firestoreInstance) {
    const admin = require('firebase-admin');
    firestoreInstance = admin.firestore();
    try {
      firestoreInstance.settings({ ignoreUndefinedProperties: true });
    } catch (_) {}
  }
  return firestoreInstance;
}

async function getRegisteredRoom(firestore, roomType, code) {
  if (!/^(?:\d{5}|\d{8})$/.test(String(code || ''))) return null;
  const registry = await firestore.collection('_room_codes').doc(String(code)).get();
  if (!registry.exists) return null;
  const entry = registry.data();
  if (entry?.roomType !== roomType || typeof entry?.roomId !== 'string') return null;
  if (roomType === 'session' && !sessionAdmissionActive(entry)) return null;
  const room = await firestore.collection(roomType === 'session' ? 'sessions' : 'groups').doc(entry.roomId).get();
  if (!room.exists) return null;
  if (roomType === 'session') {
    const deletion = await firestore.collection('restaurant_visit_source_deletions').doc(entry.roomId).get();
    if (deletion.exists) return null;
  }
  const roomData = room.data();
  if (roomType === 'session' && roomData?.status === 'settled') return null;
  return roomData;
}

async function reserveUniqueFirestoreRoomCode(firestore, roomType, roomId, randomInt = require('crypto').randomInt) {
  if (!['session', 'group'].includes(roomType) || typeof roomId !== 'string' || !roomId) {
    throw new Error('Room type and ID are required for atomic code reservation');
  }
  const isSession = roomType === 'session';
  const lowerBound = isSession ? 10_000 : 10_000_000;
  const upperBound = isSession ? 100_000 : 100_000_000;
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const code = String(randomInt(lowerBound, upperBound));
    try {
      const registryRef = firestore.collection('_room_codes').doc(code);
      await firestore.runTransaction(async (transaction) => {
        const now = Date.now();
        const existing = await transaction.get(registryRef);
        if (existing.exists) {
          const entry = existing.data();
          const reusableAt = Number(entry?.reservationExpiresAt || entry?.expiresAt || 0);
          if (!reusableAt || reusableAt > now) {
            throw Object.assign(new Error('Room code collision'), { code: 'room-code-collision' });
          }
          // An expired active code still belongs to the room that displays it.
          // A losing refresh reservation does not: once it expires and the
          // owner's canonical code differs, it is safe to recycle.
          if (entry?.roomId && ['session', 'group'].includes(entry?.roomType)) {
            const ownerRef = firestore
              .collection(entry.roomType === 'session' ? 'sessions' : 'groups')
              .doc(entry.roomId);
            const ownerSnapshot = await transaction.get(ownerRef);
            const owner = ownerSnapshot.exists ? ownerSnapshot.data() : null;
            const ownerStillOwnsCode = ownerSnapshot.exists
              && String(owner?.code || '') === code
              && (entry.roomType !== 'session' || owner?.status !== 'settled');
            if (ownerStillOwnsCode) {
              throw Object.assign(new Error('Room code collision'), { code: 'room-code-collision' });
            }
          }
        }
        transaction.set(registryRef, {
          roomType,
          roomId,
          state: 'reserved',
          createdAt: now,
          reservationExpiresAt: now + 5 * 60 * 1000,
          expiresAt: now + 5 * 60 * 1000,
        });
      });
      return code;
    } catch (error) {
      if (error?.code !== 6 && error?.code !== 'already-exists' && error?.code !== 'room-code-collision') throw error;
    }
  }
  const error = new Error('A room code could not be allocated safely. Please retry.');
  error.statusCode = 503;
  throw error;
}

async function prepareOwnedRoomCodeDeletion(firestore, transaction, roomType, roomId, code) {
  if (!code) return null;
  const ref = firestore.collection('_room_codes').doc(String(code));
  const snapshot = await transaction.get(ref);
  if (!snapshot.exists) return null;
  const entry = snapshot.data();
  return entry?.roomType === roomType && entry?.roomId === roomId ? ref : null;
}

async function prepareRoomCodeActivation(firestore, transaction, roomType, roomId, code) {
  if (!code) return null;
  const ref = firestore.collection('_room_codes').doc(String(code));
  const snapshot = await transaction.get(ref);
  if (!snapshot.exists) throw new Error('Room code reservation is missing');
  const entry = snapshot.data();
  if (entry.roomType !== roomType || entry.roomId !== roomId) {
    throw new Error('Room code reservation does not match the persisted room');
  }
  const now = Date.now();
  return {
    ref,
    value: {
      roomType,
      roomId,
      state: 'active',
      createdAt: entry.createdAt || now,
      activatedAt: entry.activatedAt || now,
      reservationExpiresAt: null,
      expiresAt: null,
      admissionExpiresAt: roomType === 'session' ? now + SESSION_ADMISSION_TTL_MS : null,
    },
  };
}

function sanitizeFirestoreData(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj?.toMillis === 'function') return obj;
  if (Array.isArray(obj)) {
    return obj.map(sanitizeFirestoreData).filter((v) => v !== undefined);
  }
  if (typeof obj === 'object' && !(obj instanceof Date)) {
    const clean = {};
    for (const [key, val] of Object.entries(obj)) {
      if (val !== undefined) {
        clean[key] = sanitizeFirestoreData(val);
      }
    }
    return clean;
  }
  return obj;
}

function createBoundedFirestoreBatchWriter(firestore, limit = 400) {
  const safeLimit = Math.max(1, Math.min(450, Math.floor(Number(limit) || 400)));
  let batch = firestore.batch();
  let size = 0;
  const flush = async () => {
    if (!size) return;
    await batch.commit();
    batch = firestore.batch();
    size = 0;
  };
  return {
    async enqueue(write) {
      write(batch);
      size += 1;
      if (size >= safeLimit) await flush();
    },
    flush,
  };
}

function assertGroupStorageBudget(group) {
  if ((group?.bills || []).length > 50) {
    const error = new Error('This group has reached its 50-bill limit');
    error.statusCode = 409;
    throw error;
  }
  if (Buffer.byteLength(JSON.stringify(group || {}), 'utf8') > 700_000) {
    const error = new Error('This group is too large. Settle or remove older bills before adding more data.');
    error.statusCode = 413;
    throw error;
  }
}

function assertSessionStorageBudget(session) {
  if (Buffer.byteLength(JSON.stringify(session || {}), 'utf8') > 700_000) {
    const error = new Error('This bill session is too large to update safely');
    error.statusCode = 413;
    throw error;
  }
}

function mergeConcurrentBillState(bill, session, currentBill, currentSession, currentGroup) {
  const latestItems = Array.isArray(currentSession?.items)
    ? currentSession.items
    : (Array.isArray(currentBill?.items) ? currentBill.items : []);
  const latestClaims = new Map(latestItems.map((item) => [item.id, Array.isArray(item.claimedBy) ? item.claimedBy : []]));
  const mergedItems = (Array.isArray(bill.items) ? bill.items : []).map((item) => (
    latestClaims.has(item.id) ? { ...item, claimedBy: [...latestClaims.get(item.id)] } : item
  ));
  const currentSettled = new Map(
    (Array.isArray(currentSession?.members) ? currentSession.members : [])
      .map((member) => [member.id, Boolean(member.settled)])
  );
  const desiredMembers = new Map(
    (Array.isArray(session.members) ? session.members : []).map((member) => [member.id, member])
  );
  const mergedMembers = (Array.isArray(currentGroup?.members) ? currentGroup.members : session.members || []).map((member) => ({
    ...(desiredMembers.get(member.id) || {}),
    ...member,
    settled: currentSettled.get(member.id) || false,
  }));
  const mergedBill = {
    ...bill,
    items: mergedItems,
    ...(currentBill ? {
      sessionId: bill.sessionId || currentBill.sessionId,
      payerId: currentBill.payerId,
      status: currentBill.status,
      settledAt: currentBill.settledAt,
    } : {}),
  };
  const mergedSession = {
    ...session,
    items: mergedItems,
    members: mergedMembers,
    ...(currentSession ? {
      status: currentSession.status,
      settledAt: currentSession.settledAt,
      tipPercentage: currentSession.tipPercentage,
    } : {}),
    payerId: currentBill ? (currentSession?.payerId || currentBill.payerId || bill.payerId) : bill.payerId,
  };
  return { bill: mergedBill, session: mergedSession };
}

function synchronizeSessionMembersWithGroup(session, groupMembers) {
  const existingMembers = new Map(
    (Array.isArray(session?.members) ? session.members : []).map((member) => [member.id, member])
  );
  const participantSetFrozen = session?.status === 'settled'
    || [...existingMembers.values()].some((member) => member.active !== false && member.settled === true);
  if (participantSetFrozen) {
    const groupById = new Map((Array.isArray(groupMembers) ? groupMembers : []).map((member) => [member.id, member]));
    return [...existingMembers.values()].map((existingMember) => ({
      ...existingMember,
      ...(groupById.get(existingMember.id) || {}),
      settled: Boolean(existingMember.settled),
    }));
  }
  return (Array.isArray(groupMembers) ? groupMembers : []).map((groupMember) => ({
    ...(existingMembers.get(groupMember.id) || {}),
    ...groupMember,
    settled: Boolean(existingMembers.get(groupMember.id)?.settled),
  }));
}

function memberAccountId(member) {
  return member?.userId
    || member?.uid
    || (member?.id && !String(member.id).startsWith('member_') ? member.id : '');
}

function resolveExistingRestaurantVisitMembers(session, candidates) {
  const existingMembers = Array.isArray(session?.members) ? session.members : [];
  const resolved = [];
  for (const candidate of candidates || []) {
    if (!candidate) continue;
    let existing = candidate.id
      ? existingMembers.find((member) => member.id === candidate.id)
      : null;
    const candidateAccountId = memberAccountId(candidate);
    if (!existing && candidateAccountId) {
      existing = existingMembers.find((member) => memberAccountId(member) === candidateAccountId);
    }
    if (!existing && !candidateAccountId && candidate.clientIdentityHash) {
      existing = existingMembers.find((member) => (
        !memberAccountId(member)
        && member.clientIdentityHash === candidate.clientIdentityHash
      ));
    }
    if (existing && !resolved.some((member) => member.id === existing.id)) resolved.push(existing);
  }
  return resolved;
}

function claimLocalRestaurantProof(data, proofId, sourceId) {
  if (!proofId) return;
  const existingSourceId = data.receiptProofUses?.[proofId];
  if (existingSourceId && existingSourceId !== sourceId) {
    throw Object.assign(new Error('This scanned receipt was already used in another bill.'), { statusCode: 409 });
  }
  if (!data.receiptProofUses) data.receiptProofUses = {};
  data.receiptProofUses[proofId] = sourceId;
}

async function prepareFirestoreRestaurantProofUse(firestore, transaction, proofId, sourceId) {
  if (!proofId) return null;
  const ref = firestore.collection('_receipt_proof_uses').doc(proofId);
  const snapshot = await transaction.get(ref);
  const existingSourceId = snapshot.exists ? snapshot.data()?.sourceId : '';
  if (existingSourceId && existingSourceId !== sourceId) {
    throw Object.assign(new Error('This scanned receipt was already used in another bill.'), { statusCode: 409 });
  }
  return {
    ref,
    value: {
      sourceId,
      createdAt: snapshot.exists ? snapshot.data()?.createdAt || Date.now() : Date.now(),
      updatedAt: Date.now(),
    },
  };
}

function identityHmac(value) {
  const secret = process.env.EASYSPLIT_IDENTITY_HMAC_SECRET
    || process.env.EASYSPLIT_ANALYTICS_HASH_SALT
    || (isTesting ? 'easysplit-test-only-identity-secret' : '');
  if (!secret || !value) return '';
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

function buildRestaurantVisit(session, member, observedAt = Date.now()) {
  if (!session?.id || !session?.restaurant?.id || !member?.id) return null;
  const canonicalUserId = memberAccountId(member);
  const phoneHmac = member.phone ? identityHmac(`phone:${member.phone}`) : '';
  const identityAliases = [
    canonicalUserId ? `user:${canonicalUserId}` : '',
    phoneHmac ? `phone:${phoneHmac}` : '',
    member.clientIdentityHash ? `device:${member.clientIdentityHash}` : '',
  ].filter(Boolean);
  const visitId = `visit_${crypto.createHash('sha256').update(`${session.id}:${member.id}`).digest('hex').slice(0, 32)}`;
  return sanitizeFirestoreData({
    id: visitId,
    restaurantId: session.restaurant.id,
    sessionId: session.id,
    memberId: member.id,
    userId: canonicalUserId || undefined,
    identityAliases,
    displayNameSnapshot: member.name || 'Member',
    phoneHmac: phoneHmac || undefined,
    phoneAssurance: phoneHmac ? 'format_only' : 'none',
    accountAssurance: canonicalUserId ? 'google_account' : 'guest_device',
    identityKeyVersion: process.env.EASYSPLIT_IDENTITY_HMAC_KEY_VERSION || 'v1',
    visitEvidence: 'bill_participant',
    physicalPresenceVerified: false,
    role: member.isHost ? 'host' : 'participant',
    joinedAt: Number(member.joinedAt || observedAt),
    lastSeenAt: observedAt,
    restaurantConfidence: Number(session.restaurant.confidence || 0),
    restaurantTrustScore: Number(session.restaurant.trustScore || 0),
    restaurantIdentityBasis: session.restaurant.identityBasis || 'unresolved',
    retainedAfterSourceDeletion: true,
    retentionPolicy: 'exclude_when_source_tombstoned',
    sourceState: 'active',
  });
}

function restaurantCorrectionCandidates(restaurant) {
  const evidence = restaurant?.identityEvidence;
  if (!evidence || typeof evidence !== 'object' || !restaurant?.identityAttestation) return {};
  const candidates = {};
  for (const field of ['printedName', 'address', 'phone']) {
    const observed = String(restaurant?.[field] || '').trim();
    const attested = String(evidence?.[field] || '').trim();
    if (observed && observed !== attested) candidates[field] = observed;
  }
  return candidates;
}

function buildRestaurantObservation(session, visits, observedAt = Date.now()) {
  if (!session?.id || !session?.restaurant?.id) return null;
  const correctionCandidates = restaurantCorrectionCandidates(session.restaurant);
  if (!Object.keys(correctionCandidates).length) return null;
  const correctionDigest = crypto.createHash('sha256')
    .update(JSON.stringify(correctionCandidates))
    .digest('hex');
  const id = `observation_${crypto.createHash('sha256')
    .update(`${session.id}:${session.restaurant.id}:${correctionDigest}`)
    .digest('hex')
    .slice(0, 32)}`;
  const observedByVisits = (visits || []).map((visit) => visit?.id).filter(Boolean);
  const submitter = (visits || []).find((visit) => visit?.role === 'host') || (visits || [])[0];
  return sanitizeFirestoreData({
    id,
    restaurantId: session.restaurant.id,
    sessionId: session.id,
    correctionCandidates,
    correctionDigest,
    observedByVisitIds: [...new Set(observedByVisits)],
    submittedByVisitId: submitter?.id,
    submittedByUserId: submitter?.userId,
    attestationHash: crypto.createHash('sha256')
      .update(String(session.restaurant.identityAttestation))
      .digest('hex'),
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    retainedAfterSourceDeletion: true,
    retentionPolicy: 'exclude_when_source_tombstoned',
    sourceState: 'active',
  });
}

function mergeRestaurantObservation(existing, incoming) {
  const prior = existing || {};
  const submittedByVisitId = prior.submittedByVisitId || incoming.submittedByVisitId;
  const incomingIsOriginalSubmitter = !prior.submittedByVisitId
    || incoming.submittedByVisitId === prior.submittedByVisitId;
  return sanitizeFirestoreData({
    ...prior,
    ...incoming,
    correctionCandidates: { ...(prior.correctionCandidates || {}), ...(incoming.correctionCandidates || {}) },
    observedByVisitIds: [...new Set([
      ...(prior.observedByVisitIds || []),
      ...(incoming.observedByVisitIds || []),
    ])],
    submittedByVisitId,
    // Later participants may observe the same corrected room, but they did
    // not submit its correction. Only enrich the original visit when that
    // same participant later binds to an authenticated account.
    submittedByUserId: prior.submittedByUserId
      || (incomingIsOriginalSubmitter ? incoming.submittedByUserId : undefined),
    firstObservedAt: prior.firstObservedAt || incoming.firstObservedAt,
    lastObservedAt: Math.max(Number(prior.lastObservedAt || 0), Number(incoming.lastObservedAt || 0)),
  });
}

function restaurantVisitSourceDeletion(sessionId, sourceType, reason, deletedAt = Date.now()) {
  return sanitizeFirestoreData({
    sessionId,
    sourceType,
    reason,
    deletedAt,
    excludeFromPrimaryMetrics: true,
  });
}

function markLocalRestaurantVisitSourceDeleted(data, sessionId, sourceType, reason, deletedAt = Date.now()) {
  if (!sessionId) return;
  data.restaurantVisitSourceDeletions[sessionId] = restaurantVisitSourceDeletion(
    sessionId, sourceType, reason, deletedAt,
  );
}

async function resumeFirestoreGroupDeletion(firestore, groupId) {
  const planRef = firestore.collection('_group_deletions').doc(groupId);
  const initialPlanSnapshot = await planRef.get();
  if (!initialPlanSnapshot.exists) return false;
  const sessionIds = [...new Set(initialPlanSnapshot.data().sessionIds || [])];

  // Each potentially-large session is deleted in its own bounded transaction.
  // The participant cleanup map is persisted atomically before the source
  // documents disappear, so a crash can safely resume from the plan.
  for (const sessionId of sessionIds) {
    await firestore.runTransaction(async (transaction) => {
      const currentPlanSnapshot = await transaction.get(planRef);
      if (!currentPlanSnapshot.exists) return;
      const sessionRef = firestore.collection('sessions').doc(sessionId);
      const historyRef = firestore.collection('history').doc(sessionId);
      const sessionSnapshot = await transaction.get(sessionRef);
      const historySnapshot = await transaction.get(historyRef);
      const session = sessionSnapshot.exists ? sessionSnapshot.data() : null;
      const history = historySnapshot.exists ? historySnapshot.data() : null;
      const ownedCodeRef = session?.code
        ? await prepareOwnedRoomCodeDeletion(firestore, transaction, 'session', sessionId, session.code)
        : null;
      const currentPlan = currentPlanSnapshot.data();
      const memberUserIdsBySession = { ...(currentPlan.memberUserIdsBySession || {}) };
      memberUserIdsBySession[sessionId] = [...new Set([
        ...(memberUserIdsBySession[sessionId] || []),
        ...(session?.members || []).map(memberAccountId),
        ...(Array.isArray(history?.memberIds) ? history.memberIds : []),
      ].filter(Boolean))];
      transaction.set(planRef, sanitizeFirestoreData({ memberUserIdsBySession }), { merge: true });
      if (sessionSnapshot.exists) transaction.delete(sessionRef);
      if (historySnapshot.exists) transaction.delete(historyRef);
      if (ownedCodeRef) transaction.delete(ownedCodeRef);
    });
  }

  const completedPlanSnapshot = await planRef.get();
  if (!completedPlanSnapshot.exists) return true;
  const plan = completedPlanSnapshot.data();
  const memberUserIdsBySession = plan.memberUserIdsBySession || {};
  const groupUserIds = [...new Set((plan.groupUserIds || []).filter(Boolean))];
  const fieldValue = require('firebase-admin').firestore.FieldValue;
  const cleanupWriter = createBoundedFirestoreBatchWriter(firestore, 400);

  for (const sessionId of sessionIds) {
    for (const userId of memberUserIdsBySession[sessionId] || []) {
      await cleanupWriter.enqueue((batch) => batch.delete(
        firestore.collection('users').doc(userId).collection('history').doc(sessionId),
      ));
    }
  }
  for (const userId of groupUserIds) {
    await cleanupWriter.enqueue((batch) => batch.set(firestore.collection('users').doc(userId), {
      groups: fieldValue.arrayRemove(groupId),
      updatedAt: Date.now(),
    }, { merge: true }));
  }
  await cleanupWriter.flush();
  await planRef.delete();
  return true;
}

function writeRestaurantVisitSourceDeletion(firestore, transaction, sessionId, sourceType, reason, deletedAt = Date.now()) {
  if (!sessionId) return;
  transaction.set(
    firestore.collection('restaurant_visit_source_deletions').doc(sessionId),
    restaurantVisitSourceDeletion(sessionId, sourceType, reason, deletedAt),
  );
}

function mergeRestaurantRecord(existing, incoming, observedAt) {
  const prior = existing || {};
  const signedEvidence = incoming?.identityEvidence && typeof incoming.identityEvidence === 'object'
    ? incoming.identityEvidence
    : null;
  const canonicalIncoming = { ...incoming };
  if (!existing && signedEvidence) {
    const corrections = {};
    for (const field of ['printedName', 'businessId', 'address', 'phone']) {
      if (incoming?.[field] && incoming[field] !== signedEvidence[field]) corrections[field] = incoming[field];
      if (signedEvidence[field]) canonicalIncoming[field] = signedEvidence[field];
    }
    if (signedEvidence.normalizedName) canonicalIncoming.normalizedName = signedEvidence.normalizedName;
    canonicalIncoming.source = signedEvidence.source || canonicalIncoming.source;
    canonicalIncoming.fieldTrust = { ...(incoming.fieldTrust || {}) };
    for (const [field, status] of Object.entries(signedEvidence.fieldVerification || {})) {
      if (status === 'verified') canonicalIncoming.fieldTrust[field] = Number(signedEvidence.trustScore || 0.8);
    }
    if (Object.keys(corrections).length) canonicalIncoming.userCorrectionCandidates = corrections;
  }
  const incomingTrust = Number(canonicalIncoming?.trustScore || canonicalIncoming?.confidence || 0);
  const priorTrust = Number(prior?.trustScore || prior?.confidence || 0);
  const merged = incomingTrust >= priorTrust ? { ...prior, ...canonicalIncoming } : { ...canonicalIncoming, ...prior };
  const mergedFieldTrust = { ...(prior.fieldTrust || {}) };
  for (const field of ['printedName', 'normalizedName', 'businessId', 'address', 'phone']) {
    const incomingField = field === 'normalizedName' ? 'printedName' : field;
    const incomingFieldTrust = Number(canonicalIncoming?.fieldTrust?.[incomingField] ?? incomingTrust);
    const priorFieldTrust = Number(prior?.fieldTrust?.[incomingField] ?? priorTrust);
    if (canonicalIncoming?.[field] && (!prior?.[field] || incomingFieldTrust > priorFieldTrust)) {
      merged[field] = canonicalIncoming[field];
      mergedFieldTrust[incomingField] = incomingFieldTrust;
    } else if (prior?.[field]) {
      merged[field] = prior[field];
      mergedFieldTrust[incomingField] = priorFieldTrust;
    }
  }
  return sanitizeFirestoreData({
    ...prior,
    ...merged,
    id: incoming.id,
    fieldTrust: mergedFieldTrust,
    firstSeenAt: prior.firstSeenAt || observedAt,
    lastSeenAt: Math.max(Number(prior.lastSeenAt || 0), observedAt),
  });
}

function mergeRestaurantVisit(existing, incoming) {
  const prior = existing || {};
  const durablePriorAliases = (prior.identityAliases || [])
    .filter((alias) => typeof alias === 'string' && !alias.startsWith('phone:'));
  const incomingAliases = (incoming.identityAliases || []).filter((alias) => typeof alias === 'string');
  return sanitizeFirestoreData({
    ...prior,
    ...incoming,
    userId: incoming.userId || prior.userId,
    // Format-only phones are mutable user assertions, not verified identity.
    // Retain durable account/device upgrades, but replace rather than union a
    // corrected phone alias so a typo cannot permanently link two people.
    identityAliases: [...new Set([...durablePriorAliases, ...incomingAliases])],
    joinedAt: prior.joinedAt || incoming.joinedAt,
    lastSeenAt: Math.max(Number(prior.lastSeenAt || 0), Number(incoming.lastSeenAt || 0)),
  });
}

function applyLocalRestaurantVisits(data, session, members, observedAt = Date.now(), { upsertRestaurant = true } = {}) {
  if (!session?.restaurant?.id) return [];
  const visits = (members || []).map((member) => buildRestaurantVisit(session, member, observedAt)).filter(Boolean);
  if (!visits.length) return [];
  if (upsertRestaurant && !data.restaurants[session.restaurant.id]) {
    data.restaurants[session.restaurant.id] = mergeRestaurantRecord(
      data.restaurants[session.restaurant.id], session.restaurant, observedAt,
    );
  }
  for (const visit of visits) {
    data.restaurantVisits[visit.id] = mergeRestaurantVisit(data.restaurantVisits[visit.id], visit);
  }
  const observation = buildRestaurantObservation(session, visits, observedAt);
  if (observation) {
    data.restaurantObservations[observation.id] = mergeRestaurantObservation(
      data.restaurantObservations[observation.id], observation,
    );
  }
  return visits;
}

async function prepareFirestoreRestaurantVisits(
  firestore,
  transaction,
  session,
  members,
  observedAt = Date.now(),
  { upsertRestaurant = true } = {},
) {
  if (!session?.restaurant?.id) return [];
  const visits = (members || []).map((member) => buildRestaurantVisit(session, member, observedAt)).filter(Boolean);
  if (!visits.length) return [];
  const restaurantRef = upsertRestaurant ? firestore.collection('restaurants').doc(session.restaurant.id) : null;
  const restaurantSnapshot = restaurantRef ? await transaction.get(restaurantRef) : null;
  const visitRows = [];
  for (const visit of visits) {
    const ref = firestore.collection('restaurant_visits').doc(visit.id);
    const snapshot = await transaction.get(ref);
    visitRows.push({ ref, snapshot, visit });
  }
  const observation = buildRestaurantObservation(session, visits, observedAt);
  const observationRef = observation
    ? firestore.collection('restaurant_observations').doc(observation.id)
    : null;
  const observationSnapshot = observationRef ? await transaction.get(observationRef) : null;
  // Canonical venue evidence is immutable after its first trusted write.
  // Session and visit documents carry later observations, avoiding a hot
  // shared write for every table at a popular restaurant.
  const restaurantRows = restaurantRef && !restaurantSnapshot.exists ? [{
    ref: restaurantRef,
    value: mergeRestaurantRecord(restaurantSnapshot.exists ? restaurantSnapshot.data() : null, session.restaurant, observedAt),
  }] : [];
  const observationRows = observationRef && observation ? [{
    ref: observationRef,
    value: mergeRestaurantObservation(
      observationSnapshot?.exists ? observationSnapshot.data() : null,
      observation,
    ),
  }] : [];
  return [
    ...restaurantRows,
    ...visitRows.map(({ ref, snapshot, visit }) => ({
      ref,
      value: mergeRestaurantVisit(snapshot.exists ? snapshot.data() : null, visit),
    })),
    ...observationRows,
  ];
}

function writePreparedRestaurantVisits(transaction, prepared) {
  for (const row of prepared || []) transaction.set(row.ref, row.value);
}

async function migrateLocalDbToFirestore() {
  const error = new Error('Legacy boot migration is disabled because it can overwrite or resurrect stale data. Use scripts/safe-firestore-cutover.js after a verified dry-run.');
  error.statusCode = 409;
  throw error;
}

const db = {
  migrateLocalDbToFirestore,

  getUserByUid(uid) {
    if (isTesting) {
      if (!uid) return null;
      const data = readDb();
      return data.users[uid] ? { ...data.users[uid], id: uid } : null;
    }
    return (async () => {
      if (!uid) return null;
      const doc = await getFirestore().collection('users').doc(uid).get();
      return doc.exists ? { ...doc.data(), id: uid } : null;
    })();
  },

  getUser(username, phone) {
    if (isTesting) {
      const key = getUserKey(username, phone);
      if (!key) return null;
      const data = readDb();
      if (data.users[key]) return data.users[key];
      const cleanName = (username || '').toString().trim().toLowerCase();
      const cleanPhone = (phone || '').toString().trim();
      const found = Object.values(data.users).find((u) => {
        const uName = (u.username || '').trim().toLowerCase();
        const uPhone = (u.phone || '').trim();
        if (cleanName && uName === cleanName) return true;
        if (cleanPhone && uPhone === cleanPhone) return true;
        return false;
      });
      return found || null;
    }
    return (async () => {
      const usersRef = getFirestore().collection('users');
      const cleanName = (username || '').toString().trim().toLowerCase();
      const cleanPhone = (phone || '').toString().trim();
      if (cleanPhone) {
        const snap = await usersRef.where('phone', '==', cleanPhone).limit(1).get();
        if (!snap.empty) return snap.docs[0].data();
      }
      if (cleanName) {
        const snap = await usersRef.where('username_lowercase', '==', cleanName).limit(1).get();
        if (!snap.empty) return snap.docs[0].data();
      }
      return null;
    })();
  },

  saveUser(user, trustedUid = '') {
    const uid = trustedUid || user?.id;
    if (!uid) return null;
    const normalizedUser = { ...user, id: uid };
    if (isTesting) {
      const data = readDb();
      data.users[uid] = { ...normalizedUser, updatedAt: Date.now() };
      writeDb(data);
      return data.users[uid];
    }
    return (async () => {
      const username_lowercase = (normalizedUser.username || '').toString().trim().toLowerCase();
      const data = {
        ...normalizedUser,
        username_lowercase,
        updatedAt: Date.now()
      };
      await getFirestore().collection('users').doc(uid).set(data, { merge: true });
      return data;
    })();
  },

  addGroupToUser(uid, groupId) {
    if (!uid || !groupId) return null;
    if (isTesting) {
      const data = readDb();
      const user = data.users?.[uid];
      const group = data.groups?.[groupId];
      const isCurrentMember = group?.members?.some((member) => (
        member?.active !== false && memberAccountId(member) === uid
      ));
      if (!user || !group || String(group.status || 'active').toLowerCase() !== 'active' || !isCurrentMember) return null;
      if (!Array.isArray(user.groups)) user.groups = [];
      if (!user.groups.includes(groupId)) user.groups.push(groupId);
      user.updatedAt = Date.now();
      writeDb(data);
      return user;
    }
    return (async () => {
      const firestore = getFirestore();
      const userRef = firestore.collection('users').doc(uid);
      const groupRef = firestore.collection('groups').doc(groupId);
      const deletionRef = firestore.collection('_group_deletions').doc(groupId);
      return firestore.runTransaction(async (transaction) => {
        const [snapshot, groupSnapshot, deletionSnapshot] = await Promise.all([
          transaction.get(userRef),
          transaction.get(groupRef),
          transaction.get(deletionRef),
        ]);
        if (!snapshot.exists || !groupSnapshot.exists || deletionSnapshot.exists) return null;
        const group = groupSnapshot.data();
        const isCurrentMember = group?.members?.some((member) => (
          member?.active !== false && memberAccountId(member) === uid
        ));
        if (String(group?.status || 'active').toLowerCase() !== 'active' || !isCurrentMember) return null;
        const user = snapshot.data();
        const groups = Array.isArray(user.groups) ? [...user.groups] : [];
        if (!groups.includes(groupId)) groups.push(groupId);
        transaction.set(userRef, { groups, updatedAt: Date.now() }, { merge: true });
        return { ...user, groups };
      });
    })();
  },

  findOrCreateUser(uid, username, phone, settings = {}) {
    const safeSettings = sanitizeUserSettings(settings);
    if (isTesting) {
      if (!uid) {
        const tempKey = getUserKey(username, phone) || `usr_temp_${Date.now()}`;
        const data = readDb();
        if (data.users && data.users[tempKey]) return data.users[tempKey];
        const legacyUser = {
          id: createEntityId('usr'),
          username: username || 'User',
          phone: phone || '',
          avatarColor: '#7C3AED',
          settings: {
            language: safeSettings.language || 'en',
            currency: safeSettings.currency || 'NIS',
            theme: safeSettings.theme || 'dark',
            customGeminiKey: safeSettings.customGeminiKey || '',
            ocrEngine: safeSettings.ocrEngine || 'tesseract'
          },
          bills: [],
          groups: [],
          createdAt: Date.now()
        };
        this.saveUser(legacyUser);
        return legacyUser;
      }
      let user = this.getUserByUid(uid);
      const data = readDb();
      if (!user) {
        user = {
          id: uid,
          username: username || 'User',
          phone: phone || '',
          avatarColor: '#7C3AED',
          settings: {
            language: safeSettings.language || 'en',
            currency: safeSettings.currency || 'NIS',
            theme: safeSettings.theme || 'light',
            customGeminiKey: safeSettings.customGeminiKey || '',
            ocrEngine: safeSettings.ocrEngine || 'tesseract'
          },
          bills: [],
          groups: [],
          createdAt: Date.now()
        };
      } else {
        user.id = uid;
        if (username) user.username = username;
        if (phone) user.phone = phone;
        if (Object.keys(safeSettings).length > 0) {
          user.settings = { ...(user.settings || {}), ...safeSettings };
        }
        user.updatedAt = Date.now();
      }
      data.users[uid] = user;
      writeDb(data);
      return user;
    }
    return (async () => {
      if (!uid) {
        let legacyUser = await this.getUser(username, phone);
        if (legacyUser) return legacyUser;
        legacyUser = {
          id: createEntityId('usr'),
          username: username || 'User',
          phone: phone || '',
          avatarColor: '#7C3AED',
          settings: {
            language: safeSettings.language || 'en',
            currency: safeSettings.currency || 'NIS',
            theme: safeSettings.theme || 'dark',
            customGeminiKey: safeSettings.customGeminiKey || '',
            ocrEngine: safeSettings.ocrEngine || 'tesseract'
          },
          bills: [],
          groups: [],
          createdAt: Date.now()
        };
        await this.saveUser(legacyUser);
        return legacyUser;
      }
      let user = await this.getUserByUid(uid);
      if (!user) {
        user = {
          id: uid,
          username: username || 'User',
          phone: phone || '',
          avatarColor: '#7C3AED',
          settings: {
            language: safeSettings.language || 'en',
            currency: safeSettings.currency || 'NIS',
            theme: safeSettings.theme || 'light',
            customGeminiKey: safeSettings.customGeminiKey || '',
            ocrEngine: safeSettings.ocrEngine || 'tesseract'
          },
          bills: [],
          groups: [],
          createdAt: Date.now()
        };
      } else {
        user.id = uid;
        if (username) user.username = username;
        if (phone) user.phone = phone;
        if (Object.keys(safeSettings).length > 0) {
          user.settings = { ...(user.settings || {}), ...safeSettings };
        }
      }
      await this.saveUser(user, uid);
      return user;
    })();
  },

  updateUserSettings(uid, username, phone, newSettings) {
    const safeSettings = sanitizeUserSettings(newSettings);
    if (isTesting) {
      const user = this.findOrCreateUser(uid, username, phone);
      if (user) {
        user.settings = { ...(user.settings || {}), ...safeSettings };
        this.saveUser(user, uid);
      }
      return user;
    }
    return (async () => {
      const user = await this.findOrCreateUser(uid, username, phone);
      if (user) {
        user.settings = { ...(user.settings || {}), ...safeSettings };
        await this.saveUser(user, uid);
      }
      return user;
    })();
  },

  addUserBill(uid, username, phone, billRecord) {
    if (isTesting) {
      const user = this.findOrCreateUser(uid, username, phone);
      if (user) {
        if (!Array.isArray(user.bills)) user.bills = [];
        const existsIdx = user.bills.findIndex((b) => b.id === billRecord.id);
        if (existsIdx > -1) {
          user.bills[existsIdx] = { ...user.bills[existsIdx], ...billRecord };
        } else {
          user.bills.unshift(billRecord);
        }
        this.saveUser(user, uid);
      }
      return user;
    }
    return (async () => {
      const user = await this.findOrCreateUser(uid, username, phone);
      if (user) {
        if (!Array.isArray(user.bills)) user.bills = [];
        const existsIdx = user.bills.findIndex((b) => b.id === billRecord.id);
        if (existsIdx > -1) {
          user.bills[existsIdx] = { ...user.bills[existsIdx], ...billRecord };
        } else {
          user.bills.unshift(billRecord);
        }
        await this.saveUser(user, uid);
      }
      return user;
    })();
  },

  getSession(idOrCode) {
    if (isTesting) {
      const data = readDb();
      if (data.sessions[idOrCode]) {
        return data.restaurantVisitSourceDeletions?.[data.sessions[idOrCode].id]
          || String(data.sessions[idOrCode].status || '').toLowerCase() === 'deleting'
          ? null
          : data.sessions[idOrCode];
      }
      return Object.values(data.sessions).find((session) => (
        (session.code === idOrCode || session.id === idOrCode)
        && !data.restaurantVisitSourceDeletions?.[session.id]
        && String(session.status || '').toLowerCase() !== 'deleting'
        && (session.id === idOrCode || (
          String(session.status || '').toLowerCase() !== 'settled'
          && sessionAdmissionActive(session)
        ))
      )) || null;
    }
    return (async () => {
      if (!idOrCode) return null;
      const doc = await getFirestore().collection('sessions').doc(idOrCode).get();
      if (doc.exists) {
        const session = doc.data();
        const deletion = await getFirestore().collection('restaurant_visit_source_deletions').doc(doc.id).get();
        return deletion.exists || String(session.status || '').toLowerCase() === 'deleting' ? null : session;
      }
      const firestore = getFirestore();
      const registered = await getRegisteredRoom(firestore, 'session', idOrCode);
      if (registered) return registered;
      if (/^\d{5}$/.test(String(idOrCode))) return null;
      const snap = await firestore.collection('sessions').where('code', '==', idOrCode).limit(1).get();
      if (snap.empty) return null;
      const session = snap.docs[0].data();
      const deletion = await firestore.collection('restaurant_visit_source_deletions').doc(snap.docs[0].id).get();
      const status = String(session.status || '').toLowerCase();
      return deletion.exists
        || status === 'deleting'
        || status === 'settled'
        || !sessionAdmissionActive(session)
        ? null
        : session;
    })();
  },

  saveSession(session) {
    assertSessionStorageBudget(session);
    if (isTesting) {
      const data = readDb();
      data.sessions[session.id] = { ...session, updatedAt: Date.now() };
      writeDb(data);
      return data.sessions[session.id];
    }
    return (async () => {
      const id = session.id;
      if (!id) return null;
      const data = sanitizeFirestoreData({ ...session, updatedAt: Date.now() });
      await getFirestore().collection('sessions').doc(id).set(data, { merge: true });
      return data;
    })();
  },

  createSessionIfAbsent(session, { restaurantVisitMembers = [], restaurantProofId = '' } = {}) {
    assertSessionStorageBudget(session);
    if (isTesting) {
      const data = readDb();
      claimLocalRestaurantProof(data, restaurantProofId, session.id);
      if (data.restaurantVisitSourceDeletions?.[session.id]) {
        throw Object.assign(new Error('A deleted receipt session cannot be recreated. Start a new scan.'), { statusCode: 409 });
      }
      if (data.sessions[session.id]) {
        const existing = data.sessions[session.id];
        applyLocalRestaurantVisits(
          data,
          existing,
          resolveExistingRestaurantVisitMembers(existing, restaurantVisitMembers),
        );
        writeDb(data);
        return { created: false, session: existing };
      }
      const stored = { ...session, updatedAt: Date.now() };
      data.sessions[session.id] = stored;
      applyLocalRestaurantVisits(data, stored, restaurantVisitMembers);
      writeDb(data);
      return { created: true, session: stored };
    }
    return (async () => {
      const firestore = getFirestore();
      const sessionRef = firestore.collection('sessions').doc(session.id);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(sessionRef);
        const deletionRef = firestore.collection('restaurant_visit_source_deletions').doc(session.id);
        const deletionSnapshot = await transaction.get(deletionRef);
        const proofUse = await prepareFirestoreRestaurantProofUse(
          firestore, transaction, restaurantProofId, session.id,
        );
        if (deletionSnapshot.exists) {
          throw Object.assign(new Error('A deleted receipt session cannot be recreated. Start a new scan.'), { statusCode: 409 });
        }
        const codeActivation = !snapshot.exists
          ? await prepareRoomCodeActivation(firestore, transaction, 'session', session.id, session.code)
          : null;
        if (snapshot.exists) {
          const existing = snapshot.data();
          const restaurantWrites = await prepareFirestoreRestaurantVisits(
            firestore,
            transaction,
            existing,
            resolveExistingRestaurantVisitMembers(existing, restaurantVisitMembers),
          );
          writePreparedRestaurantVisits(transaction, restaurantWrites);
          if (proofUse) transaction.set(proofUse.ref, sanitizeFirestoreData(proofUse.value));
          return { created: false, session: existing };
        }
        const stored = sanitizeFirestoreData({ ...session, updatedAt: Date.now() });
        const restaurantWrites = await prepareFirestoreRestaurantVisits(
          firestore, transaction, stored, restaurantVisitMembers,
        );
        transaction.create(sessionRef, stored);
        if (codeActivation) transaction.set(codeActivation.ref, codeActivation.value);
        writePreparedRestaurantVisits(transaction, restaurantWrites);
        if (proofUse) transaction.set(proofUse.ref, sanitizeFirestoreData(proofUse.value));
        return { created: true, session: stored };
      });
    })();
  },

  transactSessionAndLinkedGroup(sessionId, transform, { manualAdmissionCode = '' } = {}) {
    if (isTesting) {
      const data = readDb();
      const currentSession = data.sessions[sessionId];
      if (!currentSession || data.restaurantVisitSourceDeletions?.[sessionId]) return null;
      const currentGroup = currentSession.groupId ? data.groups[currentSession.groupId] || null : null;
      const result = transform(
        JSON.parse(JSON.stringify(currentSession)),
        currentGroup ? JSON.parse(JSON.stringify(currentGroup)) : null,
        {
          manualCodeAuthorized: Boolean(
            /^\d{5}$/.test(String(manualAdmissionCode || ''))
            && String(currentSession.code || '') === String(manualAdmissionCode)
            && currentSession.status !== 'settled'
            && sessionAdmissionActive(currentSession)
          ),
        },
      );
      if (!result?.session) return null;
      const updatedAt = Date.now();
      assertSessionStorageBudget(result.session);
      if (result.group) assertGroupStorageBudget(result.group);
      data.sessions[sessionId] = { ...result.session, updatedAt };
      applyLocalRestaurantVisits(
        data, result.session, result.restaurantVisitMembers || [], updatedAt, { upsertRestaurant: false },
      );
      if (result.group) data.groups[result.group.id] = { ...result.group, updatedAt };
      if (result.deleteHistory) {
        data.history = (data.history || []).filter((entry) => entry.id !== sessionId);
      } else if (result.history) {
        const historyIndex = data.history.findIndex((entry) => entry.id === result.history.id);
        if (historyIndex >= 0) data.history[historyIndex] = result.history;
        else data.history.unshift(result.history);
      }
      for (const memberId of result.removeHistoryForMemberIds || []) {
        if (Array.isArray(data.historyPointers?.[memberId])) {
          data.historyPointers[memberId] = data.historyPointers[memberId]
            .filter((entry) => (entry.historyId || entry.id) !== sessionId);
        }
        if (Array.isArray(data.users?.[memberId]?.bills)) {
          data.users[memberId].bills = data.users[memberId].bills.filter((entry) => entry.id !== sessionId);
        }
      }
      writeDb(data);
      return {
        session: data.sessions[sessionId],
        group: result.group ? data.groups[result.group.id] : null,
        history: result.history || null,
      };
    }
    return (async () => {
      const firestore = getFirestore();
      const sessionRef = firestore.collection('sessions').doc(sessionId);
      return firestore.runTransaction(async (transaction) => {
        const sessionSnapshot = await transaction.get(sessionRef);
        if (!sessionSnapshot.exists) return null;
        const sourceDeletionSnapshot = await transaction.get(
          firestore.collection('restaurant_visit_source_deletions').doc(sessionId),
        );
        if (sourceDeletionSnapshot.exists) return null;
        const currentSession = sessionSnapshot.data();
        const groupRef = currentSession.groupId ? firestore.collection('groups').doc(currentSession.groupId) : null;
        const groupSnapshot = groupRef ? await transaction.get(groupRef) : null;
        const currentGroup = groupSnapshot?.exists ? groupSnapshot.data() : null;
        let manualCodeAuthorized = false;
        if (/^\d{5}$/.test(String(manualAdmissionCode || ''))) {
          const codeRef = firestore.collection('_room_codes').doc(String(manualAdmissionCode));
          const codeSnapshot = await transaction.get(codeRef);
          const entry = codeSnapshot.exists ? codeSnapshot.data() : null;
          manualCodeAuthorized = Boolean(
            entry?.roomType === 'session'
            && entry?.roomId === sessionId
            && entry?.state === 'active'
            && sessionAdmissionActive(entry)
          );
        }
        const result = transform(currentSession, currentGroup, { manualCodeAuthorized });
        if (!result?.session) return null;
        const updatedAt = Date.now();
        assertSessionStorageBudget(result.session);
        if (result.group) assertGroupStorageBudget(result.group);
        const cleanSession = sanitizeFirestoreData({ ...result.session, updatedAt });
        const codeActivation = result.activateRoomCode && cleanSession.status !== 'settled'
          ? await prepareRoomCodeActivation(firestore, transaction, 'session', sessionId, cleanSession.code)
          : null;
        const ownedCodeRef = cleanSession.status === 'settled'
          ? await prepareOwnedRoomCodeDeletion(firestore, transaction, 'session', sessionId, cleanSession.code)
          : (result.activateRoomCode && currentSession.code !== cleanSession.code
            ? await prepareOwnedRoomCodeDeletion(firestore, transaction, 'session', sessionId, currentSession.code)
            : null);
        const restaurantWrites = await prepareFirestoreRestaurantVisits(
          firestore,
          transaction,
          cleanSession,
          result.restaurantVisitMembers || [],
          updatedAt,
          { upsertRestaurant: false },
        );
        transaction.set(sessionRef, cleanSession);
        if (codeActivation) transaction.set(codeActivation.ref, codeActivation.value);
        writePreparedRestaurantVisits(transaction, restaurantWrites);
        if (ownedCodeRef) transaction.delete(ownedCodeRef);
        let cleanGroup = null;
        if (groupRef && result.group) {
          cleanGroup = sanitizeFirestoreData({ ...result.group, updatedAt });
          transaction.set(groupRef, cleanGroup);
        }
        let cleanHistory = null;
        if (result.history?.id) {
          cleanHistory = sanitizeFirestoreData(result.history);
          transaction.set(firestore.collection('history').doc(result.history.id), cleanHistory);
          for (const memberId of result.history.memberIds || []) {
            transaction.set(
              firestore.collection('users').doc(memberId).collection('history').doc(result.history.id),
              sanitizeFirestoreData({
                historyId: result.history.id,
                settledAt: result.history.settledAt || updatedAt,
                createdAt: result.history.createdAt || updatedAt,
              }),
            );
          }
        }
        for (const memberId of result.removeHistoryForMemberIds || []) {
          transaction.delete(firestore.collection('users').doc(memberId).collection('history').doc(sessionId));
        }
        if (result.deleteHistory) transaction.delete(firestore.collection('history').doc(sessionId));
        return { session: cleanSession, group: cleanGroup, history: cleanHistory };
      });
    })();
  },

  transactGroupMembership(groupId, transform) {
    if (isTesting) {
      const data = readDb();
      const currentGroup = data.groups[groupId];
      if (!currentGroup) return null;
      const updatedGroup = transform(JSON.parse(JSON.stringify(currentGroup)));
      if (!updatedGroup) return null;
      assertGroupStorageBudget(updatedGroup);
      const updatedAt = Date.now();
      data.groups[groupId] = { ...updatedGroup, updatedAt };
      const sessions = [];
      for (const bill of updatedGroup.bills || []) {
        const session = bill.sessionId ? data.sessions[bill.sessionId] : null;
        if (!session) continue;
        session.members = synchronizeSessionMembersWithGroup(session, updatedGroup.members);
        session.updatedAt = updatedAt;
        assertSessionStorageBudget(session);
        sessions.push(session);
      }
      writeDb(data);
      return { group: data.groups[groupId], sessions };
    }
    return (async () => {
      const firestore = getFirestore();
      const groupRef = firestore.collection('groups').doc(groupId);
      return firestore.runTransaction(async (transaction) => {
        const groupSnapshot = await transaction.get(groupRef);
        if (!groupSnapshot.exists) return null;
        const currentGroup = groupSnapshot.data();
        const sessionRefs = [...new Set((currentGroup.bills || []).map((bill) => bill.sessionId).filter(Boolean))]
          .map((sessionId) => firestore.collection('sessions').doc(sessionId));
        const sessionSnapshots = [];
        for (const sessionRef of sessionRefs) sessionSnapshots.push(await transaction.get(sessionRef));
        const updatedGroup = transform(currentGroup);
        if (!updatedGroup) return null;
        assertGroupStorageBudget(updatedGroup);
        const updatedAt = Date.now();
        const cleanGroup = sanitizeFirestoreData({ ...updatedGroup, updatedAt });
        transaction.set(groupRef, cleanGroup);
        const sessions = [];
        sessionSnapshots.forEach((snapshot, index) => {
          if (!snapshot.exists) return;
          const session = snapshot.data();
          session.members = synchronizeSessionMembersWithGroup(session, updatedGroup.members);
          session.updatedAt = updatedAt;
          assertSessionStorageBudget(session);
          const cleanSession = sanitizeFirestoreData(session);
          transaction.set(sessionRefs[index], cleanSession);
          sessions.push(cleanSession);
        });
        return { group: cleanGroup, sessions };
      });
    })();
  },

  transactGroupAndLinkedSession(groupId, sessionIdResolver, transform) {
    if (isTesting) {
      const data = readDb();
      const currentGroup = data.groups[groupId];
      if (!currentGroup) return null;
      const sessionId = sessionIdResolver(currentGroup);
      const currentSession = sessionId ? data.sessions[sessionId] || null : null;
      const result = transform(
        JSON.parse(JSON.stringify(currentGroup)),
        currentSession ? JSON.parse(JSON.stringify(currentSession)) : null,
      );
      if (!result?.group) return null;
      assertGroupStorageBudget(result.group);
      if (result.session) assertSessionStorageBudget(result.session);
      const updatedAt = Date.now();
      data.groups[groupId] = { ...result.group, updatedAt };
      if (result.session) data.sessions[result.session.id] = { ...result.session, updatedAt };
      if (result.deleteHistory && sessionId) {
        data.history = (data.history || []).filter((entry) => entry.id !== sessionId);
      }
      for (const memberId of result.removeHistoryForMemberIds || []) {
        if (Array.isArray(data.historyPointers?.[memberId])) {
          data.historyPointers[memberId] = data.historyPointers[memberId]
            .filter((entry) => (entry.historyId || entry.id) !== sessionId);
        }
        if (Array.isArray(data.users?.[memberId]?.bills)) {
          data.users[memberId].bills = data.users[memberId].bills.filter((entry) => entry.id !== sessionId);
        }
      }
      writeDb(data);
      return { group: data.groups[groupId], session: result.session ? data.sessions[result.session.id] : null };
    }
    return (async () => {
      const firestore = getFirestore();
      const groupRef = firestore.collection('groups').doc(groupId);
      return firestore.runTransaction(async (transaction) => {
        const groupSnapshot = await transaction.get(groupRef);
        if (!groupSnapshot.exists) return null;
        const currentGroup = groupSnapshot.data();
        const sessionId = sessionIdResolver(currentGroup);
        const sessionRef = sessionId ? firestore.collection('sessions').doc(sessionId) : null;
        const sessionSnapshot = sessionRef ? await transaction.get(sessionRef) : null;
        const currentSession = sessionSnapshot?.exists ? sessionSnapshot.data() : null;
        const result = transform(currentGroup, currentSession);
        if (!result?.group) return null;
        const historyMemberIds = [...new Set((result.removeHistoryForMemberIds || []).filter(Boolean))];
        const historyUserRefs = historyMemberIds.map((memberId) => firestore.collection('users').doc(memberId));
        const historyUserSnapshots = [];
        for (const userRef of historyUserRefs) historyUserSnapshots.push(await transaction.get(userRef));
        const codeActivation = sessionRef && result.activateRoomCode && result.session?.code
          ? await prepareRoomCodeActivation(firestore, transaction, 'session', sessionRef.id, result.session.code)
          : null;
        const oldCodeRef = sessionRef
          && result.activateRoomCode
          && currentSession?.code
          && currentSession.code !== result.session?.code
          ? await prepareOwnedRoomCodeDeletion(firestore, transaction, 'session', sessionRef.id, currentSession.code)
          : null;
        assertGroupStorageBudget(result.group);
        if (result.session) assertSessionStorageBudget(result.session);
        const updatedAt = Date.now();
        const cleanGroup = sanitizeFirestoreData({ ...result.group, updatedAt });
        transaction.set(groupRef, cleanGroup);
        let cleanSession = null;
        if (sessionRef && result.session) {
          cleanSession = sanitizeFirestoreData({ ...result.session, updatedAt });
          transaction.set(sessionRef, cleanSession);
        }
        if (codeActivation) transaction.set(codeActivation.ref, codeActivation.value);
        if (oldCodeRef) transaction.delete(oldCodeRef);
        if (result.deleteHistory && sessionId) transaction.delete(firestore.collection('history').doc(sessionId));
        historyMemberIds.forEach((memberId, index) => {
          transaction.delete(firestore.collection('users').doc(memberId).collection('history').doc(sessionId));
          const userSnapshot = historyUserSnapshots[index];
          if (userSnapshot?.exists && Array.isArray(userSnapshot.data()?.bills)) {
            transaction.set(historyUserRefs[index], sanitizeFirestoreData({
              bills: userSnapshot.data().bills.filter((entry) => entry.id !== sessionId),
              updatedAt,
            }), { merge: true });
          }
        });
        return { group: cleanGroup, session: cleanSession };
      });
    })();
  },

  deleteSession(sessionId, { requireStandalone = false, actorId = '' } = {}) {
    if (isTesting) {
      const data = readDb();
      const session = data.sessions?.[sessionId];
      if (!session) return false;
      if (requireStandalone && session.groupId) {
        throw Object.assign(new Error('Delete this bill from its group instead'), { statusCode: 409 });
      }
      if (actorId) {
        const actor = session.members?.find((member) => member.id === actorId && member.active !== false);
        if (!actor?.isHost) throw Object.assign(new Error('Only the session creator can delete this session'), { statusCode: 403 });
      }
      delete data.sessions[sessionId];
      markLocalRestaurantVisitSourceDeleted(data, sessionId, 'session', 'host_deleted');
      data.history = (data.history || []).filter((entry) => entry.id !== sessionId);
      Object.values(data.historyPointers || {}).forEach((pointers) => {
        if (!Array.isArray(pointers)) return;
        pointers.splice(0, pointers.length, ...pointers.filter((entry) => (entry.historyId || entry.id) !== sessionId));
      });
      Object.values(data.users || {}).forEach((user) => {
        if (Array.isArray(user.bills)) user.bills = user.bills.filter((entry) => entry.id !== sessionId);
      });
      writeDb(data);
      return true;
    }
    return (async () => {
      if (!sessionId) return false;
      const firestore = getFirestore();
      const sessionRef = firestore.collection('sessions').doc(sessionId);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(sessionRef);
        if (!snapshot.exists) return false;
        const session = snapshot.data();
        if (requireStandalone && session.groupId) {
          throw Object.assign(new Error('Delete this bill from its group instead'), { statusCode: 409 });
        }
        if (actorId) {
          const actor = session.members?.find((member) => member.id === actorId && member.active !== false);
          if (!actor?.isHost) throw Object.assign(new Error('Only the session creator can delete this session'), { statusCode: 403 });
        }
        const ownedCodeRef = await prepareOwnedRoomCodeDeletion(
          firestore, transaction, 'session', sessionId, session.code,
        );
        const memberUserIds = [...new Set((session.members || []).map((member) => (
          member.userId || member.uid || (!String(member.id || '').startsWith('member_') ? member.id : '')
        )).filter(Boolean))];
        transaction.delete(sessionRef);
        writeRestaurantVisitSourceDeletion(
          firestore, transaction, sessionId, 'session', 'host_deleted', Date.now(),
        );
        if (ownedCodeRef) transaction.delete(ownedCodeRef);
        transaction.delete(firestore.collection('history').doc(sessionId));
        memberUserIds.forEach((userId) => {
          transaction.delete(firestore.collection('users').doc(userId).collection('history').doc(sessionId));
        });
        return true;
      });
    })();
  },

  getAllSessions() {
    if (isTesting) {
      return readDb().sessions || {};
    }
    return (async () => {
      const snap = await getFirestore().collection('sessions').get();
      const sessions = {};
      snap.forEach((doc) => { sessions[doc.id] = doc.data(); });
      return sessions;
    })();
  },

  generateUniqueRoomCode(roomType, roomId) {
    if (isTesting) {
      const data = readDb();
      return createUniqueRoomCode(data, require('crypto').randomInt, { digits: roomType === 'session' ? 5 : 8 });
    }
    return (async () => {
      return reserveUniqueFirestoreRoomCode(getFirestore(), roomType, roomId);
    })();
  },

  activateRoomCode(roomType, roomId, code) {
    if (!['session', 'group'].includes(roomType) || !roomId || !code) return null;
    if (isTesting) return code;
    return (async () => {
      const firestore = getFirestore();
      const registryRef = firestore.collection('_room_codes').doc(String(code));
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(registryRef);
        if (!snapshot.exists) throw new Error('Room code reservation is missing');
        const entry = snapshot.data();
        if (entry.roomType !== roomType || entry.roomId !== roomId) {
          throw new Error('Room code reservation does not match the persisted room');
        }
        const now = Date.now();
        transaction.set(registryRef, {
          roomType,
          roomId,
          state: 'active',
          createdAt: entry.createdAt || now,
          activatedAt: now,
          reservationExpiresAt: null,
          expiresAt: null,
          admissionExpiresAt: roomType === 'session' ? now + SESSION_ADMISSION_TTL_MS : null,
        });
        return code;
      });
    })();
  },

  consumeDistributedRateLimit(namespace, rawKey, limit, windowMs) {
    const safeNamespace = String(namespace || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 50);
    const keyDigest = identityHmac(`rate:${safeNamespace}:${rawKey}`)
      || crypto.createHash('sha256').update(`rate:${safeNamespace}:${rawKey}`).digest('hex');
    const bucketId = `${safeNamespace}_${keyDigest.slice(0, 40)}`;
    const now = Date.now();
    if (isTesting) {
      const data = readDb();
      const previous = data.rateLimits[bucketId];
      const bucket = !previous || now >= Number(previous.expiresAt || 0)
        ? { count: 0, startedAt: now, expiresAt: now + windowMs }
        : previous;
      bucket.count += 1;
      data.rateLimits[bucketId] = bucket;
      writeDb(data);
      return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), retryAt: bucket.expiresAt };
    }
    return (async () => {
      const firestore = getFirestore();
      const ref = firestore.collection('_rate_limits').doc(bucketId);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const prior = snapshot.exists ? snapshot.data() : null;
        const priorExpiresAt = typeof prior?.expiresAt?.toMillis === 'function'
          ? prior.expiresAt.toMillis()
          : Number(prior?.expiresAt || 0);
        const retryAt = now + windowMs;
        const bucket = !prior || now >= priorExpiresAt
          ? {
              count: 0,
              startedAt: now,
              expiresAt: require('firebase-admin').firestore.Timestamp.fromMillis(retryAt),
            }
          : prior;
        bucket.count = Number(bucket.count || 0) + 1;
        transaction.set(ref, sanitizeFirestoreData(bucket));
        const effectiveRetryAt = typeof bucket.expiresAt?.toMillis === 'function'
          ? bucket.expiresAt.toMillis()
          : Number(bucket.expiresAt || retryAt);
        return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), retryAt: effectiveRetryAt };
      });
    })();
  },

  recordRestaurantVisit(session, member, observedAt = Date.now()) {
    const visit = buildRestaurantVisit(session, member, observedAt);
    if (!visit) return null;
    if (isTesting) {
      const data = readDb();
      applyLocalRestaurantVisits(data, session, [member], observedAt, { upsertRestaurant: false });
      writeDb(data);
      return visit;
    }
    return (async () => {
      const firestore = getFirestore();
      await firestore.runTransaction(async (transaction) => {
        const prepared = await prepareFirestoreRestaurantVisits(
          firestore, transaction, session, [member], observedAt, { upsertRestaurant: false },
        );
        writePreparedRestaurantVisits(transaction, prepared);
      });
      return visit;
    })();
  },

  addToHistory(historyRecord) {
    if (isTesting) {
      const data = readDb();
      const existingIndex = data.history.findIndex((h) => h.id === historyRecord.id);
      if (existingIndex === -1) data.history.unshift(historyRecord);
      else data.history[existingIndex] = { ...data.history[existingIndex], ...historyRecord };
      if (Array.isArray(historyRecord.members)) {
        historyRecord.members.forEach((m) => {
          const user = data.users?.[m.id];
          if (user) {
            if (!Array.isArray(user.bills)) user.bills = [];
            const idx = user.bills.findIndex((b) => b.id === historyRecord.id);
            if (idx === -1) user.bills.unshift(historyRecord);
            else user.bills[idx] = { ...user.bills[idx], ...historyRecord };
          }
        });
      }
      writeDb(data);
      return data.history;
    }
    return (async () => {
      const id = historyRecord.id;
      if (!id) return [];
      const db = getFirestore();
      const cleanRecord = sanitizeFirestoreData(historyRecord);
      await db.collection('history').doc(id).set(cleanRecord);
      if (Array.isArray(historyRecord.members)) {
        for (const member of historyRecord.members) {
          const userRef = db.collection('users').doc(member.id);
          const doc = await userRef.get();
          if (doc.exists) {
            const user = doc.data();
            if (!Array.isArray(user.bills)) user.bills = [];
            const idx = user.bills.findIndex((b) => b.id === historyRecord.id);
            if (idx === -1) user.bills.unshift(cleanRecord);
            else user.bills[idx] = { ...user.bills[idx], ...cleanRecord };
            await userRef.set(sanitizeFirestoreData(user), { merge: true });
          }
        }
      }
      return this.getHistory();
    })();
  },

  saveSessionAndHistory(session, historyRecord) {
    if (isTesting) {
      const data = readDb();
      data.sessions[session.id] = { ...session, updatedAt: Date.now() };
      const idx = data.history.findIndex((h) => h.id === historyRecord.id);
      if (idx === -1) data.history.unshift(historyRecord);
      else data.history[idx] = { ...data.history[idx], ...historyRecord };
      if (Array.isArray(historyRecord.members)) {
        historyRecord.members.forEach((m) => {
          const u = data.users?.[m.id];
          if (u) {
            if (!Array.isArray(u.bills)) u.bills = [];
            const bIdx = u.bills.findIndex((b) => b.id === historyRecord.id);
            if (bIdx === -1) u.bills.unshift(historyRecord);
            else u.bills[bIdx] = { ...u.bills[bIdx], ...historyRecord };
          }
        });
      }
      writeDb(data);
      return data.sessions[session.id];
    }
    return (async () => {
      const db = getFirestore();
      const batch = db.batch();
      const cleanSession = sanitizeFirestoreData({ ...session, updatedAt: Date.now() });
      const cleanHistory = sanitizeFirestoreData(historyRecord);
      batch.set(db.collection('sessions').doc(session.id), cleanSession, { merge: true });
      batch.set(db.collection('history').doc(historyRecord.id), cleanHistory);
      await batch.commit();

      if (Array.isArray(historyRecord.members)) {
        for (const member of historyRecord.members) {
          const userRef = db.collection('users').doc(member.id);
          const doc = await userRef.get();
          if (doc.exists) {
            const user = doc.data();
            if (!Array.isArray(user.bills)) user.bills = [];
            const idx = user.bills.findIndex((b) => b.id === historyRecord.id);
            if (idx === -1) user.bills.unshift(cleanHistory);
            else user.bills[idx] = { ...user.bills[idx], ...cleanHistory };
            await userRef.set(sanitizeFirestoreData(user), { merge: true });
          }
        }
      }
      return session;
    })();
  },

  getHistory() {
    if (isTesting) {
      return readDb().history || [];
    }
    return (async () => {
      const snap = await getFirestore().collection('history').get();
      const list = [];
      snap.forEach((doc) => { list.push(doc.data()); });
      list.sort((a, b) => {
        const timeA = a.createdAt || (a.date ? new Date(a.date).getTime() : 0);
        const timeB = b.createdAt || (b.date ? new Date(b.date).getTime() : 0);
        return timeB - timeA;
      });
      return list;
    })();
  },

  getHistoryForUser(uid, limit = 20, offset = 0) {
    if (!uid) return [];
    const safeLimit = Math.max(1, Math.min(21, Math.round(Number(limit) || 20)));
    const safeOffset = Math.max(0, Math.min(200, Math.round(Number(offset) || 0)));
    if (isTesting) {
      return (readDb().history || [])
        .filter((entry) => Array.isArray(entry.memberIds) && entry.memberIds.includes(uid))
        .sort((first, second) => Number(second.settledAt || second.createdAt || 0) - Number(first.settledAt || first.createdAt || 0))
        .slice(safeOffset, safeOffset + safeLimit);
    }
    return (async () => {
      const firestore = getFirestore();
      const snapshot = await firestore
        .collection('users')
        .doc(uid)
        .collection('history')
        .orderBy('settledAt', 'desc')
        .offset(safeOffset)
        .limit(safeLimit)
        .get();
      const pointers = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      const historyIds = [...new Set(pointers.map((entry) => entry.historyId || entry.id).filter(Boolean))];
      const canonicalSnapshots = historyIds.length
        ? await firestore.getAll(...historyIds.map((historyId) => firestore.collection('history').doc(historyId)))
        : [];
      const canonicalById = new Map(
        canonicalSnapshots.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data()]),
      );
      const entries = pointers.map((pointer) => (
        canonicalById.get(pointer.historyId || pointer.id)
        || (pointer.storeName ? pointer : null)
      )).filter(Boolean);
      entries.sort((first, second) => (
        Number(second.settledAt || second.createdAt || 0) - Number(first.settledAt || first.createdAt || 0)
      ));
      return entries;
    })();
  },

  getHistoryPageForUser(uid, limit = 20, offset = 0) {
    if (!uid) return { slots: [], rawCount: 0 };
    const safeLimit = Math.max(1, Math.min(21, Math.round(Number(limit) || 20)));
    const safeOffset = Math.max(0, Math.min(200, Math.round(Number(offset) || 0)));
    if (isTesting) {
      const data = readDb();
      const testPointers = data.historyPointers?.[uid];
      if (Array.isArray(testPointers)) {
        const pointers = testPointers.slice(safeOffset, safeOffset + safeLimit);
        const canonicalById = new Map((data.history || []).map((entry) => [entry.id, entry]));
        return {
          slots: pointers.map((pointer) => canonicalById.get(pointer.historyId || pointer.id) || (pointer.storeName ? pointer : null)),
          rawCount: pointers.length,
        };
      }
      const slots = (data.history || [])
        .filter((entry) => Array.isArray(entry.memberIds) && entry.memberIds.includes(uid))
        .sort((first, second) => Number(second.settledAt || second.createdAt || 0) - Number(first.settledAt || first.createdAt || 0))
        .slice(safeOffset, safeOffset + safeLimit);
      return { slots, rawCount: slots.length };
    }
    return (async () => {
      const firestore = getFirestore();
      const snapshot = await firestore
        .collection('users')
        .doc(uid)
        .collection('history')
        .orderBy('settledAt', 'desc')
        .offset(safeOffset)
        .limit(safeLimit)
        .get();
      const pointers = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      const historyIds = [...new Set(pointers.map((entry) => entry.historyId || entry.id).filter(Boolean))];
      const canonicalSnapshots = historyIds.length
        ? await firestore.getAll(...historyIds.map((historyId) => firestore.collection('history').doc(historyId)))
        : [];
      const canonicalById = new Map(
        canonicalSnapshots.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data()]),
      );
      return {
        slots: pointers.map((pointer) => (
          canonicalById.get(pointer.historyId || pointer.id)
          || (pointer.storeName ? pointer : null)
        )),
        rawCount: pointers.length,
      };
    })();
  },

  getResolvableHistoryPointerIds(uid, historyIds) {
    const safeIds = [...new Set((Array.isArray(historyIds) ? historyIds : [])
      .map((id) => String(id || ''))
      .filter((id) => id && id.length <= 150 && !id.includes('/')))]
      .slice(0, 200);
    if (!uid || safeIds.length === 0) return [];
    if (isTesting) {
      const data = readDb();
      const testPointers = data.historyPointers?.[uid];
      if (Array.isArray(testPointers)) {
        const canonicalIds = new Set((data.history || []).map((entry) => entry.id));
        return safeIds.filter((id) => {
          const pointer = testPointers.find((entry) => (entry.historyId || entry.id) === id || entry.id === id);
          return Boolean(pointer && (pointer.storeName || canonicalIds.has(pointer.historyId || pointer.id)));
        });
      }
      const indexedIds = new Set((data.history || [])
        .filter((entry) => Array.isArray(entry.memberIds) && entry.memberIds.includes(uid))
        .map((entry) => entry.id));
      return safeIds.filter((id) => indexedIds.has(id));
    }
    return (async () => {
      const firestore = getFirestore();
      const pointerSnapshots = await firestore.getAll(...safeIds.map((historyId) => (
        firestore.collection('users').doc(uid).collection('history').doc(historyId)
      )));
      const pointers = pointerSnapshots
        .filter((doc) => doc.exists)
        .map((doc) => ({ id: doc.id, ...doc.data() }));
      const canonicalIds = [...new Set(pointers
        .filter((pointer) => !pointer.storeName)
        .map((pointer) => pointer.historyId || pointer.id)
        .filter(Boolean))];
      const canonicalSnapshots = canonicalIds.length
        ? await firestore.getAll(...canonicalIds.map((historyId) => firestore.collection('history').doc(historyId)))
        : [];
      const resolvableCanonicalIds = new Set(
        canonicalSnapshots.filter((doc) => doc.exists).map((doc) => doc.id),
      );
      return pointers
        .filter((pointer) => pointer.storeName || resolvableCanonicalIds.has(pointer.historyId || pointer.id))
        .map((pointer) => pointer.id);
    })();
  },

  getDeletedSessionSourceIds(sessionIds) {
    const safeIds = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
      .map((id) => String(id || ''))
      .filter((id) => id && id.length <= 150 && !id.includes('/')))]
      .slice(0, 200);
    if (safeIds.length === 0) return [];
    if (isTesting) {
      const deletions = readDb().restaurantVisitSourceDeletions || {};
      return safeIds.filter((id) => Boolean(deletions[id]));
    }
    return (async () => {
      const firestore = getFirestore();
      const snapshots = await firestore.getAll(...safeIds.map((id) => (
        firestore.collection('restaurant_visit_source_deletions').doc(id)
      )));
      return snapshots.filter((snapshot) => snapshot.exists).map((snapshot) => snapshot.id);
    })();
  },

  deleteHistory(id) {
    if (isTesting) {
      const data = readDb();
      data.history = (data.history || []).filter((h) => h.id !== id);
      Object.keys(data.users || {}).forEach((k) => {
        if (Array.isArray(data.users[k].bills)) {
          data.users[k].bills = data.users[k].bills.filter((b) => b.id !== id);
        }
      });
      writeDb(data);
      return data.history;
    }
    return (async () => {
      const db = getFirestore();
      await db.collection('history').doc(id).delete();
      const usersSnap = await db.collection('users').get();
      for (const doc of usersSnap.docs) {
        const user = doc.data();
        if (Array.isArray(user.bills)) {
          const filtered = user.bills.filter((b) => b.id !== id);
          await db.collection('users').doc(doc.id).update({ bills: filtered });
        }
      }
      return this.getHistory();
    })();
  },

  hideHistoryForUser(uid, historyId) {
    if (isTesting) {
      const data = readDb();
      const user = data.users?.[uid];
      if (!user) return null;
      if (!Array.isArray(user.hiddenHistoryIds)) user.hiddenHistoryIds = [];
      if (!user.hiddenHistoryIds.includes(historyId)) user.hiddenHistoryIds.push(historyId);
      user.updatedAt = Date.now();
      writeDb(data);
      return user;
    }
    return (async () => {
      if (!uid || !historyId) return null;
      const db = getFirestore();
      const userRef = db.collection('users').doc(uid);
      const doc = await userRef.get();
      if (!doc.exists) return null;
      const user = doc.data();
      const fieldValue = require('firebase-admin').firestore.FieldValue;
      await userRef.update({
        hiddenHistoryIds: fieldValue.arrayUnion(historyId),
        updatedAt: Date.now(),
      });
      return {
        ...user,
        hiddenHistoryIds: [...new Set([...(user.hiddenHistoryIds || []), historyId])],
      };
    })();
  },

  hideGroupForUser(uid, groupId) {
    if (isTesting) {
      const data = readDb();
      const user = data.users?.[uid];
      if (!user) return null;
      user.hiddenGroupIds = [...new Set([...(user.hiddenGroupIds || []), groupId])];
      user.updatedAt = Date.now();
      writeDb(data);
      return user;
    }
    return (async () => {
      if (!uid || !groupId) return null;
      const firestore = getFirestore();
      const userRef = firestore.collection('users').doc(uid);
      const doc = await userRef.get();
      if (!doc.exists) return null;
      const fieldValue = require('firebase-admin').firestore.FieldValue;
      await userRef.update({
        hiddenGroupIds: fieldValue.arrayUnion(groupId),
        updatedAt: Date.now(),
      });
      return { ...doc.data(), hiddenGroupIds: [...new Set([...(doc.data().hiddenGroupIds || []), groupId])] };
    })();
  },

  getGroup(idOrCode) {
    if (isTesting) {
      const data = readDb();
      if (data.groups[idOrCode]) return data.groups[idOrCode];
      return Object.values(data.groups).find((g) => g.code === idOrCode || g.id === idOrCode) || null;
    }
    return (async () => {
      if (!idOrCode) return null;
      const doc = await getFirestore().collection('groups').doc(idOrCode).get();
      if (doc.exists) return doc.data();
      const firestore = getFirestore();
      const registered = await getRegisteredRoom(firestore, 'group', idOrCode);
      if (registered) return registered;
      const snap = await firestore.collection('groups').where('code', '==', idOrCode).limit(1).get();
      return snap.empty ? null : snap.docs[0].data();
    })();
  },

  saveGroup(group) {
    assertGroupStorageBudget(group);
    if (isTesting) {
      const data = readDb();
      const id = group.id;
      if (!id) return null;
      data.groups[id] = { ...group, updatedAt: Date.now() };
      if (Array.isArray(group.members)) {
        group.members.forEach((member) => {
          if (member.active === false) return;
          const targetUid = member.uid || member.id;
          const user = data.users[targetUid] || data.users[member.id];
          if (user) {
            if (!Array.isArray(user.groups)) user.groups = [];
            if (!user.groups.includes(id)) user.groups.push(id);
          }
        });
      }
      writeDb(data);
      return data.groups[id];
    }
    return (async () => {
      const id = group.id;
      if (!id) return null;
      const db = getFirestore();
      const data = sanitizeFirestoreData({ ...group, updatedAt: Date.now() });
      await db.runTransaction(async (transaction) => {
        const activation = await prepareRoomCodeActivation(db, transaction, 'group', id, group.code);
        transaction.set(db.collection('groups').doc(id), data, { merge: true });
        if (activation) transaction.set(activation.ref, activation.value);
      });
      if (Array.isArray(group.members)) {
        for (const member of group.members) {
          if (member.active === false) continue;
          const targetUid = member.uid || member.id;
          const userRef = db.collection('users').doc(targetUid);
          const doc = await userRef.get();
          if (doc.exists) {
            const u = doc.data();
            if (!Array.isArray(u.groups)) u.groups = [];
            if (!u.groups.includes(group.id)) {
              u.groups.push(group.id);
              await userRef.update({ groups: u.groups, updatedAt: Date.now() });
            }
          }
        }
      }
      return data;
    })();
  },

  saveGroupAndSession(group, session) {
    assertGroupStorageBudget(group);
    assertSessionStorageBudget(session);
    if (isTesting) {
      const data = readDb();
      const updatedAt = Date.now();
      data.groups[group.id] = { ...group, updatedAt };
      data.sessions[session.id] = { ...session, updatedAt };
      if (Array.isArray(group.members)) {
        group.members.forEach((m) => {
          const targetUid = m.uid || m.id;
          const u = data.users[targetUid] || data.users[m.id];
          if (u && m.active !== false) {
            if (!Array.isArray(u.groups)) u.groups = [];
            if (!u.groups.includes(group.id)) u.groups.push(group.id);
          }
        });
      }
      writeDb(data);
      return { group: data.groups[group.id], session: data.sessions[session.id] };
    }
    return (async () => {
      const db = getFirestore();
      const batch = db.batch();
      const updatedAt = Date.now();
      const cleanGroup = sanitizeFirestoreData({ ...group, updatedAt });
      const cleanSession = sanitizeFirestoreData({ ...session, updatedAt });
      batch.set(db.collection('groups').doc(group.id), cleanGroup, { merge: true });
      batch.set(db.collection('sessions').doc(session.id), cleanSession, { merge: true });
      await batch.commit();

      if (Array.isArray(group.members)) {
        for (const member of group.members) {
          if (member.active === false) continue;
          const targetUid = member.uid || member.id;
          const userRef = db.collection('users').doc(targetUid);
          const doc = await userRef.get();
          if (doc.exists) {
            const u = doc.data();
            if (!Array.isArray(u.groups)) u.groups = [];
            if (!u.groups.includes(group.id)) {
              u.groups.push(group.id);
              await userRef.update({ groups: u.groups, updatedAt: Date.now() });
            }
          }
        }
      }
      return { group, session };
    })();
  },

  saveGroupBillAndSession(groupId, bill, session, actorId, expectedRevision = null, {
    restaurantVisitMembers = [],
    restaurantProofId = '',
  } = {}) {
    if (isTesting) {
      const data = readDb();
      claimLocalRestaurantProof(data, restaurantProofId, session.id);
      const currentGroup = data.groups[groupId];
      if (!currentGroup) return null;
      assertGroupActive(currentGroup);
      const currentSession = data.sessions[session.id];
      if (data.restaurantVisitSourceDeletions?.[session.id]) {
        throw Object.assign(new Error('A deleted group bill cannot be recreated with the same identifier.'), { statusCode: 409 });
      }
      if (currentSession?.status === 'settled') {
        const error = new Error('A settled session cannot be attached or edited');
        error.statusCode = 409;
        throw error;
      }
      if (currentSession?.members?.some((member) => member.active !== false && member.settled === true)) {
        const error = new Error('Payment allocations are locked while a member is marked paid');
        error.statusCode = 409;
        throw error;
      }
      if (currentSession?.groupId && (
        currentSession.groupId !== groupId
        || (currentSession.billId && currentSession.billId !== bill.id)
      )) {
        const error = new Error('This session is already attached to another group bill');
        error.statusCode = 409;
        throw error;
      }
      const currentActor = Array.isArray(currentGroup.members)
        ? currentGroup.members.find((member) => member.id === actorId && member.active !== false)
        : null;
      if (!currentActor) {
        const error = new Error('A valid group membership is required');
        error.statusCode = 401;
        throw error;
      }
      if (!Array.isArray(currentGroup.bills)) currentGroup.bills = [];
      const billIndex = currentGroup.bills.findIndex((candidate) => candidate.id === bill.id);
      const currentBill = billIndex >= 0 ? currentGroup.bills[billIndex] : null;
      if (currentBill && expectedRevision === null && bill.contentDigest && currentBill.contentDigest === bill.contentDigest) {
        return { group: currentGroup, session: currentSession, idempotentReplay: true };
      }
      if (currentBill && (expectedRevision === null || Number(currentBill.revision || 0) !== expectedRevision)) {
        const error = new Error('This bill changed while it was being edited. Reopen it and apply your changes again.');
        error.statusCode = 409;
        throw error;
      }
      if (currentBill && getBillStatus(currentBill) !== BILL_STATUS.ACTIVE) {
        const error = new Error(
          getBillStatus(currentBill) === BILL_STATUS.FINALIZED
            ? 'A finalized bill cannot be edited until it is reopened'
            : 'A settled bill cannot be edited'
        );
        error.statusCode = 409;
        throw error;
      }
      if (currentBill && !currentActor.isHost && currentBill.createdByMemberId !== actorId) {
        const error = new Error('Only the bill creator or group host can edit this bill');
        error.statusCode = 403;
        throw error;
      }
      const merged = mergeConcurrentBillState(bill, session, currentBill, currentSession, currentGroup);
      if (billIndex >= 0) currentGroup.bills[billIndex] = merged.bill;
      else currentGroup.bills.unshift(merged.bill);
      assertGroupStorageBudget(currentGroup);
      assertSessionStorageBudget(merged.session);
      const updatedAt = Date.now();
      data.groups[groupId] = { ...currentGroup, updatedAt };
      data.sessions[session.id] = { ...merged.session, updatedAt };
      applyLocalRestaurantVisits(data, merged.session, restaurantVisitMembers, updatedAt);
      writeDb(data);
      return { group: data.groups[groupId], session: data.sessions[session.id] };
    }
    return (async () => {
      const firestore = getFirestore();
      const groupRef = firestore.collection('groups').doc(groupId);
      const sessionRef = firestore.collection('sessions').doc(session.id);
      return firestore.runTransaction(async (transaction) => {
        const groupSnapshot = await transaction.get(groupRef);
        if (!groupSnapshot.exists) return null;
        const sessionSnapshot = await transaction.get(sessionRef);
        const currentSession = sessionSnapshot.exists ? sessionSnapshot.data() : null;
        const deletionRef = firestore.collection('restaurant_visit_source_deletions').doc(session.id);
        const deletionSnapshot = await transaction.get(deletionRef);
        const proofUse = await prepareFirestoreRestaurantProofUse(
          firestore, transaction, restaurantProofId, session.id,
        );
        if (deletionSnapshot.exists) {
          throw Object.assign(new Error('A deleted group bill cannot be recreated with the same identifier.'), { statusCode: 409 });
        }
        const codeActivation = !currentSession
          ? await prepareRoomCodeActivation(firestore, transaction, 'session', session.id, session.code)
          : null;
        if (currentSession?.status === 'settled') {
          const error = new Error('A settled session cannot be attached or edited');
          error.statusCode = 409;
          throw error;
        }
        if (currentSession?.members?.some((member) => member.active !== false && member.settled === true)) {
          const error = new Error('Payment allocations are locked while a member is marked paid');
          error.statusCode = 409;
          throw error;
        }
        if (currentSession?.groupId && (
          currentSession.groupId !== groupId
          || (currentSession.billId && currentSession.billId !== bill.id)
        )) {
          const error = new Error('This session is already attached to another group bill');
          error.statusCode = 409;
          throw error;
        }
        const currentGroup = groupSnapshot.data();
        assertGroupActive(currentGroup);
        const currentActor = Array.isArray(currentGroup.members)
          ? currentGroup.members.find((member) => member.id === actorId && member.active !== false)
          : null;
        if (!currentActor) {
          const error = new Error('A valid group membership is required');
          error.statusCode = 401;
          throw error;
        }
        const bills = Array.isArray(currentGroup.bills) ? [...currentGroup.bills] : [];
        const billIndex = bills.findIndex((candidate) => candidate.id === bill.id);
        const currentBill = billIndex >= 0 ? bills[billIndex] : null;
        if (currentBill && expectedRevision === null && bill.contentDigest && currentBill.contentDigest === bill.contentDigest) {
          return { group: currentGroup, session: currentSession, idempotentReplay: true };
        }
        if (currentBill && (expectedRevision === null || Number(currentBill.revision || 0) !== expectedRevision)) {
          const error = new Error('This bill changed while it was being edited. Reopen it and apply your changes again.');
          error.statusCode = 409;
          throw error;
        }
        if (currentBill && getBillStatus(currentBill) !== BILL_STATUS.ACTIVE) {
          const error = new Error(
            getBillStatus(currentBill) === BILL_STATUS.FINALIZED
              ? 'A finalized bill cannot be edited until it is reopened'
              : 'A settled bill cannot be edited'
          );
          error.statusCode = 409;
          throw error;
        }
        if (currentBill && !currentActor.isHost && currentBill.createdByMemberId !== actorId) {
          const error = new Error('Only the bill creator or group host can edit this bill');
          error.statusCode = 403;
          throw error;
        }
        const merged = mergeConcurrentBillState(bill, session, currentBill, currentSession, currentGroup);
        if (billIndex >= 0) bills[billIndex] = merged.bill;
        else bills.unshift(merged.bill);
        assertGroupStorageBudget({ ...currentGroup, bills });
        assertSessionStorageBudget(merged.session);
        const updatedAt = Date.now();
        const cleanGroup = sanitizeFirestoreData({ ...currentGroup, bills, updatedAt });
        const cleanSession = sanitizeFirestoreData({ ...merged.session, updatedAt });
        const restaurantWrites = await prepareFirestoreRestaurantVisits(
          firestore, transaction, cleanSession, restaurantVisitMembers, updatedAt,
        );
        transaction.set(groupRef, cleanGroup);
        transaction.set(sessionRef, cleanSession, { merge: true });
        if (codeActivation) transaction.set(codeActivation.ref, codeActivation.value);
        writePreparedRestaurantVisits(transaction, restaurantWrites);
        if (proofUse) transaction.set(proofUse.ref, sanitizeFirestoreData(proofUse.value));
        return { group: cleanGroup, session: cleanSession };
      });
    })();
  },

  getAllGroups() {
    if (isTesting) {
      return readDb().groups || {};
    }
    return (async () => {
      const snap = await getFirestore().collection('groups').get();
      const groups = {};
      snap.forEach((doc) => { groups[doc.id] = doc.data(); });
      return groups;
    })();
  },

  leaveGroup(groupId, memberId) {
    if (isTesting) {
      const data = readDb();
      const group = data.groups?.[groupId];
      if (!group) return null;
      assertGroupActive(group);
      const member = (group.members || []).find((m) => m.id === memberId || (m.userId && m.userId === memberId));
      if (!member) return group;
      if ((group.members || []).length <= 1) {
        const error = new Error('The last member cannot leave the group; delete the group instead');
        error.statusCode = 409;
        throw error;
      }
      const settlementStartedInLinkedSession = (group.bills || []).some((bill) => {
        const linkedSession = bill.sessionId ? data.sessions?.[bill.sessionId] : null;
        return linkedSession?.status !== 'settled'
          && linkedSession?.members?.some((candidate) => candidate.active !== false && candidate.settled === true);
      });
      if (settlementStartedInLinkedSession) {
        const error = new Error('Members cannot leave while a linked split is being finished. Reopen the split first.');
        error.statusCode = 409;
        throw error;
      }
      const hasActiveFinancialRole = (group.bills || []).some((bill) => (
        bill.status !== 'settled'
        && (
          bill.payerId === member.id
          || (bill.items || []).some((item) => item.claimedBy?.includes(member.id))
          || ((bill.items || []).length === 0 && Number(bill.amount || 0) > 0)
        )
      ));
      if (hasActiveFinancialRole) {
        const error = new Error('Settle or reassign this member’s active bill shares before they leave the group');
        error.statusCode = 409;
        throw error;
      }
      group.members = (group.members || []).filter((m) => m.id !== member.id && m.id !== memberId);
      (group.bills || []).forEach((bill) => {
        if (Array.isArray(bill.settledMemberIds)) {
          bill.settledMemberIds = bill.settledMemberIds.filter((id) => id !== member.id && id !== memberId);
        }
      });
      if (member.isHost && group.members.length > 0) {
        group.members[0].isHost = true;
      }
      group.updatedAt = Date.now();
      (group.bills || []).forEach((bill) => {
        const session = data.sessions?.[bill.sessionId];
        if (session && Array.isArray(session.members)) {
          session.members = synchronizeSessionMembersWithGroup(session, group.members);
          session.updatedAt = Date.now();
        }
      });
      const user = data.users?.[memberId];
      if (user?.groups) user.groups = user.groups.filter((id) => id !== groupId);
      writeDb(data);
      return group;
    }
    return (async () => {
      const firestore = getFirestore();
      const groupRef = firestore.collection('groups').doc(groupId);
      return firestore.runTransaction(async (transaction) => {
        const groupDoc = await transaction.get(groupRef);
        if (!groupDoc.exists) return null;
        const group = groupDoc.data();
        assertGroupActive(group);
        const member = (group.members || []).find((m) => m.id === memberId || (m.userId && m.userId === memberId));
        if (!member) return group;
        if ((group.members || []).length <= 1) {
          const error = new Error('The last member cannot leave the group; delete the group instead');
          error.statusCode = 409;
          throw error;
        }
        const hasActiveFinancialRole = (group.bills || []).some((bill) => (
          bill.status !== 'settled'
          && (
            bill.payerId === member.id
            || (bill.items || []).some((item) => item.claimedBy?.includes(member.id))
            || ((bill.items || []).length === 0 && Number(bill.amount || 0) > 0)
          )
        ));
        if (hasActiveFinancialRole) {
          const error = new Error('Settle or reassign this member’s active bill shares before they leave the group');
          error.statusCode = 409;
          throw error;
        }

        const sessionRefs = (group.bills || [])
          .filter((bill) => bill.sessionId)
          .map((bill) => firestore.collection('sessions').doc(bill.sessionId));
        const sessionDocs = [];
        for (const sessionRef of sessionRefs) sessionDocs.push(await transaction.get(sessionRef));
        const userRef = firestore.collection('users').doc(member.id);
        const userDoc = await transaction.get(userRef);

        const settlementStartedInLinkedSession = sessionDocs.some((sessionDoc) => {
          if (!sessionDoc.exists) return false;
          const linkedSession = sessionDoc.data();
          return linkedSession?.status !== 'settled'
            && linkedSession?.members?.some((candidate) => candidate.active !== false && candidate.settled === true);
        });
        if (settlementStartedInLinkedSession) {
          const error = new Error('Members cannot leave while a linked split is being finished. Reopen the split first.');
          error.statusCode = 409;
          throw error;
        }

        group.members = (group.members || []).filter((candidate) => candidate.id !== member.id && candidate.id !== memberId);
        (group.bills || []).forEach((bill) => {
          if (Array.isArray(bill.settledMemberIds)) {
            bill.settledMemberIds = bill.settledMemberIds.filter((id) => id !== member.id && id !== memberId);
          }
        });
        if (member.isHost && group.members.length > 0) group.members[0].isHost = true;
        const updatedAt = Date.now();
        group.updatedAt = updatedAt;
        transaction.set(groupRef, sanitizeFirestoreData(group));
        sessionDocs.forEach((sessionDoc, index) => {
          if (!sessionDoc.exists) return;
          const session = sessionDoc.data();
          session.members = synchronizeSessionMembersWithGroup(session, group.members);
          session.updatedAt = updatedAt;
          transaction.set(sessionRefs[index], sanitizeFirestoreData(session));
        });
        if (userDoc.exists) {
          const user = userDoc.data();
          user.groups = (Array.isArray(user.groups) ? user.groups : []).filter((id) => id !== groupId);
          transaction.set(userRef, sanitizeFirestoreData(user), { merge: true });
        }
        return group;
      });
    })();
  },

  resumeGroupDeletion(groupId) {
    if (!groupId || isTesting) return false;
    return resumeFirestoreGroupDeletion(getFirestore(), groupId);
  },

  resumePendingGroupDeletions(limit = 5) {
    if (isTesting) return [];
    return (async () => {
      const firestore = getFirestore();
      const snapshot = await firestore.collection('_group_deletions')
        .orderBy('createdAt', 'asc')
        .limit(Math.max(1, Math.min(20, Number(limit) || 5)))
        .get();
      const resumed = [];
      for (const doc of snapshot.docs) {
        await resumeFirestoreGroupDeletion(firestore, doc.id);
        resumed.push(doc.id);
      }
      return resumed;
    })();
  },

  deleteGroup(groupId, actorId) {
    if (isTesting) {
      const data = readDb();
      const group = data.groups?.[groupId];
      if (!group) return null;
      if (getGroupStatus(group) === GROUP_STATUS.SETTLING) {
        throw Object.assign(new Error('Finish or reopen the group settlement before deleting this group'), { statusCode: 409 });
      }
      const actor = group.members?.find((member) => member.id === actorId && member.active !== false);
      if (!actor?.isHost) throw Object.assign(new Error('Only the group host can delete this group'), { statusCode: 403 });
      (group.bills || []).forEach((b) => {
        if (b.sessionId && data.sessions) {
          delete data.sessions[b.sessionId];
          markLocalRestaurantVisitSourceDeleted(data, b.sessionId, 'group_session', 'group_deleted');
          data.history = (data.history || []).filter((entry) => entry.id !== b.sessionId);
          Object.values(data.historyPointers || {}).forEach((pointers) => {
            if (!Array.isArray(pointers)) return;
            pointers.splice(0, pointers.length, ...pointers.filter((entry) => (
              (entry.historyId || entry.id) !== b.sessionId
            )));
          });
          Object.values(data.users || {}).forEach((user) => {
            if (Array.isArray(user.bills)) user.bills = user.bills.filter((entry) => entry.id !== b.sessionId);
          });
        }
      });
      delete data.groups[groupId];
      Object.values(data.users || {}).forEach((u) => {
        if (Array.isArray(u.groups)) u.groups = u.groups.filter((id) => id !== groupId);
      });
      writeDb(data);
      return group;
    }
    return (async () => {
      const firestore = getFirestore();
      const groupRef = firestore.collection('groups').doc(groupId);
      const deletionRef = firestore.collection('_group_deletions').doc(groupId);
      const deletedGroup = await firestore.runTransaction(async (transaction) => {
        const groupDoc = await transaction.get(groupRef);
        if (!groupDoc.exists) return null;
        const group = groupDoc.data();
        if (getGroupStatus(group) === GROUP_STATUS.SETTLING) {
          throw Object.assign(new Error('Finish or reopen the group settlement before deleting this group'), { statusCode: 409 });
        }
        const actor = group.members?.find((member) => member.id === actorId && member.active !== false);
        if (!actor?.isHost) throw Object.assign(new Error('Only the group host can delete this group'), { statusCode: 403 });
        const sessionIds = [...new Set((group.bills || []).map((bill) => bill.sessionId).filter(Boolean))];
        const ownedGroupCodeRef = await prepareOwnedRoomCodeDeletion(
          firestore, transaction, 'group', groupId, group.code,
        );
        const deletionPlan = {
          groupId,
          sessionIds,
          groupUserIds: [...new Set((group.members || []).map(memberAccountId).filter(Boolean))],
          memberUserIdsBySession: {},
          createdAt: Date.now(),
        };
        transaction.set(deletionRef, sanitizeFirestoreData(deletionPlan));
        for (const sessionId of sessionIds) {
          writeRestaurantVisitSourceDeletion(
            firestore, transaction, sessionId, 'group_session', 'group_deleted', Date.now(),
          );
        }
        transaction.delete(groupRef);
        if (ownedGroupCodeRef) transaction.delete(ownedGroupCodeRef);
        return group;
      });
      if (!deletedGroup) return null;
      await resumeFirestoreGroupDeletion(firestore, groupId);
      return deletedGroup;
    })();
  },

  deleteGroupBill(groupId, billId, actorId) {
    if (isTesting) {
      const data = readDb();
      if (!data.groups || !data.groups[groupId]) return null;
      const group = data.groups[groupId];
      if (!Array.isArray(group.bills)) return null;
      assertGroupActive(group);
      const bill = group.bills.find((b) => b.id === billId);
      if (!bill) return null;
      const actor = group.members?.find((member) => member.id === actorId && member.active !== false);
      if (!actor) throw Object.assign(new Error('A valid group membership is required'), { statusCode: 401 });
      if (!actor.isHost && bill.createdByMemberId !== actor.id) {
        throw Object.assign(new Error('Only the bill creator or group host can delete this bill'), { statusCode: 403 });
      }
      const linkedSession = bill.sessionId ? data.sessions?.[bill.sessionId] : null;
      if (getBillStatus(bill) !== BILL_STATUS.ACTIVE || linkedSession?.members?.some((member) => member.active !== false && member.settled === true)) {
        throw Object.assign(new Error('A finalized, paid, or settled bill cannot be deleted'), { statusCode: 409 });
      }
      group.bills = group.bills.filter((b) => b.id !== billId);
      if (bill.sessionId && data.sessions) {
        delete data.sessions[bill.sessionId];
        markLocalRestaurantVisitSourceDeleted(data, bill.sessionId, 'group_session', 'bill_deleted');
      }
      group.updatedAt = Date.now();
      writeDb(data);
      return group;
    }
    return (async () => {
      const firestore = getFirestore();
      const groupRef = firestore.collection('groups').doc(groupId);
      return firestore.runTransaction(async (transaction) => {
        const doc = await transaction.get(groupRef);
        if (!doc.exists) return null;
        const group = doc.data();
        if (!Array.isArray(group.bills)) return null;
        assertGroupActive(group);
        const bill = group.bills.find((candidate) => candidate.id === billId);
        if (!bill) return null;
        const sessionRef = bill.sessionId ? firestore.collection('sessions').doc(bill.sessionId) : null;
        const sessionDoc = sessionRef ? await transaction.get(sessionRef) : null;
        const linkedSession = sessionDoc?.exists ? sessionDoc.data() : null;
        const actor = group.members?.find((member) => member.id === actorId && member.active !== false);
        if (!actor) throw Object.assign(new Error('A valid group membership is required'), { statusCode: 401 });
        if (!actor.isHost && bill.createdByMemberId !== actor.id) {
          throw Object.assign(new Error('Only the bill creator or group host can delete this bill'), { statusCode: 403 });
        }
        if (getBillStatus(bill) !== BILL_STATUS.ACTIVE || linkedSession?.members?.some((member) => member.active !== false && member.settled === true)) {
          throw Object.assign(new Error('A finalized, paid, or settled bill cannot be deleted'), { statusCode: 409 });
        }
        const ownedSessionCodeRef = sessionRef
          ? await prepareOwnedRoomCodeDeletion(
              firestore, transaction, 'session', sessionRef.id, linkedSession?.code,
            )
          : null;
        group.bills = group.bills.filter((candidate) => candidate.id !== billId);
        group.updatedAt = Date.now();
        transaction.set(groupRef, sanitizeFirestoreData(group));
        if (sessionRef) {
          transaction.delete(sessionRef);
          if (ownedSessionCodeRef) transaction.delete(ownedSessionCodeRef);
          writeRestaurantVisitSourceDeletion(
            firestore, transaction, sessionRef.id, 'group_session', 'bill_deleted', Date.now(),
          );
        }
        return group;
      });
    })();
  }
};

module.exports = db;
module.exports.db = db;
module.exports.default = db;
module.exports.__esModule = true;
module.exports.reserveUniqueFirestoreRoomCode = reserveUniqueFirestoreRoomCode;
module.exports.prepareOwnedRoomCodeDeletion = prepareOwnedRoomCodeDeletion;
module.exports.createBoundedFirestoreBatchWriter = createBoundedFirestoreBatchWriter;
module.exports.resolveExistingRestaurantVisitMembers = resolveExistingRestaurantVisitMembers;
