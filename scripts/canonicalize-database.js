#!/usr/bin/env node

/**
 * EasySplit - Database Canonicalization Tool
 * 
 * Analyzes all restaurant names and phone numbers in Firestore,
 * finds OCR typos and variations, resolves them to canonical forms,
 * and updates live Firestore records safely.
 * 
 * Usage:
 *   node scripts/canonicalize-database.js           # Live apply
 *   node scripts/canonicalize-database.js --dry-run # Preview mode
 */

const path = require('path');
const { initializeFirebaseAdmin } = require('./verify-firestore-parity');
const { getFirestore } = require('firebase-admin/firestore');
const { refactorDatabase } = require('../lib/canonicalEngine');

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const projectRoot = path.resolve(__dirname, '..');
  const app = initializeFirebaseAdmin(projectRoot);
  const db = getFirestore(app);

  console.log(`\n======================================================`);
  console.log(` EasySplit Database Canonicalization Engine`);
  console.log(` Mode: ${isDryRun ? '🔍 DRY-RUN (no writes)' : '⚡ LIVE APPLY (updating database)'}`);
  console.log(`======================================================\n`);

  const result = await refactorDatabase(db, { dryRun: isDryRun });

  console.log('--- Restaurant Canonical Mappings ---');
  for (const [original, canonical] of Object.entries(result.canonicalMap)) {
    if (original !== canonical) {
      console.log(`  🔄 "${original}" -> "${canonical}"`);
    }
  }

  console.log('\n--- Updates Summary ---');
  console.log(`  Sessions updated:    ${result.sessionUpdatesCount}`);
  console.log(`  Groups updated:      ${result.groupUpdatesCount}`);
  console.log(`  Restaurants updated: ${result.restaurantUpdatesCount}`);

  if (result.sessionUpdates.length > 0) {
    console.log('\nSample Session Updates:');
    result.sessionUpdates.slice(0, 10).forEach((up) => {
      console.log(`  • Session ${up.id}: ${up.originalName ? `"${up.originalName}" -> "${up.newName}"` : 'Phone formatted'}`);
    });
  }

  console.log(`\n✅ Database canonicalization ${isDryRun ? 'dry-run preview' : 'application'} completed successfully.\n`);
}

main().catch((err) => {
  console.error('❌ Error running database canonicalization:', err);
  process.exit(1);
});
