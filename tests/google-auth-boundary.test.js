const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const homeSource = read('src/app/page.tsx');
const sessionSource = read('src/app/session/[id]/page.tsx');
const groupSource = read('src/app/group/[id]/page.tsx');
const serverSource = read('server.js');

test('split and group creation require a valid profile but never require Google', () => {
  const protectedCreatorRoutes = serverSource
    .split('\n')
    .filter((line) => line.includes('server.post(') && line.includes('requireValidCreatorProfile'));

  assert.equal(protectedCreatorRoutes.length, 2);
  assert.match(protectedCreatorRoutes[0], /\/api\/receipt\/scan/);
  assert.match(protectedCreatorRoutes[1], /\/api\/groups/);
  assert.equal((homeSource.match(/if \(!firebaseUser\) \{/g) || []).length, 0);
  assert.doesNotMatch(serverSource, /security\.requireAuthenticatedCreator/);
});

test('invited session and group screens contain no Google login gate', () => {
  assert.doesNotMatch(sessionSource, /firebaseUser|loginWithGoogle|signInWithGoogle/);
  assert.doesNotMatch(groupSource, /firebaseUser|loginWithGoogle|signInWithGoogle/);
});

test('receipt capture and parsing remain available before account creation', () => {
  assert.match(homeSource, /const handleScanCamera = async/);
  assert.match(homeSource, /const handlePhotoUpload = async/);
  assert.doesNotMatch(homeSource, /ensureAuthenticatedForScan|sign in with Google to scan receipts/i);
  assert.match(serverSource, /\/api\/receipt\/parse', authenticateUser/);
});
