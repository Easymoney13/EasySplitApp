#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getFirestore } = require('firebase-admin/firestore');

const {
  COLLECTIONS,
  containsLocalState,
  initializeFirebaseAdmin,
  localCollection,
  opaqueId,
  readFirestoreCollections,
} = require('./verify-firestore-parity');

function validateLocalData(localData) {
  const errors = [];
  const warnings = [];
  const expectedShapes = {
    users: 'object',
    sessions: 'object',
    groups: 'object',
    history: 'array',
  };
  for (const [name, shape] of Object.entries(expectedShapes)) {
    const value = localData?.[name];
    const valid = shape === 'array'
      ? Array.isArray(value)
      : value && typeof value === 'object' && !Array.isArray(value);
    if (!valid) errors.push(`${name}:invalid-root-shape`);
  }
  if (errors.length) return { ok: false, errors, warnings };

  for (const name of COLLECTIONS) {
    const value = localData[name];
    const entries = name === 'history' ? value : Object.values(value);
    const ids = entries.map((entry) => entry?.id && String(entry.id)).filter(Boolean);
    if (ids.length !== entries.length) errors.push(`${name}:missing-id`);
    if (new Set(ids).size !== ids.length) errors.push(`${name}:duplicate-id`);
    for (const entry of entries) {
      if (Buffer.byteLength(JSON.stringify(entry || {}), 'utf8') >= 1_000_000) {
        errors.push(`${name}:document-too-large`);
        break;
      }
    }
  }
  const legacyUserKeys = Object.entries(localData.users)
    .filter(([key, user]) => user?.id && String(user.id) !== key).length;
  if (legacyUserKeys) warnings.push(`users:legacy-root-key-mismatch:${legacyUserKeys}`);
  return { ok: errors.length === 0, errors, warnings };
}

function classifyCutover(localData, remoteCollections) {
  const local = Object.fromEntries(
    COLLECTIONS.map((name) => [name, localCollection(localData, name)]),
  );
  const exact = {};
  const conflicts = {};
  const missing = {};

  for (const name of COLLECTIONS) {
    const remote = remoteCollections[name] || new Map();
    exact[name] = [];
    conflicts[name] = [];
    missing[name] = [];
    for (const [id, document] of local[name]) {
      if (!remote.has(id)) missing[name].push(id);
      else if (containsLocalState(remote.get(id), document, name)) exact[name].push(id);
      else conflicts[name].push(id);
    }
  }

  const remoteHistory = remoteCollections.history || new Map();
  const archivedSessions = new Set(missing.sessions.filter((id) => {
    const localSession = local.sessions.get(id);
    const localHistory = local.history.get(id);
    return localSession?.status === 'settled'
      && localHistory?.status === 'settled'
      && remoteHistory.has(id)
      && containsLocalState(remoteHistory.get(id), localHistory, 'history');
  }));
  const archivedGroups = new Set(missing.groups.filter((id) => {
    const group = local.groups.get(id);
    const linkedSessionIds = (group?.bills || []).map((bill) => bill?.sessionId).filter(Boolean);
    const explicitlyDeleted = group?.status === 'deleted'
      || group?.deleted === true
      || Number.isFinite(Number(group?.deletedAt));
    return explicitlyDeleted
      && linkedSessionIds.length > 0
      && linkedSessionIds.every((sessionId) => archivedSessions.has(String(sessionId)));
  }));

  const archivedMissing = {
    users: [],
    sessions: [...archivedSessions],
    groups: [...archivedGroups],
    history: [],
  };
  const safeMissing = Object.fromEntries(COLLECTIONS.map((name) => {
    const archived = new Set(archivedMissing[name]);
    return [name, missing[name].filter((id) => !archived.has(id))];
  }));

  return {
    exact,
    conflicts,
    missing,
    archivedMissing,
    safeMissing,
    operationalParity: COLLECTIONS.every((name) => (
      conflicts[name].length === 0 && safeMissing[name].length === 0
    )),
  };
}

