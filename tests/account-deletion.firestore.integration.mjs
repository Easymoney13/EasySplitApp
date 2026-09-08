import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Fail before SDK initialization unless an explicitly local demo emulator is set.
assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^127\.0\.0\.1:\d+$/, 'A loopback Firestore emulator is required');
assert.equal(process.env.BILLSPLIT_DB_PATH, undefined, 'This suite must exercise the Firestore branch');
const projectId = 'demo-easysplit-audit';
for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
  if (process.env[key]) assert.equal(process.env[key], projectId, 'Only the demo project is allowed');
}
const app = initializeApp({ projectId });
const firestore = getFirestore(app);
const require = createRequire(import.meta.url);
const db = require('../lib/db');
const prefix = 'prestore-data-regression';
const paths = new Set();
const write = async (path, value) => { paths.add(path); await firestore.doc(path).set(value); };
const read = async (path) => (await firestore.doc(path).get()).data();
const originalCollection = firestore.collection.bind(firestore);

test.after(async () => {
  firestore.collection = originalCollection;
  const batch = firestore.batch();
  paths.forEach((path) => batch.delete(firestore.doc(path)));
  await batch.commit();
  await firestore.terminate();
  await deleteApp(app);
});

test('Firestore cleanup preserves writes committed after scan discovery in rooms and observations', async () => {
  const uid = `${prefix}-deleted`;
  const sessionPath = `sessions/${prefix}-session`;
  const groupPath = `groups/${prefix}-group`;
  const historyPath = `history/${prefix}-history`;
  const visitId = `${prefix}-visit`;
  const observationPath = `restaurant_observations/${prefix}-observation`;
  const room = { id: `${prefix}-session`, status: 'active', members: [
    { id: uid, userId: uid, name: 'Deleted test account', active: true, settled: false },
    { id: `${prefix}-host`, name: 'Host', isHost: true, active: true, settled: false },
  ], items: [{ id: 'item', name: 'Meal', price: 60, claimedBy: [uid, `${prefix}-host`] }], payerId: `${prefix}-host` };
  await write(`users/${uid}`, { id: uid, username: 'Test', phone: '' });
  paths.add(`_account_deletions/${uid}`);
  for (const path of [sessionPath, groupPath, historyPath]) await write(path, room);
  await write(`restaurant_visits/${visitId}`, { userId: uid, identityAliases: [`user:${uid}`] });
  await write(observationPath, { submittedByUserId: uid, submittedByVisitId: visitId, observedByVisitIds: [visitId], evidenceCount: 1 });
  const injected = new Set();
  firestore.collection = (name) => {
    const collection = originalCollection(name);
    if (!['sessions', 'restaurant_observations'].includes(name)) return collection;
    const originalGet = collection.get.bind(collection);
    collection.get = async () => {
      const snapshot = await originalGet();
      if (!injected.has(name)) {
        injected.add(name);
        if (name === 'sessions') {
          const latest = await read(sessionPath);
          latest.members.push({ id: 'concurrent-member', name: 'Concurrent', active: true, settled: true });
          latest.members.forEach((member) => { member.settled = true; });
          latest.items[0].claimedBy.push('concurrent-member');
          latest.status = 'settled'; latest.settledAt = 9000;
          await firestore.doc(sessionPath).set(latest);
        } else {
          await firestore.doc(observationPath).update({ observedByVisitIds: [visitId, 'concurrent-visit'], evidenceCount: 2 });
        }
      }
      return snapshot;
    };
    return collection;
  };
  try {
    await db.deleteUserAccountData(uid);
  } finally { firestore.collection = originalCollection; }
  assert.deepEqual([...injected].sort(), ['restaurant_observations', 'sessions']);
  const session = await read(sessionPath);
  assert.equal(session.status, 'settled'); assert.equal(session.settledAt, 9000);
  assert.ok(session.members.some((member) => member.id === 'concurrent-member'));
  assert.ok(session.items[0].claimedBy.includes('concurrent-member'));
  assert.ok(session.members.every((member) => member.settled === true));
  const ids = await Promise.all([sessionPath, groupPath, historyPath].map(async (path) => (await read(path)).members.find((member) => member.deletedAccount).id));
  assert.equal(new Set(ids).size, 1);
  assert.deepEqual(await read(observationPath), { observedByVisitIds: ['concurrent-visit'], evidenceCount: 2 });
  assert.equal(await read(`users/${uid}`), undefined);
  assert.equal(await read(`_account_deletions/${uid}`), undefined);
  assert.equal(await read(`restaurant_visits/${visitId}`), undefined);
});

test('concurrent Firestore profile and group-index updates retain every membership and bill', async () => {
  const uid = `${prefix}-profile`;
  const groupIds = Array.from({ length: 4 }, (_, i) => `${prefix}-join-${i}`);
  await write(`users/${uid}`, { id: uid, username: 'Profile', phone: '0501234567', groups: [], bills: [{ id: 'existing-bill' }], settings: { theme: 'light' } });
  for (const groupId of groupIds) await write(`groups/${groupId}`, { id: groupId, status: 'active', members: [{ id: uid, userId: uid, active: true }] });
  await Promise.all([
    ...groupIds.map((id) => db.addGroupToUser(uid, id)),
    db.findOrCreateUser(uid, 'Updated', '0501234567', { language: 'he' }),
    db.updateUserSettings(uid, 'Updated', '0501234567', { currency: 'USD' }),
    db.addUserBill(uid, 'Updated', '0501234567', { id: 'new-bill' }),
  ]);
  const user = await read(`users/${uid}`);
  assert.deepEqual([...user.groups].sort(), [...groupIds].sort());
  assert.deepEqual(user.bills.map((bill) => bill.id).sort(), ['existing-bill', 'new-bill']);
  assert.equal(user.settings.language, 'he'); assert.equal(user.settings.currency, 'USD'); assert.equal(user.settings.theme, 'light');
  await db.saveUser({ id: uid, avatarUrl: 'https://example.invalid/avatar' }, uid);
  assert.deepEqual((await read(`users/${uid}`)).groups, user.groups);
});
