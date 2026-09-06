#!/usr/bin/env node

/**
 * EasySplit - Database Canonicalization Tool
 * 
 * Analyzes all restaurant names and phone numbers in Firestore,
 * finds OCR typos and variations, resolves them to canonical forms,
 * previews name candidates and transactionally normalizes phone records.
 * 
 * Usage:
 *   node scripts/canonicalize-database.js           # Preview mode
 *   node scripts/canonicalize-database.js --dry-run # Preview mode
 *   node scripts/canonicalize-database.js --apply   # Explicit phone updates
 */

const path = require('path');
const { initializeFirebaseAdmin } = require('./verify-firestore-parity');
const { getFirestore } = require('firebase-admin/firestore');
const { refactorDatabase } = require('../lib/canonicalEngine');

function canonicalMode(args) {
  if (args.some((arg) => !['--apply', '--dry-run'].includes(arg))
    || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Use --dry-run (default) or --apply, never both');
  }
  return { dryRun: !args.includes('--apply') };
}

async function main(args = process.argv.slice(2)) {
  const { dryRun: isDryRun } = canonicalMode(args);
  const projectRoot = path.resolve(__dirname, '..');
  const app = initializeFirebaseAdmin(projectRoot);
  const db = getFirestore(app);

  console.log(`\n======================================================`);
  console.log(` EasySplit Database Canonicalization Engine`);
  console.log(` Mode: ${isDryRun ? '🔍 DRY-RUN (no writes)' : '⚡ LIVE APPLY (updating database)'}`);
  console.log(`======================================================\n`);

  const result = await refactorDatabase(db, { dryRun: isDryRun });

  console.log('--- Name suggestions only; no restaurant identity or receipt names are rewritten ---');
  for (const [original, canonical] of Object.entries(result.canonicalMap)) {
    if (original !== canonical) {
      console.log(`  🔄 "${original}" -> "${canonical}"`);
    }
  }

  console.log('\n--- Updates Summary ---');
  console.log(`  Sessions ${isDryRun ? 'proposed' : 'updated'}:    ${result.sessionUpdatesCount}`);
  console.log(`  Groups ${isDryRun ? 'proposed' : 'updated'}:      ${result.groupUpdatesCount}`);
  console.log(`  Restaurants updated: ${result.restaurantUpdatesCount}`);

  if (result.sessionUpdates.length > 0) {
    console.log('\nSample Session Updates:');
    result.sessionUpdates.slice(0, 10).forEach((up) => {
      console.log(`  • Session ${up.id}: ${up.originalName ? `"${up.originalName}" -> "${up.newName}"` : 'Phone formatted'}`);
    });
  }

  console.log(`\n✅ Database canonicalization ${isDryRun ? 'dry-run preview' : 'application'} completed successfully.\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error running database canonicalization:', err);
    process.exitCode = 1;
  });
}

module.exports = { canonicalMode };
