const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyCutover,
  publicSummary,
  snapshotDocument,
  validateLocalData,
  verifySnapshotPayload,
} = require('../scripts/safe-firestore-cutover');

function remoteCollections() {
  return {
    users: new Map(),
    sessions: new Map(),
    groups: new Map(),
    history: new Map(),
  };
}

test('cutover classifies exact, conflicting, and safe missing records without raw ids', () => {
  const remote = remoteCollections();
  remote.users.set('user-exact', { id: 'user-exact', name: 'A', updatedAt: 200 });
  remote.users.set('user-conflict', { id: 'user-conflict', name: 'remote' });
  const result = classifyCutover({
    users: {
      first: { id: 'user-exact', name: 'A', updatedAt: 100 },
      second: { id: 'user-conflict', name: 'local' },
      third: { id: 'user-missing', name: 'missing' },
    },
    sessions: {},
    groups: {},
    history: [],
  }, remote);
  assert.deepEqual(result.exact.users, ['user-exact']);
  assert.deepEqual(result.conflicts.users, ['user-conflict']);
  assert.deepEqual(result.safeMissing.users, ['user-missing']);
  const summary = JSON.stringify(publicSummary(result));
  assert.equal(summary.includes('user-exact'), false);
  assert.equal(summary.includes('user-conflict'), false);
  assert.equal(summary.includes('user-missing'), false);
});

test('cutover recognizes only explicitly settled and deleted records as archived', () => {
  const remote = remoteCollections();
  const history = { id: 'session-1', groupId: 'group-1', status: 'settled', items: [] };
  remote.history.set(history.id, history);
  const result = classifyCutover({
    users: {},
    sessions: { 'session-1': { id: 'session-1', groupId: 'group-1', status: 'settled' } },
    groups: { 'group-1': { id: 'group-1', status: 'deleted', bills: [{ sessionId: 'session-1' }] } },
    history: [history],
  }, remote);
  assert.deepEqual(result.archivedMissing.sessions, ['session-1']);
  assert.deepEqual(result.archivedMissing.groups, ['group-1']);
  assert.deepEqual(result.safeMissing.sessions, []);
  assert.deepEqual(result.safeMissing.groups, []);
});

test('cutover never hides an active session or an undeleted group as archived', () => {
  const remote = remoteCollections();
  const history = { id: 'session-1', groupId: 'group-1', status: 'settled', items: [] };
  remote.history.set(history.id, history);
  const result = classifyCutover({
    users: {},
    sessions: { 'session-1': { id: 'session-1', groupId: 'group-1', status: 'active' } },
    groups: { 'group-1': { id: 'group-1', bills: [{ sessionId: 'session-1' }] } },
    history: [history],
  }, remote);
  assert.deepEqual(result.archivedMissing.sessions, []);
  assert.deepEqual(result.archivedMissing.groups, []);
  assert.deepEqual(result.safeMissing.sessions, ['session-1']);
  assert.deepEqual(result.safeMissing.groups, ['group-1']);
  assert.equal(result.operationalParity, false);
});

test('snapshot round-trips the exact JSON bytes and checksum', () => {
  const bytes = Buffer.from('{"users":{},"sessions":{},"groups":{},"history":[]}\n');
  const snapshot = snapshotDocument(bytes, JSON.parse(bytes.toString('utf8')));
  assert.equal(verifySnapshotPayload(snapshot.data), true);
  assert.equal(snapshot.data.byteLength, bytes.length);
});

test('cutover rejects duplicate and missing ids before any write', () => {
  const duplicate = { id: 'same' };
  const result = validateLocalData({
    users: { first: duplicate, second: duplicate },
    sessions: { broken: { name: 'missing id' } },
    groups: {},
    history: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.includes('users:duplicate-id'), true);
  assert.equal(result.errors.includes('sessions:missing-id'), true);
});

test('legacy user root keys are warnings because embedded ids are canonical', () => {
  const result = validateLocalData({
    users: { legacy_alias: { id: 'canonical-user-id' } },
    sessions: {},
    groups: {},
    history: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, ['users:legacy-root-key-mismatch:1']);
});
