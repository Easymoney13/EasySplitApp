#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COLLECTIONS = ['users', 'sessions', 'groups', 'history'];
const ALLOWED_TOP_LEVEL_DIFFERENCES = {
  users: new Set(['updatedAt', 'username_lowercase']),
  sessions: new Set(['updatedAt']),
  groups: new Set(['updatedAt']),
  history: new Set(['updatedAt']),
};

function stableValue(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function comparableDocument(value, collectionName) {
  const result = stableValue(value);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const ignored = ALLOWED_TOP_LEVEL_DIFFERENCES[collectionName] || new Set();
  return Object.fromEntries(Object.entries(result).filter(([key]) => !ignored.has(key)));
}

function containsLocalState(remoteValue, localValue, collectionName = 'sessions') {
  return JSON.stringify(comparableDocument(remoteValue, collectionName))
    === JSON.stringify(comparableDocument(localValue, collectionName));
}

function timestampOf(document) {
  return Math.max(
    0,
    ...['updatedAt', 'settledAt', 'createdAt'].map((field) => {
      const value = document?.[field];
      if (value && typeof value.toMillis === 'function') return value.toMillis();
      const number = Number(value || 0);
      return Number.isFinite(number) ? number : 0;
    }),
  );
}

function opaqueId(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
}

function localCollection(localData, collectionName) {
  const value = localData?.[collectionName];
  const entries = collectionName === 'history'
    ? (Array.isArray(value) ? value : [])
    : Object.values(value || {});
  return new Map(entries.filter((entry) => entry?.id).map((entry) => [String(entry.id), entry]));
}

function compareDatasets(localData, remoteCollections) {
  const collections = {};
  let localMaxTimestamp = 0;
  let remoteMaxTimestamp = 0;
  let hasBlockingDifference = false;

  for (const collectionName of COLLECTIONS) {
    const local = localCollection(localData, collectionName);
    const remote = remoteCollections[collectionName] || new Map();
    const missing = [];
    const matching = [];
    const remoteNewer = [];
    const needsReview = [];

    for (const [id, localDocument] of local) {
      localMaxTimestamp = Math.max(localMaxTimestamp, timestampOf(localDocument));
      if (!remote.has(id)) {
        missing.push(opaqueId(id));
        continue;
      }
      const remoteDocument = remote.get(id);
      remoteMaxTimestamp = Math.max(remoteMaxTimestamp, timestampOf(remoteDocument));
      if (containsLocalState(remoteDocument, localDocument, collectionName)) {
        matching.push(opaqueId(id));
      } else {
        if (timestampOf(remoteDocument) > timestampOf(localDocument)) {
          remoteNewer.push(opaqueId(id));
        }
        needsReview.push(opaqueId(id));
      }
    }

    for (const remoteDocument of remote.values()) {
      remoteMaxTimestamp = Math.max(remoteMaxTimestamp, timestampOf(remoteDocument));
    }

    const remoteOnly = [...remote.keys()].filter((id) => !local.has(id)).map(opaqueId);
    if (missing.length || needsReview.length) hasBlockingDifference = true;
    collections[collectionName] = {
      local: local.size,
      firestore: remote.size,
      matching: matching.length,
      remoteNewer: remoteNewer.length,
      remoteOnly: remoteOnly.length,
      missing: missing.length,
      needsReview: needsReview.length,
      missingOpaqueIds: missing,
      needsReviewOpaqueIds: needsReview,
    };
  }

  return {
    collections,
    localMaxTimestamp,
    remoteMaxTimestamp,
    futureWritesObserved: remoteMaxTimestamp > localMaxTimestamp,
    safeToRetireLocalRuntimeDependency: !hasBlockingDifference,
  };
}

function initializeFirebaseAdmin(projectRoot) {
  const admin = require('firebase-admin');
  if (admin.apps.length) return admin;
  const projectId = process.env.FIREBASE_PROJECT_ID || 'easysplit-24576';
  if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
      projectId,
    });
    return admin;
  }

  const serviceAccountPath = path.resolve(
    projectRoot,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'firebase-service-account.json',
  );
  if (fs.existsSync(serviceAccountPath)) {
    admin.initializeApp({
      credential: admin.credential.cert(require(serviceAccountPath)),
      projectId,
    });
    return admin;
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
  return admin;
}

async function readFirestoreCollections(firestore) {
  return firestore.runTransaction(async (transaction) => {
    const snapshots = await Promise.all(
      COLLECTIONS.map((collectionName) => transaction.get(firestore.collection(collectionName))),
    );
    return Object.fromEntries(snapshots.map((snapshot, index) => [
      COLLECTIONS[index],
      new Map(snapshot.docs.map((document) => [document.id, document.data()])),
    ]));
  }, { readOnly: true });
}

async function runWriteProbe(firestore) {
  const probeId = `probe_${crypto.randomUUID()}`;
  const probeRef = firestore.collection('__easysplit_verification__').doc(probeId);
  let created = false;
  try {
    await probeRef.create({ purpose: 'firestore-write-verification', createdAt: Date.now() });
    created = true;
    const snapshot = await probeRef.get();
    if (!snapshot.exists || snapshot.data()?.purpose !== 'firestore-write-verification') {
      throw new Error('The verification record could not be read back');
    }
    return { write: true, read: true, cleanup: true };
  } finally {
    if (created) await probeRef.delete();
  }
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const dbPath = path.resolve(process.env.BILLSPLIT_DB_PATH || path.join(projectRoot, 'db.json'));
  if (!fs.existsSync(dbPath)) throw new Error(`Local database was not found at ${dbPath}`);
  const localData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const admin = initializeFirebaseAdmin(projectRoot);
  const firestore = admin.firestore();
  const remoteCollections = await readFirestoreCollections(firestore);
  const parity = compareDatasets(localData, remoteCollections);
  const writeProbe = process.argv.includes('--write-probe')
    ? await runWriteProbe(firestore)
    : { skipped: true };
  const result = {
    projectId: process.env.FIREBASE_PROJECT_ID || 'easysplit-24576',
    mode: 'read-only-parity-check',
    localFileWasModified: false,
    ...parity,
    writeProbe,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!parity.safeToRetireLocalRuntimeDependency || !parity.futureWritesObserved) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Firestore verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  COLLECTIONS,
  comparableDocument,
  compareDatasets,
  containsLocalState,
  initializeFirebaseAdmin,
  localCollection,
  opaqueId,
  readFirestoreCollections,
  timestampOf,
};
