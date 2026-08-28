const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pageSource = fs.readFileSync(path.join(__dirname, '../src/app/page.tsx'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const firebaseSource = fs.readFileSync(path.join(__dirname, '../lib/firebase.ts'), 'utf8');
const languageContextSource = fs.readFileSync(path.join(__dirname, '../src/components/LanguageContext.tsx'), 'utf8');

test('camera and gallery receipt selection have no Google authentication gate', () => {
  assert.doesNotMatch(pageSource, /ensureAuthenticatedForScan/);
  assert.doesNotMatch(pageSource, /sign in with Google to scan receipts/i);
  assert.match(pageSource, /const handleScanCamera = async \(\) => \{\s+if \(Capacitor\.isNativePlatform\(\)\)/);
  assert.match(pageSource, /const handlePhotoUpload = async[\s\S]*?setIsUploading\(true\)/);
});

test('anonymous OCR stays open while new-room creation requires an account', () => {
  const sessionJoinRoute = serverSource.split('\n').find((line) => line.includes("/api/session/:idOrCode/join'")) || '';
  const groupJoinRoute = serverSource.split('\n').find((line) => line.includes("/api/groups/join'")) || '';
  assert.match(serverSource, /requireAuth: false/);
  assert.match(serverSource, /\/api\/receipt\/scan'[\s\S]*?security\.requireAuthenticatedCreator/);
  assert.match(serverSource, /\/api\/groups'[\s\S]*?security\.requireAuthenticatedCreator/);
  assert.match(sessionJoinRoute, /authenticateUser, roomJoinRateLimit/);
  assert.doesNotMatch(sessionJoinRoute, /requireAuthenticatedCreator/);
  assert.match(groupJoinRoute, /authenticateUser, roomJoinRateLimit/);
  assert.doesNotMatch(groupJoinRoute, /requireAuthenticatedCreator/);
});

test('one-time Google login uses explicit local persistence and resumes creator intent', () => {
  assert.match(firebaseSource, /browserLocalPersistence/);
  assert.match(firebaseSource, /setPersistence\(auth, browserLocalPersistence\)/);
  assert.match(pageSource, /saveCreatorIntent\(sessionStorage/);
  assert.match(pageSource, /readCreatorIntent\(sessionStorage\)/);
});

test('cancelled or failed Google login cannot leave a stale creator intent', () => {
  assert.match(languageContextSource, /GoogleLoginResult = 'authenticated' \| 'redirecting' \| 'cancelled' \| 'failed' \| 'busy'/);
  assert.match(languageContextSource, /isNativeGoogleSignInCancellation\(e\)[\s\S]*?result = 'cancelled'/);
  assert.match(languageContextSource, /auth\/popup-closed-by-user'[\s\S]*?return 'cancelled'/);
  assert.equal(
    (pageSource.match(/loginResult === 'cancelled' \|\| loginResult === 'failed'/g) || []).length,
    2
  );
  assert.equal((pageSource.match(/clearCreatorIntent\(sessionStorage\)/g) || []).length, 3);
});
