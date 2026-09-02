const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Google and Apple share the persistent Firebase account boundary', () => {
  const ctx = read('src/components/LanguageContext.tsx');
  const firebase = read('lib/firebase.ts');
  const apple = read('lib/nativeAppleAuth.ts');

  assert.match(firebase, /initializeAuth\(app, \{ persistence: browserLocalPersistence \}\)/);
  assert.match(ctx, /const loginWithGoogle = async/);
  assert.match(ctx, /const loginWithApple = async/);
  assert.match(ctx, /if \(activeAuth\.currentUser && !options\.forceAccountSelection\)/);
  assert.match(ctx, /if \(auth\.currentUser\)[\s\S]*return 'authenticated'/);
  assert.match(ctx, /new OAuthProvider\('apple\.com'\)/);
  assert.match(ctx, /provider\.credential\(\{[\s\S]*idToken: apple\.idToken,[\s\S]*rawNonce: apple\.rawNonce/);
  assert.match(apple, /Capacitor\.getPlatform\(\) === 'ios'/);
});

test('first-time onboarding requires a name and a valid 10-digit Israeli mobile number', () => {
  const ctx = read('src/components/LanguageContext.tsx');
  const phone = read('lib/bitDeepLink.ts');

  assert.ok(phone.includes('/^05\\d{8}$/'));
  assert.match(ctx, /showAuthenticatedProfileCompletion[\s\S]*!profile\.displayName\.trim\(\)[\s\S]*!profile\.phoneNumber[\s\S]*!isValidIsraeliPhone/);
  assert.match(ctx, /const displayName = guestName\.trim\(\)/);
  assert.match(ctx, /const phoneNumber = cleanIsraeliPhone\(guestPhone\)/);
  assert.match(ctx, /if \(!displayName \|\| !isValidIsraeliPhone\(phoneNumber\)\) return/);
  assert.match(ctx, /localStorage\.setItem\('billsplit_phone', phoneNumber\)/);
  assert.match(ctx, /fetch\(apiUrl\('\/api\/user\/sync'\)/);
});

test('completed profile is not asked for onboarding again', () => {
  const ctx = read('src/components/LanguageContext.tsx');
  const server = read('server.js');
  assert.match(ctx, /showProfileModal = showOnboarding \|\| showAuthenticatedProfileCompletion/);
  assert.match(ctx, /phoneNumber: data\.user\.phone \|\| savedLocalProfile\?\.phoneNumber/);
  assert.match(ctx, /setGuestPhone\(profile\.phoneNumber \|\| ''\)/);
  assert.match(ctx, /username: savedLocalProfile\?\.displayName \|\| ''/);
  assert.match(server, /username \|\| existingUser\?\.username \|\| name \|\| 'User'/);
});

test('account deletion is authenticated, permanent, and wired through Settings', () => {
  const server = read('server.js');
  const ctx = read('src/components/LanguageContext.tsx');
  const page = read('src/app/page.tsx');

  assert.match(server, /server\.delete\('\/api\/user\/account', authenticateUser/);
  assert.match(server, /if \(!req\.user\)[\s\S]*status\(401\)/);
  assert.match(server, /provider === 'apple\.com'[\s\S]*revokeAppleAuthorization\(req\.body\?\.authorizationCode\)[\s\S]*db\.deleteUserAccountData\(uid\)/);
  assert.match(server, /getAuth\(\)\.deleteUser\(uid\)/);
  assert.match(ctx, /providerId === 'apple\.com'[\s\S]*signInNativeApple\(\)[\s\S]*authorizationCode = apple\.authorizationCode/);
  assert.match(ctx, /fetch\(apiUrl\('\/api\/user\/account'\), \{[\s\S]*method: 'DELETE'[\s\S]*authorizationCode/);
  assert.match(ctx, /clearAccountScopedStorage\(localStorage\)/);
  assert.match(page, /Delete account/);
  assert.match(page, /Delete permanently/);
});

test('Apple remains an optional iOS choice and never replaces Google', () => {
  const ctx = read('src/components/LanguageContext.tsx');
  const page = read('src/app/page.tsx');
  assert.match(ctx, /Sign in with Google/);
  assert.match(ctx, /Sign in with Apple/);
  assert.match(ctx, /Capacitor\.getPlatform\(\) === 'ios'/);
  assert.match(page, /Capacitor\.getPlatform\(\) === 'ios'/);
  assert.match(page, /loginWithGoogle/);
  assert.match(page, /loginWithApple/);
});
