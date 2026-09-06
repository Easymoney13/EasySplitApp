#!/usr/bin/env node

/**
 * EasySplit - Live Restaurant & Customer Phone Directory
 * Queries live Firestore directly and prints the current status.
 * Leaves no local files on disk.
 */

const path = require('path');
const { initializeFirebaseAdmin } = require('./verify-firestore-parity');
const { getFirestore } = require('firebase-admin/firestore');
const { resolveRestaurantAliases } = require('../lib/restaurantResolution');
const { canonicalizePhone } = require('../lib/canonicalEngine');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const app = initializeFirebaseAdmin(projectRoot);
  const db = getFirestore(app);

  console.log('Connecting to live Firestore database...\n');

  const [sessionsSnap, restaurantsSnap, groupsSnap, usersSnap] = await Promise.all([
    db.collection('sessions').get(),
    db.collection('restaurants').get(),
    db.collection('groups').get(),
    db.collection('users').get(),
  ]);

  const usersMap = new Map();
  usersSnap.docs.forEach(d => {
    const data = d.data();
    if (data.phone) usersMap.set(d.id, data.phone);
  });

  const restaurantMap = new Map();
  const restaurantRecords = restaurantsSnap.docs.map(d => ({ ...d.data(), id: d.id }));
  const aliasCache = new Map();
  function venueKey(restaurantId, sourceId, name) {
    if (!restaurantId || !restaurantMap.has(restaurantId)) return `${name || 'Unknown restaurant'} [unresolved:${sourceId}]`;
    if (!aliasCache.has(restaurantId)) {
      const aliases = resolveRestaurantAliases(restaurantRecords, restaurantId);
      const key = `${aliases.canonicalPrintedName || restaurantMap.get(aliases.canonicalId)} [${aliases.canonicalId}]`;
      aliases.restaurantIds.forEach(id => aliasCache.set(id, key));
    }
    return aliasCache.get(restaurantId);
  }
  restaurantsSnap.docs.forEach(d => {
    const data = d.data();
    restaurantMap.set(d.id, data.printedName || data.normalizedName || d.id);
  });

  const restaurantParticipants = {};

  function addEntry(restaurantName, phone, userName, role, date, participantKey) {
    if (!restaurantName) return;
    const cleanName = String(restaurantName).trim();
    if (!cleanName) return;
    if (!restaurantParticipants[cleanName]) {
      restaurantParticipants[cleanName] = new Map();
    }
    const cleanPhone = canonicalizePhone(phone);
    const key = cleanPhone || `no-phone:${participantKey}`;
    if (!restaurantParticipants[cleanName].has(key)) {
      restaurantParticipants[cleanName].set(key, {
        phone: cleanPhone || 'Not provided',
        userName: userName || 'Unknown',
        role: role || 'Member',
        dates: new Set(),
      });
    }
    const record = restaurantParticipants[cleanName].get(key);
    if (date) record.dates.add(date);
    if (role === 'Host') record.role = 'Host';
    if (cleanPhone && cleanPhone !== 'Not provided') record.phone = cleanPhone;
  }

  // 1. Sessions
  sessionsSnap.docs.forEach(d => {
    const s = d.data();
    const rName = venueKey(s.restaurant?.id || s.restaurantId, d.id, s.storeName || s.restaurant?.printedName);
    if (!rName) return;
    const date = s.date || (s.created ? new Date(s.created).toISOString().slice(0, 10) : '');

    const hostPhone = s.hostPhone;
    if (hostPhone || s.hostName) {
      addEntry(rName, hostPhone, s.hostName || 'Host', 'Host', date, `${d.id}:host`);
    }

    if (Array.isArray(s.members)) {
      s.members.forEach((m, index) => {
        const phone = canonicalizePhone(m.phone) || usersMap.get(m.userId || m.uid);
        addEntry(rName, phone, m.name || m.displayName, m.isHost ? 'Host' : 'Member', date, `${d.id}:${m.id || index}`);
      });
    }
  });

  // 2. Groups
  groupsSnap.docs.forEach(d => {
    const g = d.data();
    if (Array.isArray(g.bills)) {
      g.bills.forEach((b, index) => {
        const rName = venueKey(b.restaurant?.id || b.restaurantId, `${d.id}:${b.id || index}`, b.storeName || b.restaurantName);
        if (!rName) return;
        const date = b.date || '';
        const payer = (g.members || []).find(member => member.id === b.payerId);
        const payerPhone = canonicalizePhone(b.payerPhone) || canonicalizePhone(payer?.phone) || usersMap.get(payer?.userId || payer?.uid);
        if (payerPhone || b.payerName) {
          addEntry(rName, payerPhone, b.payerName, 'Payer', date, `${d.id}:${b.id || index}:${b.payerId || 'payer'}`);
        }
      });
    }
  });

  console.log('='.repeat(75));
  console.log('🍽️  LIVE RESTAURANT & CUSTOMER DIRECTORY (FROM FIRESTORE)');
  console.log('='.repeat(75));

  const sortedVenues = Object.keys(restaurantParticipants).sort((a, b) => a.localeCompare(b));
  for (const venue of sortedVenues) {
    const people = Array.from(restaurantParticipants[venue].values());
    console.log(`\n📍 ${venue} (${people.length} participant${people.length > 1 ? 's' : ''}):`);
    for (const p of people) {
      const datesStr = p.dates.size > 0 ? ` [Visits: ${Array.from(p.dates).join(', ')}]` : '';
      console.log(`   - ${p.userName} | Phone: ${p.phone} (${p.role})${datesStr}`);
    }
  }

  console.log('\n' + '='.repeat(75));
  console.log(`Total Venues: ${sortedVenues.length} | Source: Firebase Firestore (${process.env.FIREBASE_PROJECT_ID || 'easysplit-24576'})`);
  console.log('='.repeat(75));
}

main().catch(err => {
  console.error('Failed to fetch restaurant report:', err.message);
  process.exit(1);
});
