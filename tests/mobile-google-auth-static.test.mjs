import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');

const WEB_CLIENT_ID = '510350845002-o6t8t84c5fnvncgkspqdit0s0ndgsir9.apps.googleusercontent.com';
const IOS_CLIENT_ID = '510350845002-11pq3jtk5vb5f2kv1nrn1jqd02f04dqp.apps.googleusercontent.com';
const IOS_URL_SCHEME = 'com.googleusercontent.apps.510350845002-11pq3jtk5vb5f2kv1nrn1jqd02f04dqp';

test('native Google auth dependency is exact and keeps Firebase JS pinned', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.dependencies['@capawesome/capacitor-google-sign-in'], '0.1.3');
  assert.equal(pkg.dependencies.firebase, '12.18.0');
  assert.equal(pkg.dependencies['@capacitor/core'], '8.5.0');
});

test('native Google auth uses Capacitor platform detection and exchanges only an ID token', async () => {
  const helper = await read('lib/nativeGoogleAuth.ts');
  assert.match(helper, /Capacitor\.isNativePlatform\(\)/);
  assert.match(helper, new RegExp(WEB_CLIENT_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(helper, /GoogleSignIn\.initialize\(\{ clientId: GOOGLE_WEB_CLIENT_ID \}\)/);
  assert.match(helper, /GoogleSignIn\.signIn\(\)/);
  assert.match(helper, /forceAccountSelection/);
  assert.match(helper, /GoogleSignIn\.signOut\(\)/);
  assert.doesNotMatch(helper, /scopes\s*:/);
  assert.doesNotMatch(helper, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(helper, /console\.(log|debug)\([^\n]*(idToken|accessToken)/);
});

test('LanguageContext uses popup-only web auth and Firebase JS credential exchange on native', async () => {
  const source = await read('src/components/LanguageContext.tsx');
  assert.match(source, /isNativeGoogleAuthPlatform\(\)/);
  assert.match(source, /signInNativeGoogle\(\{[\s\S]*?forceAccountSelection: options\.forceAccountSelection \|\| Boolean\(activeAuth\.currentUser\)/);
  assert.match(source, /GoogleAuthProvider\.credential\(idToken\)/);
  assert.match(source, /signInWithCredential\(activeAuth, credential\)/);
  assert.match(source, /signInWithPopup/);
  assert.doesNotMatch(source, /signInWithRedirect|getRedirectResult|isMobileDevice/);
  assert.match(source, /signOutNativeGoogle\(\)/);
  assert.match(
    source,
    /if \(isNativeGoogleAuthPlatform\(\)\) \{[\s\S]*?setAuthModules\(\{ auth, googleProvider, getGoogleProvider \}\);[\s\S]*?return;[\s\S]*?await ensureAuthPersistence\(\);[\s\S]*?signInWithPopup/,
  );
  assert.match(
    source,
    /if \(!activeAuth\) \{[\s\S]*?activeAuth = firebaseModule\.auth;[\s\S]*?if \(!nativeAuthPlatform\) \{[\s\S]*?await firebaseModule\.ensureAuthPersistence\(\);/,
  );
  assert.ok(
    source.indexOf('if (nativeAuthPlatform)') < source.indexOf('activeSignInWithPopup(activeAuth, provider)'),
    'native platform branch must run before Firebase web popup auth',
  );
});

test('iOS contains the issued client ID and callback scheme', async () => {
  const plist = await read('ios/App/App/Info.plist');
  assert.match(plist, new RegExp(IOS_CLIENT_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(plist, new RegExp(IOS_URL_SCHEME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(plist, /<key>GIDClientID<\/key>/);
  assert.match(plist, /<key>CFBundleURLTypes<\/key>/);
});

test('Capacitor generated projects wire the Google Sign-In plugin on iOS and Android', async () => {
  const iosPackage = await read('ios/App/CapApp-SPM/Package.swift');
  const androidSettings = await read('android/capacitor.settings.gradle');
  const androidBuild = await read('android/app/capacitor.build.gradle');

  assert.match(iosPackage, /CapawesomeCapacitorGoogleSignIn/);
  assert.match(iosPackage, /@capawesome\/capacitor-google-sign-in/);
  assert.match(androidSettings, /include ':capawesome-capacitor-google-sign-in'/);
  assert.match(androidSettings, /@capawesome\/capacitor-google-sign-in\/android/);
  assert.match(androidBuild, /implementation project\(':capawesome-capacitor-google-sign-in'\)/);
});
