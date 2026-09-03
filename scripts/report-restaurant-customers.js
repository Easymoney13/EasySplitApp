#!/usr/bin/env node

/**
 * EasySplit - Live Restaurant & Customer Phone Directory
 * Queries live Firestore directly and prints the current status.
 * Leaves no local files on disk.
 */

const path = require('path');
const { initializeFirebaseAdmin } = require('./verify-firestore-parity');
const { getFirestore } = require('firebase-admin/firestore');

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
    if (data.username) usersMap.set(data.username, data.phone);
  });

  const restaurantMap = new Map();
  restaurantsSnap.docs.forEach(d => {
    const data = d.data();
    restaurantMap.set(d.id, data.printedName || data.normalizedName || d.id);
  });

  const restaurantParticipants = {};

  function addEntry(restaurantName, phone, userName, role, date) {
    if (!restaurantName) return;
    const cleanName = String(restaurantName).trim();
    if (!cleanName) return;
    if (!restaurantParticipants[cleanName]) {
      restaurantParticipants[cleanName] = new Map();
    }
    const cleanPhone = phone && typeof phone === 'string' ? phone.trim() : (phone ? String(phone).trim() : '');
    const key = (cleanPhone && cleanPhone !== 'Not provided') ? cleanPhone : `no-phone:${userName}`;
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
    const rName = s.storeName || (s.restaurantId && restaurantMap.get(s.restaurantId));
    if (!rName) return;
    const date = s.date || (s.created ? new Date(s.created).toISOString().slice(0, 10) : '');

    const hostPhone = s.hostPhone || (s.hostId && usersMap.get(s.hostId));
    if (hostPhone || s.hostName) {
      addEntry(rName, hostPhone, s.hostName || 'Host', 'Host', date);
    }

    if (Array.isArray(s.members)) {
      s.members.forEach(m => {
        const phone = m.phone || (m.userId && usersMap.get(m.userId)) || (m.name && usersMap.get(m.name));
        addEntry(rName, phone, m.name || m.displayName, m.isHost ? 'Host' : 'Member', date);
      });
    }
  });

  // 2. Groups
  groupsSnap.docs.forEach(d => {
    const g = d.data();
    if (Array.isArray(g.bills)) {
      g.bills.forEach(b => {
        const rName = b.storeName || b.restaurantName;
        if (!rName) return;
        const date = b.date || '';
        const payerPhone = b.payerPhone || (b.payerId && usersMap.get(b.payerId));
        if (payerPhone || b.payerName) {
          addEntry(rName, payerPhone, b.payerName, 'Payer', date);
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
