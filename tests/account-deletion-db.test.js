const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-delete-account-'));
const dbPath = path.join(tempDir, 'db.json');
process.env.BILLSPLIT_DB_PATH = dbPath;
process.env.NODE_ENV = 'test';

fs.writeFileSync(dbPath, JSON.stringify({
  users: {
    'firebase-uid': { id: 'firebase-uid', username: 'Alice', phone: '0501234567', groups: ['g1'] },
    other: { id: 'other', username: 'Bob', phone: '0500000000', groups: ['g1'] },
  },
  groups: {
    g1: {
      id: 'g1',
      members: [
        { id: 'firebase-uid', userId: 'firebase-uid', name: 'Alice', phone: '0501234567', isHost: true },
        { id: 'other', userId: 'other', name: 'Bob', phone: '0500000000', isHost: false },
      ],
      bills: [{ id: 'b1', payerId: 'firebase-uid', items: [{ id: 'i1', claimedBy: ['firebase-uid', 'other'] }] }],
    },
  },
  sessions: {
    s1: {
      id: 's1', hostName: 'Alice', hostPhone: '0501234567',
      members: [
        { id: 'firebase-uid', userId: 'firebase-uid', name: 'Alice', phone: '0501234567', isHost: true },
        { id: 'other', userId: 'other', name: 'Bob', phone: '0500000000', isHost: false },
      ],
      payerId: 'firebase-uid',
      items: [{ id: 'i1', claimedBy: ['firebase-uid', 'other'] }],
    },
  },
  history: [{
    id: 's1', memberIds: ['firebase-uid', 'other'],
    members: [
      { id: 'firebase-uid', userId: 'firebase-uid', name: 'Alice', isHost: true },
      { id: 'other', userId: 'other', name: 'Bob', isHost: false },
    ],
    payerId: 'firebase-uid', items: [{ id: 'i1', claimedBy: ['firebase-uid', 'other'] }],
  }],
  historyPointers: { 'firebase-uid': [{ historyId: 's1' }], other: [{ historyId: 's1' }] },
  restaurants: {},
  restaurantVisits: {
    v1: { id: 'v1', userId: 'firebase-uid', identityAliases: ['user:firebase-uid'], displayNameSnapshot: 'Alice' },
    v2: { id: 'v2', userId: 'other', identityAliases: ['user:other'], displayNameSnapshot: 'Bob' },
  },
  restaurantObservations: {
    o1: { id: 'o1', submittedByUserId: 'firebase-uid', submittedByVisitId: 'v1', observedByVisitIds: ['v1', 'v2'] },
  },
}));

const db = require('../lib/db');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('deleteUserAccountData removes the account and anonymizes shared records', async () => {
  const result = await db.deleteUserAccountData('firebase-uid');
  assert.equal(result.deleted, true);
  assert.equal(result.deletedVisits, 1);
  assert.equal(result.anonymizedRecords, 3);

  const stored = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(stored.users['firebase-uid'], undefined);
  assert.ok(stored.users.other);
  assert.equal(stored.historyPointers['firebase-uid'], undefined);
  assert.ok(stored.historyPointers.other);
  assert.equal(stored.restaurantVisits.v1, undefined);
  assert.ok(stored.restaurantVisits.v2);
  assert.equal(stored.restaurantObservations.o1.submittedByUserId, undefined);
  assert.equal(stored.restaurantObservations.o1.submittedByVisitId, undefined);
  assert.deepEqual(stored.restaurantObservations.o1.observedByVisitIds, ['v2']);

  const serialized = JSON.stringify({ groups: stored.groups, sessions: stored.sessions, history: stored.history });
  assert.equal(serialized.includes('firebase-uid'), false);
  assert.ok(serialized.includes('Deleted user'));
  assert.ok(serialized.includes('other'));
  const deletedGroupMember = stored.groups.g1.members.find((member) => member.deletedAccount);
  const deletedSessionMember = stored.sessions.s1.members.find((member) => member.deletedAccount);
  const deletedHistoryMember = stored.history[0].members.find((member) => member.deletedAccount);
  assert.equal(deletedGroupMember.id, deletedSessionMember.id);
  assert.equal(deletedGroupMember.id, deletedHistoryMember.id);
  assert.equal(stored.groups.g1.bills[0].payerId, deletedGroupMember.id);
  assert.equal(stored.sessions.s1.payerId, deletedGroupMember.id);
});