function publicSummary(classification) {
  const summarize = (source) => Object.fromEntries(COLLECTIONS.map((name) => [name, {
    count: source[name].length,
    opaqueIds: source[name].map(opaqueId),
  }]));
  return {
    exact: Object.fromEntries(COLLECTIONS.map((name) => [name, classification.exact[name].length])),
    conflicts: summarize(classification.conflicts),
    missing: summarize(classification.missing),
    archivedMissing: summarize(classification.archivedMissing),
    safeMissing: summarize(classification.safeMissing),
    operationalParity: classification.operationalParity,
  };
}

function snapshotDocument(fileBytes, localData) {
  const sha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');
  const compressed = zlib.gzipSync(fileBytes, { level: 9 });
  return {
    id: `dbjson_${sha256}`,
    data: {
      schemaVersion: 1,
      source: 'db.json',
      encoding: 'gzip-base64',
      sha256,
      byteLength: fileBytes.length,
      compressedByteLength: compressed.length,
      collectionCounts: Object.fromEntries(
        COLLECTIONS.map((name) => [name, localCollection(localData, name).size]),
      ),
      payload: compressed.toString('base64'),
      createdAt: Date.now(),
    },
  };
}

function verifySnapshotPayload(document) {
  if (document?.encoding !== 'gzip-base64' || typeof document.payload !== 'string') return false;
  const restored = zlib.gunzipSync(Buffer.from(document.payload, 'base64'));
  const checksum = crypto.createHash('sha256').update(restored).digest('hex');
  return checksum === document.sha256 && restored.length === document.byteLength;
}

async function createAndVerifySnapshot(firestore, snapshot) {
  const reference = firestore.collection('_migration_snapshots').doc(snapshot.id);
  let created = false;
  try {
    await reference.create(snapshot.data);
    created = true;
  } catch (error) {
    if (Number(error?.code) !== 6 && error?.code !== 'already-exists') throw error;
  }
  const stored = await reference.get();
  if (!stored.exists || !verifySnapshotPayload(stored.data())) {
    throw new Error('Firestore migration snapshot failed checksum verification');
  }
  return { created, verified: true, opaqueSnapshotId: opaqueId(snapshot.id) };
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  if (!process.env.BILLSPLIT_DB_PATH) {
    throw new Error('BILLSPLIT_DB_PATH must point to an authorized external migration backup');
  }
  const dbPath = path.resolve(process.env.BILLSPLIT_DB_PATH);
  const fileBytes = fs.readFileSync(dbPath);
  const localData = JSON.parse(fileBytes.toString('utf8'));
  const validation = validateLocalData(localData);
  if (!validation.ok) {
    throw new Error(`Local JSON validation failed: ${validation.errors.join(', ')}`);
  }
  const app = initializeFirebaseAdmin(projectRoot);
  const firestore = getFirestore(app);
  const remoteCollections = await readFirestoreCollections(firestore);
  const classification = classifyCutover(localData, remoteCollections);
  const apply = process.argv.includes('--apply');
  const snapshot = snapshotDocument(fileBytes, localData);
  const archive = apply
    ? await createAndVerifySnapshot(firestore, snapshot)
    : { skipped: true, reason: 'dry-run' };

  process.stdout.write(`${JSON.stringify({
    projectId: process.env.FIREBASE_PROJECT_ID || 'easysplit-24576',
    mode: apply ? 'archive-apply' : 'dry-run',
    localFileWasModified: false,
    localSha256: snapshot.data.sha256,
    localByteLength: snapshot.data.byteLength,
    validation,
    ...publicSummary(classification),
    archive,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Safe Firestore cutover failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  classifyCutover,
  createAndVerifySnapshot,
  publicSummary,
  snapshotDocument,
  validateLocalData,
  verifySnapshotPayload,
};
