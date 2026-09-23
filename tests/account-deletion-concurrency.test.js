const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');

// Exercise lib/db's Firestore branch; this double applies optimistic conflict
// retries and lets a committed competing write land at a deterministic boundary.
let active;
const firestore = {
  settings() {},
  collection: (...args) => active.collection(...args),
  collectionGroup: (...args) => active.collectionGroup(...args),
  runTransaction: (...args) => active.runTransaction(...args),
  batch: (...args) => active.batch(...args),
};
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'firebase-admin/firestore') return { FieldValue: {}, Timestamp: class {}, getFirestore: () => firestore };
  return originalLoad.call(this, request, ...args);
};
delete process.env.BILLSPLIT_DB_PATH;
process.env.NODE_ENV = 'test';
const db = require('../lib/db');
Module._load = originalLoad;

const uid = 'delete-account';
const fencePath = (accountId) => `_deleted_account_fences/${crypto.createHash('sha256').update(`easysplit-account-deletion-v1:${accountId}`).digest('hex')}`;
const clone = (value) => value === undefined ? undefined : structuredClone(value);
function fixture() {
  const room = { id: 's1', status: 'active', members: [
    { id: uid, userId: uid, name: 'Alice', phone: '0501234567', active: true, settled: false },
    { id: 'bob', userId: 'bob', name: 'Bob', active: true, isHost: true, settled: false },
  ], items: [{ id: 'i1', price: 100, claimedBy: [uid, 'bob'] }], payerId: uid };
  return new Map([
    [`users/${uid}`, { id: uid, username: 'Alice', phone: '', groups: [] }],
    ['groups/g1', { ...clone(room), id: 'g1', bills: [{ id: 'b1', payerId: uid }] }],
    ['sessions/s1', clone(room)],
    ['history/h1', { ...clone(room), id: 'h1', memberIds: [uid, 'bob'] }],
    ['restaurant_visits/v1', { userId: uid, identityAliases: [`user:${uid}`] }],
    ['restaurant_observations/o1', { submittedByUserId: uid, submittedByVisitId: 'v1', observedByVisitIds: ['v1', 'other'], evidenceCount: 1 }],
  ]);
}
function harness(store = fixture()) {
  const versions = new Map();
  const h = { store, retries: 0, beforeCommit: null, afterScan: null, failBatch: false };
  h.write = (path, value, options) => {
    if (value === undefined) store.delete(path);
    else store.set(path, options?.merge ? { ...clone(store.get(path)), ...clone(value) } : clone(value));
    versions.set(path, (versions.get(path) || 0) + 1);
  };
  const ref = (path) => ({ path, id: path.split('/').at(-1), get: async () => snapshot(path),
    set: async (value, options) => h.write(path, value, options),
    update: async (value) => { assert.ok(store.has(path)); h.write(path, value, { merge: true }); },
    delete: async () => h.write(path, undefined),
    collection: (name) => collection(`${path}/${name}`) });
  const snapshot = (path) => { const value = clone(store.get(path)); return { id: path.split('/').at(-1), ref: ref(path), exists: value !== undefined, data: () => clone(value) }; };
  const collection = (prefix, filters = []) => ({ doc: (id) => ref(`${prefix}/${id}`),
    where: (key, op, value) => collection(prefix, [...filters, (row) => op === 'array-contains' ? (row[key] || []).includes(value) : row[key] === value]),
    get: async () => {
      const result = { docs: [...store.keys()].filter((path) => path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes('/') && filters.every((filter) => filter(store.get(path)))).map(snapshot) };
      result.forEach = (callback) => result.docs.forEach(callback);
      if (h.afterScan) await h.afterScan(prefix);
      return result;
    },
  });
  h.collection = collection;
  h.collectionGroup = (name) => ({ get: async () => ({
    docs: [...store.keys()].filter((path) => path.split('/').at(-2) === name).map(snapshot),
  }) });
  h.runTransaction = async (callback) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const reads = new Map();
      const writes = [];
      const tx = { get: async (r) => { reads.set(r.path, versions.get(r.path) || 0); return snapshot(r.path); },
        create: (r, data) => { assert.equal(store.has(r.path), false); writes.push({ path: r.path, data: clone(data) }); },
        set: (r, data, options) => writes.push({ path: r.path, data: clone(data), options }),
        delete: (r) => writes.push({ path: r.path }) };
      const result = await callback(tx);
      if (h.beforeCommit) await h.beforeCommit(writes);
      if ([...reads].some(([path, version]) => (versions.get(path) || 0) !== version)) { h.retries++; continue; }
      writes.forEach(({ path, data, options }) => h.write(path, data, options));
      return result;
    }
    throw new Error('Conflict retries exhausted');
  };
  h.batch = () => {
    const writes = [];
    return { set: (r, data, options) => writes.push({ path: r.path, data, options }), delete: (r) => writes.push({ path: r.path }),
      commit: async () => { if (h.failBatch) throw new Error('Injected batch failure'); writes.forEach(({ path, data, options }) => h.write(path, data, options)); } };
  };
  active = h;
  return h;
}

