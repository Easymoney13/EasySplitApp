#!/usr/bin/env node

const path = require('path');
const { getFirestore } = require('firebase-admin/firestore');
const { analyzeBackfillDataset } = require('../lib/restaurantDataFoundation');
const { initializeFirebaseAdmin } = require('./verify-firestore-parity');

const COLLECTIONS = ['users', 'sessions', 'restaurants', 'restaurant_visits'];

async function readCollections(firestore) {
  const snapshots = await Promise.all(COLLECTIONS.map((name) => firestore.collection(name).get()));
  return Object.fromEntries(snapshots.map((snapshot, index) => [
    COLLECTIONS[index],
    snapshot.docs.map((document) => ({ id: document.id, ...document.data() })),
  ]));
}

async function main() {
  if (process.argv.includes('--apply')) {
    throw new Error('This command is intentionally read-only. No apply mode exists.');
  }
  const projectRoot = path.resolve(__dirname, '..');
  const app = initializeFirebaseAdmin(projectRoot);
  const firestore = getFirestore(app);
  const collections = await readCollections(firestore);
  const result = analyzeBackfillDataset({
    users: collections.users,
    sessions: collections.sessions,
    restaurants: collections.restaurants,
    visits: collections.restaurant_visits,
  }, process.env.EASYSPLIT_IDENTITY_HMAC_SECRET || '');
  process.stdout.write(`${JSON.stringify({
    projectId: process.env.FIREBASE_PROJECT_ID || 'easysplit-24576',
    piiIncludedInOutput: false,
    ...result,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Restaurant data dry-run failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  COLLECTIONS,
  readCollections,
};
