const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Exercise lib/db's Firestore branch; this double applies optimistic conflict
// retries and lets a committed competing write land at a deterministic boundary.
let active;
const firestore = {
  settings() {},
  collection: (...args) => active.collection(...args),
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
    set: async (value, options) => h.write(path, value, options), collection: (name) => collection(`${path}/${name}`) });
  const snapshot = (path) => { const value = clone(store.get(path)); return { id: path.split('/').at(-1), ref: ref(path), exists: value !== undefined, data: () => clone(value) }; };
  const collection = (prefix, filters = []) => ({ doc: (id) => ref(`${prefix}/${id}`),
    where: (key, op, value) => collection(prefix, [...filters, (row) => op === 'array-contains' ? (row[key] || []).includes(value) : row[key] === value]),
    get: async () => {
      const result = { docs: [...store.keys()].filter((path) => path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes('/') && filters.every((filter) => filter(store.get(path)))).map(snapshot) };
      if (h.afterScan) await h.afterScan(prefix);
      return result;
    },
  });
  h.collection = collection;
  h.runTransaction = async (callback) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const reads = new Map();
      const writes = [];
      const tx = { get: async (r) => { reads.set(r.path, versions.get(r.path) || 0); return snapshot(r.path); },
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