test('deletion preserves committed joins, claims, settled state and observation additions across transaction retries', async () => {
  const h = harness();
  const injected = new Set();
  const firstIds = new Map();
  h.beforeCommit = (writes) => {
    for (const write of writes) {
      if (!['groups/g1', 'sessions/s1', 'history/h1', 'restaurant_observations/o1'].includes(write.path) || injected.has(write.path)) continue;
      injected.add(write.path);
      const row = clone(h.store.get(write.path));
      if (write.path.startsWith('restaurant_')) { row.observedByVisitIds.push('concurrent'); row.evidenceCount = 2; }
      else {
        firstIds.set(write.path, write.data.members.find((member) => member.deletedAccount).id);
        row.members.push({ id: 'charlie', name: 'Charlie', settled: true });
        row.items[0].claimedBy.push('charlie');
        row.status = 'settled'; row.settledAt = 1234; row.members.forEach((member) => { member.settled = true; });
      }
      h.write(write.path, row);
    }
  };
  const result = await db.deleteUserAccountData(uid);
  assert.equal(result.deleted, true);
  assert.equal(h.retries, 4);
  for (const path of ['groups/g1', 'sessions/s1', 'history/h1']) {
    const row = h.store.get(path);
    assert.equal(row.status, 'settled'); assert.equal(row.settledAt, 1234);
    assert.equal(row.members.find((member) => member.id === 'bob').settled, true);
    assert.ok(row.members.some((member) => member.id === 'charlie'));
    assert.ok(row.items[0].claimedBy.includes('charlie'));
    assert.equal(row.members.find((member) => member.deletedAccount).id, firstIds.get(path));
    assert.equal(JSON.stringify(row).includes(uid), false);
  }
  assert.equal(new Set(firstIds.values()).size, 1);
  assert.deepEqual(h.store.get('restaurant_observations/o1'), { observedByVisitIds: ['other', 'concurrent'], evidenceCount: 2 });
  assert.equal(h.store.has(`_account_deletions/${uid}`), false);
});

test('a document deleted after candidate discovery is never recreated', async () => {
  const h = harness();
  h.afterScan = (name) => { if (name === 'sessions') h.write('sessions/s1', undefined); };
  await db.deleteUserAccountData(uid);
  assert.equal(h.store.has('sessions/s1'), false);
});

test('partial deletion retry keeps linked anonymous IDs and removes observation references before deleting visits', async () => {
  const h = harness();
  let failOnce = true;
  h.beforeCommit = (writes) => { if (failOnce && writes.some((write) => write.path === 'sessions/s1')) { failOnce = false; throw new Error('Injected room failure'); } };
  await assert.rejects(db.deleteUserAccountData(uid), /Injected room failure/);
  const priorId = h.store.get('groups/g1').members.find((member) => member.deletedAccount).id;
  assert.ok(h.store.has(`_account_deletions/${uid}`));
  h.beforeCommit = null; h.failBatch = true;
  await assert.rejects(db.deleteUserAccountData(uid), /Injected batch failure/);
  assert.deepEqual(h.store.get('restaurant_observations/o1'), { observedByVisitIds: ['other'], evidenceCount: 1 });
  assert.ok(h.store.has('restaurant_visits/v1'));
  assert.ok(h.store.has(`users/${uid}`));
  h.failBatch = false;
  await db.deleteUserAccountData(uid);
  assert.equal(h.store.get('sessions/s1').members.find((member) => member.deletedAccount).id, priorId);
  assert.equal(h.store.get('history/h1').members.find((member) => member.deletedAccount).id, priorId);
  assert.equal(h.store.has('restaurant_visits/v1'), false);
  assert.equal(h.store.has(`users/${uid}`), false);
  const before = clone([...h.store]);
  assert.equal((await db.deleteUserAccountData(uid)).deleted, false);
  assert.deepEqual([...h.store], before);
});

