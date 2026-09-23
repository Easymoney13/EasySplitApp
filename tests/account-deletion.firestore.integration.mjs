import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
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
const { processSessionAction } = require('../lib/sessionActions');
const { calculateDebtMinimization } = require('../lib/debtMinimizer');
const prefix = 'prestore-data-regression';
const paths = new Set();
const fencePath = (uid) => `_deleted_account_fences/${createHash('sha256').update(`easysplit-account-deletion-v1:${uid}`).digest('hex')}`;
function trackDeletionPaths(uid) {
  paths.add(`users/${uid}`);
  paths.add(`_account_deletions/${uid}`);
  paths.add(fencePath(uid));
}
const accountDeleted = { statusCode: 409, errorCode: 'ACCOUNT_DELETED' };
const write = async (path, value) => { paths.add(path); await firestore.doc(path).set(value); };
const read = async (path) => (await firestore.doc(path).get()).data();
const originalCollection = firestore.collection.bind(firestore);
const originalCollectionGroup = firestore.collectionGroup.bind(firestore);

test.after(async () => {
  firestore.collection = originalCollection;
  firestore.collectionGroup = originalCollectionGroup;
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
  trackDeletionPaths(uid);
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
  const fence = await read(fencePath(uid));
  assert.deepEqual(Object.keys(fence), ['deletedAt']);
  assert.equal(typeof fence.deletedAt, 'number');
  assert.equal(await read(`restaurant_visits/${visitId}`), undefined);
});

test('a real room creation attempted after the deletion session scan cannot escape cleanup', async () => {
  const uid = `${prefix}-late-create`;
  const sessionId = `${prefix}-late-session`;
  const sessionPath = `sessions/${sessionId}`;
  trackDeletionPaths(uid);
  paths.add(sessionPath);
  await write(`users/${uid}`, { id: uid, username: 'Late creator', phone: '0501234567' });
  let attempted = false;
  firestore.collection = (name) => {
    const collection = originalCollection(name);
    if (name !== 'sessions') return collection;
    const originalGet = collection.get.bind(collection);
    collection.get = async () => {
      const snapshot = await originalGet();
      if (!attempted) {
        attempted = true;
        await assert.rejects(db.createSessionIfAbsent({
          id: sessionId,
          status: 'active',
          hostPhone: '0501234567',
          members: [{ id: uid, userId: uid, name: 'Late creator', phone: '0501234567', isHost: true, active: true }],
          items: [{ id: 'item', name: 'Meal', price: 60, claimedBy: [uid] }],
        }), accountDeleted);
      }
      return snapshot;
    };
    return collection;
  };
  try {
    await db.deleteUserAccountData(uid);
  } finally { firestore.collection = originalCollection; }
  assert.equal(attempted, true, 'The competing creation must run after collection discovery');
  assert.equal(await read(sessionPath), undefined);
  assert.equal(await read(`users/${uid}`), undefined);
  assert.equal(await read(`_account_deletions/${uid}`), undefined);
  assert.ok(await read(fencePath(uid)), 'The fence must survive successful cleanup');
});

test('completed deletion blocks stale profile writes without blocking a different UID with the same phone', async () => {
  const uid = `${prefix}-stale-profile`;
  const newUid = `${prefix}-new-account`;
  const phone = '0501234567';
  trackDeletionPaths(uid);
  paths.add(`users/${newUid}`);
  await write(`users/${uid}`, { id: uid, username: 'Deleted profile', phone });
  await db.deleteUserAccountData(uid);
  await assert.rejects(db.saveUser({ id: uid, avatarUrl: 'https://example.invalid/stale-avatar' }, uid), accountDeleted);
  await assert.rejects(db.findOrCreateUser(uid, 'Stale sync', phone), accountDeleted);
  assert.equal(await read(`users/${uid}`), undefined);
  assert.equal(await read(`_account_deletions/${uid}`), undefined);
  const originalFence = await read(fencePath(uid));
  assert.deepEqual(Object.keys(originalFence), ['deletedAt']);
  assert.equal((await db.deleteUserAccountData(uid)).deleted, false);
  assert.deepEqual(await read(fencePath(uid)), originalFence, 'Repeated deletion keeps the original durable fence');
  const replacement = await db.findOrCreateUser(newUid, 'New account', phone);
  assert.equal(replacement.id, newUid);
  assert.equal(replacement.phone, phone);
  assert.equal((await read(`users/${newUid}`)).id, newUid);
});

