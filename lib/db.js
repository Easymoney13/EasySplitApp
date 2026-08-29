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

function ensureDbExists() {
  if (!DB_PATH) {
    throw new Error('Local JSON storage requires an explicit BILLSPLIT_DB_PATH test fixture.');
  }
  if (!fs.existsSync(DB_PATH)) {
    const defaultData = { users: {}, sessions: {}, history: [], groups: {}, restaurants: {}, restaurantVisits: {} };
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
  if (entry.expiresAt && Number(entry.expiresAt) <= Date.now()) return null;
  const room = await firestore.collection(roomType === 'session' ? 'sessions' : 'groups').doc(entry.roomId).get();
  if (!room.exists) return null;
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
      await firestore.collection('_room_codes').doc(code).create({
        roomType,
        roomId,
        createdAt: Date.now(),
        ...(isSession ? { expiresAt: Date.now() + 6 * 60 * 60 * 1000 } : {}),
      });
      return code;
    } catch (error) {
      if (error?.code !== 6 && error?.code !== 'already-exists') throw error;
    }
  }
  const error = new Error('A room code could not be allocated safely. Please retry.');
  error.statusCode = 503;
  throw error;
}

function sanitizeFirestoreData(obj) {
  if (obj === null || obj === undefined) return null;
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
  return (Array.isArray(groupMembers) ? groupMembers : []).map((groupMember) => ({
    ...(existingMembers.get(groupMember.id) || {}),
    ...groupMember,
    settled: Boolean(existingMembers.get(groupMember.id)?.settled),
  }));
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
      if (!user) return null;
      if (!Array.isArray(user.groups)) user.groups = [];
      if (!user.groups.includes(groupId)) user.groups.push(groupId);
      user.updatedAt = Date.now();
      writeDb(data);
      return user;
    }
    return (async () => {
      const firestore = getFirestore();
      const userRef = firestore.collection('users').doc(uid);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(userRef);
        if (!snapshot.exists) return null;
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
      if (data.sessions[idOrCode]) return data.sessions[idOrCode];
      return Object.values(data.sessions).find((s) => s.code === idOrCode || s.id === idOrCode) || null;
    }
    return (async () => {
      if (!idOrCode) return null;
      const doc = await getFirestore().collection('sessions').doc(idOrCode).get();
      if (doc.exists) return doc.data();
      const firestore = getFirestore();
      const registered = await getRegisteredRoom(firestore, 'session', idOrCode);
      if (registered) return registered;
      if (/^\d{5}$/.test(String(idOrCode))) return null;
      const snap = await firestore.collection('sessions').where('code', '==', idOrCode).limit(1).get();
      return snap.empty ? null : snap.docs[0].data();
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

  createSessionIfAbsent(session) {
    assertSessionStorageBudget(session);
    if (isTesting) {
      const data = readDb();
      if (data.sessions[session.id]) return { created: false, session: data.sessions[session.id] };
      const stored = { ...session, updatedAt: Date.now() };
      data.sessions[session.id] = stored;
      writeDb(data);
      return { created: true, session: stored };
    }
    return (async () => {
      const firestore = getFirestore();
      const sessionRef = firestore.collection('sessions').doc(session.id);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(sessionRef);
        if (snapshot.exists) return { created: false, session: snapshot.data() };
        const stored = sanitizeFirestoreData({ ...session, updatedAt: Date.now() });
        transaction.create(sessionRef, stored);
        return { created: true, session: stored };
      });
    })();
  },

  transactSessionAndLinkedGroup(sessionId, transform) {
    if (isTesting) {
      const data = readDb();
      const currentSession = data.sessions[sessionId];
      if (!currentSession) return null;
      const currentGroup = currentSession.groupId ? data.groups[currentSession.groupId] || null : null;
      const result = transform(
        JSON.parse(JSON.stringify(currentSession)),
        currentGroup ? JSON.parse(JSON.stringify(currentGroup)) : null,
      );
      if (!result?.session) return null;
      const updatedAt = Date.now();
      assertSessionStorageBudget(result.session);
      if (result.group) assertGroupStorageBudget(result.group);
      data.sessions[sessionId] = { ...result.session, updatedAt };
      if (result.group) data.groups[result.group.id] = { ...result.group, updatedAt };
      if (result.history) {
        const historyIndex = data.history.findIndex((entry) => entry.id === result.history.id);
        if (historyIndex >= 0) data.history[historyIndex] = result.history;
        else data.history.unshift(result.history);
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
        const currentSession = sessionSnapshot.data();
        const groupRef = currentSession.groupId ? firestore.collection('groups').doc(currentSession.groupId) : null;
        const groupSnapshot = groupRef ? await transaction.get(groupRef) : null;
        const currentGroup = groupSnapshot?.exists ? groupSnapshot.data() : null;
        const result = transform(currentSession, currentGroup);
        if (!result?.session) return null;
        const updatedAt = Date.now();
        assertSessionStorageBudget(result.session);
        if (result.group) assertGroupStorageBudget(result.group);
        const cleanSession = sanitizeFirestoreData({ ...result.session, updatedAt });
        transaction.set(sessionRef, cleanSession);
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
        return { group: cleanGroup, session: cleanSession };
      });
    })();
  },

  deleteSession(sessionId) {
    if (isTesting) {
      const data = readDb();
      if (!data.sessions?.[sessionId]) return false;
      delete data.sessions[sessionId];
      writeDb(data);
      return true;
    }
    return (async () => {
      if (!sessionId) return false;
      const firestore = getFirestore();
      const sessionRef = firestore.collection('sessions').doc(sessionId);
      const snapshot = await sessionRef.get();
      if (!snapshot.exists) return false;
      const code = snapshot.data()?.code;
      const batch = firestore.batch();
      batch.delete(sessionRef);
      if (code) batch.delete(firestore.collection('_room_codes').doc(String(code)));
      await batch.commit();
      return true;
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

  recordRestaurantVisit(session, member, observedAt = Date.now()) {
    if (!session?.id || !session?.restaurant?.id || !member?.id) return null;
    const restaurant = session.restaurant;
    const canonicalUserId = member.userId
      || member.uid
      || (member.id && !String(member.id).startsWith('member_') ? member.id : '');
    const phoneHash = member.phone
      ? crypto.createHash('sha256').update(`phone:${member.phone}`).digest('hex')
      : '';
    const userKey = canonicalUserId
      ? `user:${canonicalUserId}`
      : phoneHash
        ? `phone:${phoneHash}`
        : member.clientIdentityHash
          ? `guest:${member.clientIdentityHash}`
          : `member:${member.id}`;
    const visitId = `visit_${crypto.createHash('sha256').update(`${session.id}:${userKey}`).digest('hex').slice(0, 32)}`;
    const visit = sanitizeFirestoreData({
      id: visitId,
      restaurantId: restaurant.id,
      sessionId: session.id,
      userKey,
      userId: canonicalUserId || undefined,
      memberId: member.id,
      displayNameSnapshot: member.name || 'Member',
      phoneHash: phoneHash || undefined,
      role: member.isHost ? 'host' : 'participant',
      joinedAt: Number(member.joinedAt || observedAt),
      lastSeenAt: observedAt,
      restaurantConfidence: Number(restaurant.confidence || 0),
      restaurantIdentityBasis: restaurant.identityBasis || 'unresolved',
    });
    if (isTesting) {
      const data = readDb();
      data.restaurants[restaurant.id] = {
        ...(data.restaurants[restaurant.id] || {}),
        ...restaurant,
        firstSeenAt: data.restaurants[restaurant.id]?.firstSeenAt || observedAt,
        lastSeenAt: observedAt,
      };
      data.restaurantVisits[visitId] = {
        ...(data.restaurantVisits[visitId] || {}),
        ...visit,
        joinedAt: data.restaurantVisits[visitId]?.joinedAt || visit.joinedAt,
      };
      writeDb(data);
      return visit;
    }
    return (async () => {
      const firestore = getFirestore();
      const restaurantRef = firestore.collection('restaurants').doc(restaurant.id);
      const visitRef = firestore.collection('restaurant_visits').doc(visitId);
      const batch = firestore.batch();
      batch.set(restaurantRef, sanitizeFirestoreData({
        ...restaurant,
        lastSeenAt: observedAt,
      }), { merge: true });
      batch.set(visitRef, visit, { merge: true });
      await batch.commit();
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
      if (!Array.isArray(user.hiddenHistoryIds)) user.hiddenHistoryIds = [];
      if (!user.hiddenHistoryIds.includes(historyId)) {
        user.hiddenHistoryIds.push(historyId);
        await userRef.update({ hiddenHistoryIds: user.hiddenHistoryIds, updatedAt: Date.now() });
      }
      return user;
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
      await db.collection('groups').doc(id).set(data, { merge: true });
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

  saveGroupBillAndSession(groupId, bill, session, actorId, expectedRevision = null) {
    if (isTesting) {
      const data = readDb();
      const currentGroup = data.groups[groupId];
      if (!currentGroup) return null;
      assertGroupActive(currentGroup);
      const currentSession = data.sessions[session.id];
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
        transaction.set(groupRef, cleanGroup);
        transaction.set(sessionRef, cleanSession, { merge: true });
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
        if (b.sessionId && data.sessions) delete data.sessions[b.sessionId];
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
      return firestore.runTransaction(async (transaction) => {
        const groupDoc = await transaction.get(groupRef);
        if (!groupDoc.exists) return null;
        const group = groupDoc.data();
        if (getGroupStatus(group) === GROUP_STATUS.SETTLING) {
          throw Object.assign(new Error('Finish or reopen the group settlement before deleting this group'), { statusCode: 409 });
        }
        const actor = group.members?.find((member) => member.id === actorId && member.active !== false);
        if (!actor?.isHost) throw Object.assign(new Error('Only the group host can delete this group'), { statusCode: 403 });
        transaction.delete(groupRef);
        for (const bill of group.bills || []) {
          if (bill.sessionId) transaction.delete(firestore.collection('sessions').doc(bill.sessionId));
        }
        const fieldValue = require('firebase-admin').firestore.FieldValue;
        for (const member of group.members || []) {
          const userId = member.userId || member.uid || (!String(member.id || '').startsWith('member_') ? member.id : '');
          if (!userId) continue;
          transaction.set(
            firestore.collection('users').doc(userId),
            { groups: fieldValue.arrayRemove(groupId), updatedAt: Date.now() },
            { merge: true },
          );
        }
        return group;
      });
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
      if (bill.sessionId && data.sessions) delete data.sessions[bill.sessionId];
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
        group.bills = group.bills.filter((candidate) => candidate.id !== billId);
        group.updatedAt = Date.now();
        transaction.set(groupRef, sanitizeFirestoreData(group));
        if (sessionRef) transaction.delete(sessionRef);
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