test('late deletion completion cannot erase a newer retry job or its profile', async () => {
  const h = harness(); let injected = false;
  h.beforeCommit = (writes) => {
    if (!injected && writes.some((write) => write.path === `users/${uid}` && write.data === undefined)) {
      injected = true; h.write(`_account_deletions/${uid}`, { seed: 'new-operation-seed' });
    }
  };
  await assert.rejects(db.deleteUserAccountData(uid), /Account cleanup changed/);
  assert.equal(h.store.get(`_account_deletions/${uid}`).seed, 'new-operation-seed');
  assert.ok(h.store.has(`users/${uid}`));
});

test('profile synchronization preserves a group index and settings committed after its read', async () => {
  const h = harness(new Map([
    ['users/alice', { id: 'alice', username: 'Alice', phone: '0501234567', groups: ['old'], bills: [{ id: 'b1' }], settings: { theme: 'light' } }],
    ['groups/new', { id: 'new', status: 'active', members: [{ id: 'alice', userId: 'alice', active: true }] }],
  ]));
  let injected = false;
  h.beforeCommit = async (writes) => {
    if (!injected && writes.some((write) => write.path === 'users/alice')) {
      injected = true;
      await db.addGroupToUser('alice', 'new');
      h.write('users/alice', { settings: { theme: 'dark', currency: 'USD' } }, { merge: true });
    }
  };
  await db.findOrCreateUser('alice', 'Updated', '0501234567', { language: 'he' });
  const user = h.store.get('users/alice');
  assert.deepEqual(user.groups, ['old', 'new']); assert.deepEqual(user.bills, [{ id: 'b1' }]);
  assert.deepEqual(user.settings, { theme: 'dark', currency: 'USD', language: 'he' });
  assert.equal(user.username, 'Updated'); assert.ok(h.retries > 0);
  await db.saveUser({ id: 'alice', avatarUrl: 'https://example.invalid/avatar' }, 'alice');
  assert.deepEqual(h.store.get('users/alice').groups, ['old', 'new']);
  assert.equal(h.store.get('users/alice').phone, user.phone);
  assert.equal(h.store.get('users/alice').username_lowercase, 'updated');
  assert.equal(h.store.get('users/alice').phoneAssurance, user.phoneAssurance);
});

test('late new rooms and joins cannot escape the account deletion scan', async () => {
  const h = harness();
  const staleRoom = { ...clone(h.store.get('sessions/s1')), id: 'late-room' };
  let attempts = 0;
  h.afterScan = async (name) => {
    if (name !== 'sessions') return;
    await assert.rejects(db.createSessionIfAbsent(staleRoom), { errorCode: 'ACCOUNT_DELETED' }); attempts++;
    await assert.rejects(db.saveGroup({ ...staleRoom, id: 'late-group', bills: [] }), { errorCode: 'ACCOUNT_DELETED' }); attempts++;
    await assert.rejects(db.transactGroupMembership('g1', (group) => {
      group.members.push(staleRoom.members[0]); return group;
    }), { errorCode: 'ACCOUNT_DELETED' }); attempts++;
  };
  await db.deleteUserAccountData(uid);
  assert.equal(attempts, 3);
  assert.equal(h.store.has('sessions/late-room'), false);
  assert.equal(h.store.has('groups/late-group'), false);
  assert.equal(JSON.stringify(h.store.get('groups/g1')).includes(uid), false);
  assert.deepEqual(Object.keys(h.store.get(fencePath(uid))), ['deletedAt']);
});