test('delayed group deletion cleans surviving profiles without recreating a deleted account', async () => {
  const uid = `${prefix}-group-cleanup-deleted`;
  const survivingUid = `${prefix}-group-cleanup-survivor`;
  const groupId = `${prefix}-deleted-group`;
  const otherGroupId = `${prefix}-retained-group`;
  const planPath = `_group_deletions/${groupId}`;
  trackDeletionPaths(uid);
  await write(`users/${uid}`, { id: uid, username: 'Deleted account', groups: [groupId], phone: '' });
  await write(`users/${survivingUid}`, { id: survivingUid, username: 'Surviving account', groups: [groupId, otherGroupId] });
  await db.deleteUserAccountData(uid);
  assert.equal(await read(`users/${uid}`), undefined);
  await write(planPath, {
    groupId,
    sessionIds: [],
    groupUserIds: [uid, survivingUid],
    memberUserIdsBySession: {},
    createdAt: Date.now(),
  });
  assert.equal(await db.resumeGroupDeletion(groupId), true);
  assert.equal(await read(`users/${uid}`), undefined, 'A delayed group-index cleanup must not create a profile');
  assert.equal(await read(planPath), undefined, 'Group cleanup still completes');
  const survivor = await read(`users/${survivingUid}`);
  assert.equal(survivor.username, 'Surviving account');
  assert.deepEqual(survivor.groups, [otherGroupId]);
  assert.ok(await read(fencePath(uid)));
});

test('surviving members can finish their share after deletion without changing anonymized claims or debt', async () => {
  const uid = `${prefix}-deleted-debtor`;
  const hostId = `${prefix}-surviving-host`;
  const sessionId = `${prefix}-surviving-session`;
  const sessionPath = `sessions/${sessionId}`;
  trackDeletionPaths(uid);
  await write(`users/${uid}`, { id: uid, username: 'Deleted debtor', phone: '' });
  await write(sessionPath, {
    id: sessionId,
    status: 'active',
    tipPercentage: 0,
    payerId: hostId,
    members: [
      { id: uid, userId: uid, name: 'Deleted debtor', active: true, settled: false },
      { id: hostId, userId: hostId, name: 'Surviving host', isHost: true, active: true, settled: false },
    ],
    items: [{ id: 'item', name: 'Meal', price: 60, claimedBy: [uid, hostId] }],
  });
  await db.deleteUserAccountData(uid);
  const before = await read(sessionPath);
  const anonymous = before.members.find((member) => member.deletedAccount);
  assert.ok(anonymous);
  const debtFor = (session) => calculateDebtMinimization({
    id: `${prefix}-debt-comparison`,
    members: session.members,
    bills: [{ id: 'bill', status: 'active', amount: 60, payerId: session.payerId, items: session.items, tipPercentage: 0 }],
  });
  const beforeDebt = debtFor(before);
  assert.ok(beforeDebt.balances.some((balance) => balance.memberId === anonymous.id && balance.netBalance !== 0));
  const mutation = await db.transactSessionAndLinkedGroup(sessionId, (session) => ({
    session: processSessionAction(session, 'TOGGLE_SETTLED', { memberId: hostId, settled: true }, { memberId: hostId }),
  }));
  assert.ok(mutation?.session);
  const after = await read(sessionPath);
  assert.equal(after.members.find((member) => member.id === hostId).settled, true);
  assert.equal(after.members.find((member) => member.id === anonymous.id).settled, false);
  assert.deepEqual(after.items, before.items);
  assert.equal(after.payerId, before.payerId);
  assert.deepEqual(debtFor(after), beforeDebt);
  assert.equal(JSON.stringify(after).includes(uid), false);
  assert.equal(await read(`users/${uid}`), undefined);
});

