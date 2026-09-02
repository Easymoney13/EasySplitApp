#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getFirestore } = require('firebase-admin/firestore');

function loadEnvFiles() {
  const candidates = [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const idx = trimmed.indexOf('=');
            const key = trimmed.slice(0, idx).trim();
            const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
            if (key && process.env[key] === undefined) {
              process.env[key] = val;
            }
          }
        }
      } catch (_) {}
    }
  }
}
loadEnvFiles();
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