test('a creation that read no fence retries and rejects when deletion wins the commit race', async () => {
  const h = harness();
  const staleRoom = { ...clone(h.store.get('sessions/s1')), id: 'late-commit' };
  let injected = false;
  h.beforeCommit = async (writes) => {
    if (!injected && writes.some((write) => write.path === 'sessions/late-commit')) {
      injected = true;
      await db.deleteUserAccountData(uid);
    }
  };
  await assert.rejects(db.createSessionIfAbsent(staleRoom), { errorCode: 'ACCOUNT_DELETED' });
  assert.equal(injected, true);
  assert.equal(h.retries, 1);
  assert.equal(h.store.has('sessions/late-commit'), false);
  assert.equal(h.store.has(`users/${uid}`), false);
});

test('finished deletion fences stale profile, history, room and restaurant identity writers', async () => {
  const h = harness();
  const staleRoom = clone(h.store.get('sessions/s1'));
  const staleGroup = clone(h.store.get('groups/g1'));
  const staleHistory = clone(h.store.get('history/h1'));
  const visitSession = { ...staleRoom, restaurant: { id: 'rest_fence', confidence: 1, identityBasis: 'name_only_session' } };
  await db.deleteUserAccountData(uid);
  const before = clone([...h.store]);
  const writes = [
    () => db.saveUser({ id: uid, username: 'Restored' }, uid),
    () => db.saveUser({ id: 'bob', bills: [staleHistory] }, 'bob'),
    () => db.findOrCreateUser(uid, 'Restored', '0501234567'),
    () => db.addUserBill(uid, 'Restored', '0501234567', staleHistory),
    () => db.saveSession(staleRoom),
    () => db.saveGroup(staleGroup),
    () => db.saveGroupAndSession(staleGroup, staleRoom),
    () => db.addToHistory(staleHistory),
    () => db.saveSessionAndHistory(staleRoom, staleHistory),
    () => db.recordRestaurantVisit(visitSession, staleRoom.members[0]),
    () => db.transactSessionAndLinkedGroup('s1', (session) => ({ session, history: staleHistory })),
    () => db.saveGroupBillAndSession('g1', staleGroup.bills[0], staleRoom, 'bob'),
  ];
  for (const write of writes) await assert.rejects(write(), { errorCode: 'ACCOUNT_DELETED' });
  assert.deepEqual([...h.store], before);
  const current = await db.transactSessionAndLinkedGroup('s1', (session) => {
    session.members.find((member) => member.id === 'bob').settled = true;
    return { session };
  });
  assert.equal(current.session.members.find((member) => member.id === 'bob').settled, true);
  assert.deepEqual(current.session.items, h.store.get('sessions/s1').items);
  await db.findOrCreateUser('replacement-account', 'New Account', '0501234567');
  assert.equal(h.store.get('users/replacement-account').phone, '0501234567');
});

test('legacy shared bills in other profiles are anonymized without losing concurrent profile or bill updates', async () => {
  const h = harness();
  const shared = { ...clone(h.store.get('history/h1')), amount: 100 };
  h.write('users/bob', { id: 'bob', username: 'Bob', phone: '0507777777', settings: { theme: 'dark' }, groups: ['g1'], bills: [shared] });
  let injected = false;
  h.beforeCommit = (writes) => {
    if (!injected && writes.some((write) => write.path === 'users/bob' && write.data?.bills)) {
      injected = true;
      h.write('users/bob', { username: 'Bob Updated', bills: [shared, { id: 'concurrent-bill', amount: 27 }] }, { merge: true });
    }
  };
  await db.deleteUserAccountData(uid);
  const bob = h.store.get('users/bob');
  assert.equal(injected, true);
  assert.equal(bob.username, 'Bob Updated');
  assert.equal(bob.phone, '0507777777');
  assert.deepEqual(bob.settings, { theme: 'dark' });
  assert.deepEqual(bob.groups, ['g1']);
  assert.equal(bob.bills[0].amount, 100);
  assert.deepEqual(bob.bills[1], { id: 'concurrent-bill', amount: 27 });
  assert.equal(JSON.stringify(bob).includes(uid), false);
  const deletedId = h.store.get('history/h1').members.find((member) => member.deletedAccount).id;
  assert.equal(bob.bills[0].members.find((member) => member.deletedAccount).id, deletedId);
  assert.deepEqual(bob.bills[0].items[0].claimedBy, [deletedId, 'bob']);
  h.beforeCommit = null;
  await assert.rejects(db.addUserBill('bob', 'Bob Updated', '0507777777', shared), { errorCode: 'ACCOUNT_DELETED' });
  assert.equal(JSON.stringify(h.store.get('users/bob')).includes(uid), false);
});

