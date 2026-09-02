#!/usr/bin/env node

/**
 * EasySplit - Restaurant Data Foundation Backfill Tool
 *
 * Safely backfills phone HMACs, quality assurances, and missing visit records
 * into Firestore.
 *
 * Usage:
 *   node scripts/restaurant-data-backfill.js           # Dry-run mode (default, no writes)
 *   node scripts/restaurant-data-backfill.js --dry-run # Dry-run mode
 *   node scripts/restaurant-data-backfill.js --apply   # Apply changes with automatic JSON backup
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const {
  assessVisitData,
  createIdentityHmac,
  isResolvedRestaurant,
  normalizeVisitDate,
  phoneAssuranceFor,
  timestampMillis,
} = require('../lib/restaurantDataFoundation');
const { normalizeIsraeliPhone } = require('../lib/validation');
const { getFirestore } = require('firebase-admin/firestore');
const { initializeFirebaseAdmin } = require('./verify-firestore-parity');

const COLLECTIONS = ['users', 'sessions', 'restaurants', 'restaurant_visits'];
const BACKUP_DIR = path.resolve(__dirname, '..', 'data', 'backups');

async function fetchCollections(firestore) {
  const snapshots = await Promise.all(
    COLLECTIONS.map((name) => firestore.collection(name).get())
  );
  return Object.fromEntries(
    snapshots.map((snapshot, index) => [
      COLLECTIONS[index],
      snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    ])
  );
}

function computeMemberPhone(session, member) {
  return normalizeIsraeliPhone(
    member?.phone || (member?.isHost ? session?.hostPhone || '' : '')
  );
}

function planBackfill(data, secret, keyVersion = 'v1') {
  const { users = [], sessions = [], restaurants = [], restaurant_visits = [] } = data;
  const restaurantById = new Map(restaurants.map((r) => [r.id, r]));
  const visitById = new Map();
  for (const v of restaurant_visits) {
    if (v.id) visitById.set(v.id, v);
    if (v.sessionId && v.memberId) visitById.set(`${v.sessionId}:${v.memberId}`, v);
  }
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  const userUpdates = [];
  let usersAlreadyComplete = 0;
  let usersMissingPhone = 0;

  for (const user of users) {
    const normalizedPhone = normalizeIsraeliPhone(user.phone || '');
    if (!normalizedPhone) {
      usersMissingPhone += 1;
      continue;
    }
    const phoneHmac = createIdentityHmac(secret, normalizedPhone);
    const phoneAssurance = phoneAssuranceFor(user, phoneHmac);

    const isCurrent =
      user.phoneHmac === phoneHmac &&
      user.phoneAssurance === phoneAssurance &&
      user.phoneDataQualityStatus === 'complete' &&
      user.identityKeyVersion === keyVersion;

    if (isCurrent) {
      usersAlreadyComplete += 1;
    } else {
      userUpdates.push({
        id: user.id,
        updates: {
          phoneHmac: phoneHmac || undefined,
          phoneAssurance,
          phoneDataQualityStatus: phoneHmac ? 'complete' : 'blocked_missing_hmac_secret',
          identityKeyVersion: keyVersion,
          updatedAt: Date.now(),
        },
      });
    }
  }

  const visitUpdates = [];
  const visitCreations = [];
  let visitsAlreadyComplete = 0;
  let visitsUnrecoverable = 0;

  for (const session of sessions) {
    const restaurant = restaurantById.get(session?.restaurant?.id) || session?.restaurant;
    if (!restaurant?.id) continue;

    const members = Array.isArray(session?.members) ? session.members : [];
    for (const member of members) {
      if (!member?.id || member.active === false) continue;

      const visitId = `visit_${crypto
        .createHash('sha256')
        .update(`${session.id}:${member.id}`)
        .digest('hex')
        .slice(0, 32)}`;

      const phone = computeMemberPhone(session, member);
      const existingVisit = visitById.get(visitId) || visitById.get(`${session.id}:${member.id}`);

      if (!existingVisit) {
        if (!phone) {
          visitsUnrecoverable += 1;
          continue;
        }
        const phoneHmac = createIdentityHmac(secret, phone);
        const occurredAt =
          timestampMillis(member.joinedAt) ||
          timestampMillis(session.createdAt) ||
          Date.now();
        const visitDate =
          normalizeVisitDate(session.date) ||
          new Date(occurredAt).toISOString().slice(0, 10);
        const quality = assessVisitData({
          restaurant,
          phoneHmac,
          occurredAt,
          visitDate,
        });

        const identityAliases = [
          member.uid ? `user:${member.uid}` : '',
          phoneHmac ? `phone:${phoneHmac}` : '',
          member.clientIdentityHash ? `device:${member.clientIdentityHash}` : '',
        ].filter(Boolean);

        visitCreations.push({
          id: visitId,
          doc: {
            id: visitId,
            restaurantId: restaurant.id,
            sessionId: session.id,
            memberId: member.id,
            userId: member.uid || undefined,
            identityAliases,
            displayNameSnapshot: member.name || 'Member',
            phoneHmac: phoneHmac || undefined,
            phoneAssurance: phoneAssuranceFor(member, phoneHmac),
            accountAssurance: member.uid ? 'google_account' : 'guest_device',
            identityKeyVersion: keyVersion,
            visitEvidence: 'bill_participant',
            physicalPresenceVerified: false,
            role: member.isHost ? 'host' : 'participant',
            occurredAt,
            visitDate,
            visitDateSource: normalizeVisitDate(session.date) ? 'receipt_confirmed' : 'session_created',
            joinedAt: timestampMillis(member.joinedAt) || occurredAt,
            lastSeenAt: Date.now(),
            restaurantConfidence: Number(restaurant.confidence || 0),
            restaurantTrustScore: Number(restaurant.trustScore || 0),
            restaurantIdentityBasis: restaurant.identityBasis || 'unresolved',
            ...quality,
            retainedAfterSourceDeletion: true,
            retentionPolicy: 'exclude_when_source_tombstoned',
            sourceState: 'active',
          },
        });
      } else {
        const phoneHmac = phone ? createIdentityHmac(secret, phone) : existingVisit.phoneHmac;
        const occurredAt =
          timestampMillis(existingVisit.occurredAt) ||
          timestampMillis(member.joinedAt) ||
          timestampMillis(session.createdAt) ||
          Date.now();
        const visitDate =
          normalizeVisitDate(existingVisit.visitDate) ||
          normalizeVisitDate(session.date) ||
          new Date(occurredAt).toISOString().slice(0, 10);

        const quality = assessVisitData({
          restaurant,
          phoneHmac,
          occurredAt,
          visitDate,
        });

        const needsHmacUpdate = Boolean(phoneHmac && existingVisit.phoneHmac !== phoneHmac);
        const needsOccurredAtUpdate = !existingVisit.occurredAt && occurredAt;
        const needsVisitDateUpdate = !existingVisit.visitDate && visitDate;
        const needsQualityUpdate = existingVisit.dataQualityStatus !== quality.dataQualityStatus;

        if (needsHmacUpdate || needsOccurredAtUpdate || needsVisitDateUpdate || needsQualityUpdate) {
          const aliases = new Set(Array.isArray(existingVisit.identityAliases) ? existingVisit.identityAliases : []);
          if (phoneHmac) aliases.add(`phone:${phoneHmac}`);
          if (member.uid) aliases.add(`user:${member.uid}`);

          visitUpdates.push({
            id: existingVisit.id || visitId,
            updates: {
              ...(phoneHmac ? { phoneHmac, phoneAssurance: phoneAssuranceFor(member, phoneHmac) } : {}),
              occurredAt,
              visitDate,
              identityAliases: [...aliases],
              identityKeyVersion: keyVersion,
              ...quality,
              updatedAt: Date.now(),
            },
          });
        } else {
          visitsAlreadyComplete += 1;
        }
      }
    }
  }

  return {
    userUpdates,
    visitUpdates,
    visitCreations,
    stats: {
      totalUsers: users.length,
      usersUpdated: userUpdates.length,
      usersAlreadyComplete,
      usersMissingPhone,
      totalVisits: restaurant_visits.length,
      visitsUpdated: visitUpdates.length,
      visitsCreated: visitCreations.length,
      visitsAlreadyComplete,
      visitsUnrecoverable,
    },
  };
}

function stripUndefined(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  );
}

function saveLocalBackup(data) {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `firestore-backup-${timestamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(data, null, 2), 'utf8');
  return backupFile;
}

async function applyBatchWrites(firestore, userUpdates, visitUpdates, visitCreations) {
  const operations = [];

  for (const item of userUpdates) {
    operations.push({
      type: 'update',
      ref: firestore.collection('users').doc(item.id),
      data: stripUndefined(item.updates),
    });
  }

  for (const item of visitUpdates) {
    operations.push({
      type: 'set',
      ref: firestore.collection('restaurant_visits').doc(item.id),
      data: stripUndefined(item.updates),
      options: { merge: true },
    });
  }

  for (const item of visitCreations) {
    operations.push({
      type: 'set',
      ref: firestore.collection('restaurant_visits').doc(item.id),
      data: stripUndefined(item.doc),
    });
  }

  const BATCH_SIZE = 400;
  let writesPerformed = 0;

  for (let i = 0; i < operations.length; i += BATCH_SIZE) {
    const chunk = operations.slice(i, i + BATCH_SIZE);
    const batch = firestore.batch();
    for (const op of chunk) {
      if (op.type === 'update') {
        batch.update(op.ref, op.data);
      } else if (op.options?.merge) {
        batch.set(op.ref, op.data, { merge: true });
      } else {
        batch.set(op.ref, op.data);
      }
    }
    await batch.commit();
    writesPerformed += chunk.length;
  }

  return writesPerformed;
}

async function main() {
  const isApply = process.argv.includes('--apply');
  const projectRoot = path.resolve(__dirname, '..');
  const secret = process.env.EASYSPLIT_IDENTITY_HMAC_SECRET || '';
  const keyVersion = process.env.EASYSPLIT_IDENTITY_HMAC_KEY_VERSION || 'v1';

  if (!secret || secret.length < 24) {
    throw new Error('EASYSPLIT_IDENTITY_HMAC_SECRET must be configured and at least 24 chars long.');
  }

  const app = initializeFirebaseAdmin(projectRoot);
  const firestore = getFirestore(app);
  try {
    firestore.settings({ ignoreUndefinedProperties: true });
  } catch (_) {}
  const data = await fetchCollections(firestore);

  const plan = planBackfill(data, secret, keyVersion);

  if (!isApply) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'dry-run',
          projectId: process.env.FIREBASE_PROJECT_ID || 'easysplit-24576',
          piiIncludedInOutput: false,
          writesPerformed: 0,
          plannedOperations: {
            userUpdates: plan.userUpdates.length,
            visitUpdates: plan.visitUpdates.length,
            visitCreations: plan.visitCreations.length,
          },
          summary: plan.stats,
          notice: 'To apply these changes safely, run with --apply',
        },
        null,
        2
      )}\n`
    );
    return;
  }

  // Apply mode
  const backupFile = saveLocalBackup(data);
  const writesPerformed = await applyBatchWrites(
    firestore,
    plan.userUpdates,
    plan.visitUpdates,
    plan.visitCreations
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'apply',
        projectId: process.env.FIREBASE_PROJECT_ID || 'easysplit-24576',
        piiIncludedInOutput: false,
        backupSaved: true,
        backupPath: backupFile,
        writesPerformed,
        appliedSummary: plan.stats,
      },
      null,
      2
    )}\n`
  );
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Backfill failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchCollections,
  planBackfill,
};
