const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  compareDatasets,
  containsLocalState,
  opaqueId,
} = require('../scripts/verify-firestore-parity');

function emptyRemote() {
  return {
    users: new Map(),
    sessions: new Map(),
    groups: new Map(),
    history: new Map(),
  };
}

test('Firestore parity accepts only the explicit top-level metadata allowlist', () => {
  assert.equal(containsLocalState(
    { id: 'user-1', name: 'A', updatedAt: 200, username_lowercase: 'a' },
    { id: 'user-1', name: 'A', updatedAt: 100 },
    'users',
  ), true);
  assert.equal(containsLocalState(
    { id: 'user-1', name: 'A', updatedAt: 200, serverOnly: true },
    { id: 'user-1', name: 'A', updatedAt: 100 },
    'users',
  ), false);
  assert.equal(containsLocalState(
    { id: 'user-1', profile: { updatedAt: 200 } },
    { id: 'user-1', profile: { updatedAt: 100 } },
    'users',
  ), false);
});

test('Firestore parity reports missing local records without exposing their ids', () => {
  const remote = emptyRemote();
  const result = compareDatasets({
    users: { first: { id: 'sensitive-user-id', createdAt: 100 } },
    sessions: {},
    groups: {},
    history: [],
  }, remote);
  assert.equal(result.collections.users.missing, 1);
  assert.deepEqual(result.collections.users.missingOpaqueIds, [opaqueId('sensitive-user-id')]);
  assert.equal(result.collections.users.missingOpaqueIds[0].includes('sensitive-user-id'), false);
  assert.equal(result.safeToRetireLocalRuntimeDependency, false);
});

test('Firestore parity treats newer divergent records as blocking conflicts', () => {
  const remote = emptyRemote();
  remote.sessions.set('session-1', { id: 'session-1', status: 'settled', updatedAt: 300 });
  remote.sessions.set('session-2', { id: 'session-2', status: 'active', createdAt: 400 });
  const result = compareDatasets({
    users: {},
    sessions: { 'session-1': { id: 'session-1', status: 'active', updatedAt: 200 } },
    groups: {},
    history: [],
  }, remote);
  assert.equal(result.collections.sessions.remoteNewer, 1);
  assert.equal(result.collections.sessions.needsReview, 1);
  assert.equal(result.collections.sessions.remoteOnly, 1);
  assert.equal(result.futureWritesObserved, true);
  assert.equal(result.safeToRetireLocalRuntimeDependency, false);
});

test('Firestore parity blocks same-age content conflicts for manual review', () => {
  const remote = emptyRemote();
  remote.groups.set('group-1', { id: 'group-1', amount: 20, updatedAt: 100 });
  const result = compareDatasets({
    users: {},
    sessions: {},
    groups: { 'group-1': { id: 'group-1', amount: 10, updatedAt: 100 } },
    history: [],
  }, remote);
  assert.equal(result.collections.groups.needsReview, 1);
  assert.equal(result.safeToRetireLocalRuntimeDependency, false);
});

test('production fails closed instead of silently using a local JSON database', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const result = spawnSync(process.execPath, ['-e', "require('./lib/db')"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      BILLSPLIT_DB_PATH: path.join(projectRoot, 'db.json'),
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Firestore must remain the authoritative datastore/);
});

test('the retired production JSON database is absent from the repository', () => {
  const projectRoot = path.resolve(__dirname, '..');
  assert.equal(require('node:fs').existsSync(path.join(projectRoot, 'db.json')), false);
  assert.equal(require('node:fs').existsSync(path.join(projectRoot, 'db.example.json')), true);
});