test('legacy history subcollections retain fresh financial changes and stable anonymization after retry', async () => {
  const h = harness();
  const history = clone(h.store.get('history/h1'));
  const nestedPath = 'users/bob/history/legacy';
  const orphanPath = 'users/missing-profile/history/legacy';
  h.write(nestedPath, { ...history, id: 'legacy', storeName: 'Cafe', amount: 100 });
  h.write(orphanPath, { ...history, id: 'legacy', storeName: 'Cafe', amount: 100 });
  const pointer = { historyId: 'h1', settledAt: 123 };
  h.write('users/bob/history/pointer', pointer);
  let interrupted = false;
  h.beforeCommit = (writes) => {
    if (!interrupted && writes.some((write) => write.path === nestedPath)) {
      interrupted = true;
      throw new Error('Interrupted nested history cleanup');
    }
  };
  await assert.rejects(db.deleteUserAccountData(uid), /Interrupted nested history cleanup/);
  const anonymousId = h.store.get('history/h1').members.find((member) => member.deletedAccount).id;
  let concurrent = false;
  h.beforeCommit = (writes) => {
    if (!concurrent && writes.some((write) => write.path === nestedPath)) {
      concurrent = true;
      const latest = clone(h.store.get(nestedPath));
      latest.amount = 125;
      latest.items.push({ id: 'concurrent-item', price: 25, claimedBy: ['bob'] });
      h.write(nestedPath, latest);
    }
  };
  await db.deleteUserAccountData(uid);
  assert.equal(concurrent, true);
  assert.equal(h.retries, 1);
  for (const path of [nestedPath, orphanPath]) {
    const stored = h.store.get(path);
    assert.equal(stored.members.find((member) => member.deletedAccount).id, anonymousId);
    assert.equal(JSON.stringify(stored).includes(uid), false);
    assert.equal(JSON.stringify(stored).includes('0501234567'), false);
  }
  assert.equal(h.store.get(nestedPath).amount, 125);
  assert.deepEqual(h.store.get(nestedPath).items[1], { id: 'concurrent-item', price: 25, claimedBy: ['bob'] });
  assert.deepEqual(h.store.get('users/bob/history/pointer'), pointer);
});

test('history deletion cannot restore identity or discard bills from a stale profile scan', async () => {
  const h = harness();
  const shared = clone(h.store.get('history/h1'));
  h.write('users/bob', { id: 'bob', bills: [shared, { id: 'remove-history' }] });
  let concurrent = false;
  h.afterScan = async (name) => {
    if (!concurrent && name === 'users') {
      concurrent = true;
      await db.deleteUserAccountData(uid);
      const current = h.store.get('users/bob');
      h.write('users/bob', { ...current, bills: [...current.bills, { id: 'concurrent-bill', amount: 25 }] });
    }
  };
  await db.deleteHistory('remove-history');
  const bills = h.store.get('users/bob').bills;
  assert.equal(concurrent, true);
  assert.equal(JSON.stringify(bills).includes(uid), false);
  assert.deepEqual(bills.map((bill) => bill.id), ['h1', 'concurrent-bill']);
  assert.equal(h.store.has(`users/${uid}`), false);
});

test('deletion completion requires a durable fence and no remaining profile or cleanup job', async () => {
  const h = harness(new Map());
  assert.equal(await db.isAccountDeletionComplete(uid), false);
  h.write(fencePath(uid), { deletedAt: 1 });
  h.write(`users/${uid}`, { id: uid });
  assert.equal(await db.isAccountDeletionComplete(uid), false);
  h.write(`users/${uid}`, undefined);
  h.write(`_account_deletions/${uid}`, { seed: 'pending' });
  assert.equal(await db.isAccountDeletionComplete(uid), false);
  h.write(`_account_deletions/${uid}`, undefined);
  assert.equal(await db.isAccountDeletionComplete(uid), true);
  let injected = false;
  h.beforeCommit = () => {
    if (!injected) {
      injected = true;
      h.write(`_account_deletions/${uid}`, { seed: 'concurrent-retry' });
    }
  };
  assert.equal(await db.isAccountDeletionComplete(uid), false);
  assert.equal(h.retries, 1);
});
