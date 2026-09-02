#!/usr/bin/env node

/**
 * EasySplit - Set Admin Custom Claim Script
 *
 * Sets `restaurantDataAdmin: true` custom claim for a designated Firebase user.
 *
 * Usage:
 *   node scripts/set-admin-claim.js --uid <firebase-uid>
 *   node scripts/set-admin-claim.js --email <user-email>
 */

const fs = require('fs');
const path = require('path');

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

const { getAuth } = require('firebase-admin/auth');
const { initializeFirebaseAdmin } = require('./verify-firestore-parity');

async function main() {
  const args = process.argv.slice(2);
  let uid = '';
  let email = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--uid' && args[i + 1]) uid = args[i + 1];
    if (args[i] === '--email' && args[i + 1]) email = args[i + 1];
  }

  if (!uid && !email) {
    process.stderr.write('Usage: node scripts/set-admin-claim.js --uid <uid> OR --email <email>\n');
    process.exit(1);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const app = initializeFirebaseAdmin(projectRoot);
  const auth = getAuth(app);

  let targetUser;
  if (uid) {
    targetUser = await auth.getUser(uid);
  } else {
    targetUser = await auth.getUserByEmail(email);
  }

  const existingClaims = targetUser.customClaims || {};
  const updatedClaims = {
    ...existingClaims,
    restaurantDataAdmin: true,
  };

  await auth.setCustomUserClaims(targetUser.uid, updatedClaims);

  process.stdout.write(JSON.stringify({
    success: true,
    uid: targetUser.uid,
    claimGranted: 'restaurantDataAdmin',
    claims: updatedClaims,
  }, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Failed to set admin claim: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