test('legacy profile bills are anonymized consistently without overwriting concurrent survivor updates', async () => {
  const uid = `${prefix}-legacy-deleted`;
  const survivorUid = `${prefix}-legacy-survivor`;
  const survivorPath = `users/${survivorUid}`;
  const historyPath = `history/${prefix}-legacy-history`;
  const legacyBill = {
    id: `${prefix}-legacy-history`, amount: 60, payerId: survivorUid,
    memberIds: [uid, survivorUid],
    members: [
      { id: uid, userId: uid, name: 'Private legacy name', phone: '0501234567', active: true },
      { id: survivorUid, userId: survivorUid, name: 'Survivor', isHost: true, active: true },
    ],
    items: [{ id: 'meal', name: 'Meal', price: 60, claimedBy: [uid, survivorUid] }],
  };
  const addedBill = { id: `${prefix}-concurrent-legacy-bill`, amount: 25 };
  const retainedGroups = [`${prefix}-retained-membership`];
  trackDeletionPaths(uid);
  await write(`users/${uid}`, { id: uid, username: 'Private legacy name', phone: '0501234567' });
  await write(historyPath, legacyBill);
  await write(survivorPath, {
    id: survivorUid, username: 'Survivor', phone: '', bills: [legacyBill],
    groups: retainedGroups, settings: { theme: 'light', language: 'he' },
  });
  let injected = false;
  firestore.collection = (name) => {
    const collection = originalCollection(name);
    if (name !== 'users') return collection;
    const originalGet = collection.get.bind(collection);
    collection.get = async () => {
      const snapshot = await originalGet();
      if (!injected) {
        injected = true;
        await db.findOrCreateUser(survivorUid, 'Updated survivor', '', { theme: 'dark' });
        await db.addUserBill(survivorUid, 'Updated survivor', '', addedBill);
      }
      return snapshot;
    };
    return collection;
  };
  try { await db.deleteUserAccountData(uid); }
  finally { firestore.collection = originalCollection; }
  assert.equal(injected, true);
  const survivor = await read(survivorPath);
  const canonical = await read(historyPath);
  const anonymousId = canonical.members.find((member) => member.deletedAccount).id;
  assert.equal(survivor.username, 'Updated survivor');
  assert.deepEqual(survivor.settings, { theme: 'dark', language: 'he' });
  assert.deepEqual(survivor.groups, retainedGroups);
  assert.deepEqual(survivor.bills.find((bill) => bill.id === addedBill.id), addedBill);
  assert.deepEqual(survivor.bills.find((bill) => bill.id === legacyBill.id), canonical);
  assert.equal(canonical.amount, 60);
  assert.equal(canonical.payerId, survivorUid);
  assert.deepEqual(canonical.items, [{ id: 'meal', name: 'Meal', price: 60, claimedBy: [anonymousId, survivorUid] }]);
  assert.equal(JSON.stringify(survivor).includes(uid), false);
  assert.equal(JSON.stringify(survivor).includes('Private legacy name'), false);
  assert.equal(await read(`users/${uid}`), undefined);
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

test('legacy history snapshots are scrubbed below surviving or absent profiles without changing simple pointers', async () => {
  const uid = `${prefix}-nested-deleted`;
  const survivorUid = `${prefix}-nested-survivor`;
  const historyId = `${prefix}-nested-history`;
  const fallbackId = `${prefix}-nested-fallback`;
  const nestedPath = `users/${survivorUid}/history/${fallbackId}`;
  const orphanPath = `users/${prefix}-missing-profile/history/${fallbackId}`;
  const pointerPath = `users/${survivorUid}/history/${historyId}`;
  const canonicalPath = `history/${historyId}`;
  const history = {
    id: historyId, storeName: 'Legacy Cafe', amount: 60, settledAt: 100,
    memberIds: [uid, survivorUid], payerId: uid,
    members: [
      { id: uid, userId: uid, name: 'Private nested name', phone: '0501234567', active: true },
      { id: survivorUid, userId: survivorUid, name: 'Survivor', active: true },
    ],
    items: [{ id: 'meal', price: 60, claimedBy: [uid, survivorUid] }],
  };
  const pointer = { historyId, settledAt: 100 };
  trackDeletionPaths(uid);
  await write(`users/${uid}`, { id: uid, username: 'Private nested name', phone: '' });
  await write(`users/${survivorUid}`, { id: survivorUid, username: 'Survivor' });
  await write(canonicalPath, history);
  await write(nestedPath, { ...history, id: fallbackId });
  await write(orphanPath, { ...history, id: fallbackId });
  await write(pointerPath, pointer);
  assert.equal(await db.isAccountDeletionComplete(uid), false);
  let injected = false;
  firestore.collectionGroup = (name) => {
    const collection = originalCollectionGroup(name);
    if (name !== 'history') return collection;
    const originalGet = collection.get.bind(collection);
    collection.get = async () => {
      const snapshot = await originalGet();
      if (!injected) {
        injected = true;
        await firestore.doc(nestedPath).update({
          amount: 85,
          items: [...history.items, { id: 'concurrent-item', price: 25, claimedBy: [survivorUid] }],
        });
      }
      return snapshot;
    };
    return collection;
  };
  try { await db.deleteUserAccountData(uid); }
  finally { firestore.collectionGroup = originalCollectionGroup; }
  assert.equal(injected, true);
  const canonical = await read(canonicalPath);
  const anonymousId = canonical.members.find((member) => member.deletedAccount).id;
  for (const path of [nestedPath, orphanPath]) {
    const stored = await read(path);
    assert.equal(stored.members.find((member) => member.deletedAccount).id, anonymousId);
    assert.equal(stored.payerId, anonymousId);
    assert.deepEqual(stored.items[0].claimedBy, [anonymousId, survivorUid]);
    assert.equal(JSON.stringify(stored).includes(uid), false);
    assert.equal(JSON.stringify(stored).includes('Private nested name'), false);
    assert.equal(JSON.stringify(stored).includes('0501234567'), false);
  }
  const nested = await read(nestedPath);
  assert.equal(nested.amount, 85);
  assert.deepEqual(nested.items[1], { id: 'concurrent-item', price: 25, claimedBy: [survivorUid] });
  assert.deepEqual(await read(pointerPath), pointer);
  const page = await db.getHistoryPageForUser(survivorUid);
  assert.equal(page.rawCount, 2);
  assert.deepEqual(page.slots.find((entry) => entry.id === fallbackId), nested);
  assert.equal(await db.isAccountDeletionComplete(uid), true);
});

test('history removal reads current profiles after competing account cleanup and bill creation', async () => {
  const uid = `${prefix}-history-delete-account`;
  const survivorUid = `${prefix}-history-delete-survivor`;
  const removedId = `${prefix}-history-remove`;
  const retainedId = `${prefix}-history-retain`;
  const newBill = { id: `${prefix}-history-concurrent`, amount: 25 };
  const survivorPath = `users/${survivorUid}`;
  const retained = {
    id: retainedId, amount: 60, memberIds: [uid, survivorUid],
    members: [
      { id: uid, userId: uid, name: 'Private retained name', phone: '0501234567' },
      { id: survivorUid, userId: survivorUid, name: 'Survivor' },
    ],
  };
  trackDeletionPaths(uid);
  await write(`users/${uid}`, { id: uid, username: 'Private retained name', phone: '' });
  await write(survivorPath, { id: survivorUid, username: 'Survivor', bills: [retained, { id: removedId }] });
  await write(`history/${removedId}`, { id: removedId });
  let injected = false;
  firestore.collection = (name) => {
    const collection = originalCollection(name);
    if (name !== 'users') return collection;
    const originalGet = collection.get.bind(collection);
    collection.get = async () => {
      const snapshot = await originalGet();
      if (!injected) {
        injected = true;
        await db.deleteUserAccountData(uid);
        await db.addUserBill(survivorUid, 'Survivor', '', newBill);
      }
      return snapshot;
    };
    return collection;
  };
  try { await db.deleteHistory(removedId); }
  finally { firestore.collection = originalCollection; }
  assert.equal(injected, true);
  const survivor = await read(survivorPath);
  assert.deepEqual(survivor.bills.map((bill) => bill.id).sort(), [newBill.id, retainedId].sort());
  assert.deepEqual(survivor.bills.find((bill) => bill.id === newBill.id), newBill);
  assert.equal(JSON.stringify(survivor).includes(uid), false);
  assert.equal(JSON.stringify(survivor).includes('Private retained name'), false);
  assert.equal(JSON.stringify(survivor).includes('0501234567'), false);
  assert.equal(await read(`history/${removedId}`), undefined);
  assert.equal(await read(`users/${uid}`), undefined);
});
