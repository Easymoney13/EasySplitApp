import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const requireMatch = (text, regex, message) => {
  if (!regex.test(text)) throw new Error(message);
};
const requireAbsent = (text, regex, message) => {
  if (regex.test(text)) throw new Error(message);
};

const capacitor = read('capacitor.config.ts');
const gradle = read('android/app/build.gradle');
const variables = read('android/variables.gradle');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const plist = read('ios/App/App/Info.plist');
const project = read('ios/App/App.xcodeproj/project.pbxproj');
const entitlements = read('ios/App/App/App.entitlements');

requireMatch(capacitor, /appId: 'com\.easysplit\.app'/, 'Capacitor appId drifted');
requireAbsent(capacitor, /server\s*:\s*\{[^}]*url\s*:/s, 'Production Capacitor config must not use server.url');
requireMatch(gradle, /applicationId "com\.easysplit\.app"/, 'Android applicationId drifted');
requireMatch(gradle, /versionCode 1/, 'Android versionCode is not release baseline 1');
requireMatch(gradle, /versionName "1\.0"/, 'Android versionName is not 1.0');
requireMatch(variables, /targetSdkVersion = 36/, 'Android target SDK must remain 36');
requireMatch(variables, /compileSdkVersion = 36/, 'Android compile SDK must remain 36');
requireAbsent(manifest, /android:debuggable\s*=\s*"true"/, 'Android release manifest must not be debuggable');
requireAbsent(manifest, /android:usesCleartextTraffic\s*=\s*"true"/, 'Android release must not enable cleartext traffic');
requireMatch(manifest, /android:scheme="easysplit"/, 'Android EasySplit deep-link scheme is missing');
requireMatch(manifest, /android\.permission\.INTERNET/, 'Android INTERNET permission is missing');

requireMatch(project, /PRODUCT_BUNDLE_IDENTIFIER = com\.easysplit\.app;/, 'iOS bundle id drifted');
requireMatch(project, /MARKETING_VERSION = 1\.0;/, 'iOS marketing version is not 1.0');
requireMatch(project, /CURRENT_PROJECT_VERSION = 1;/, 'iOS build number is not 1');
requireMatch(project, /CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/, 'iOS entitlements are not wired');
requireMatch(plist, /<string>EasySplit<\/string>/, 'iOS display name is missing');
requireMatch(plist, /NSCameraUsageDescription/, 'iOS camera usage description is missing');
requireMatch(plist, /NSPhotoLibraryUsageDescription/, 'iOS photo-library usage description is missing');
requireMatch(plist, /<string>easysplit<\/string>/, 'iOS EasySplit deep-link scheme is missing');
requireMatch(entitlements, /com\.apple\.developer\.applesignin/, 'Sign in with Apple entitlement is missing');

const privacyManifest = path.join(root, 'node_modules/@capacitor/ios/Capacitor/Capacitor/PrivacyInfo.xcprivacy');
if (!fs.existsSync(privacyManifest)) {
  throw new Error('Capacitor iOS privacy manifest is missing');
}
const requestedBundleRoot = process.argv[2] || 'mobile-dist';
const bundleRoot = path.resolve(root, requestedBundleRoot);
if (!fs.existsSync(bundleRoot) || !fs.statSync(bundleRoot).isDirectory()) {
  throw new Error(`Release bundle directory is missing: ${bundleRoot}`);
}

const forbidden = [
  'Gate Four Host',
  'GATE4_NATIVE_CORE_FLOW=PASS',
  '__EASYSPLIT_GATE4_AUTH_DIAGNOSTICS__',
  'http://127.0.0.1:3000',
  'ws://127.0.0.1:3000',
  'https://api.easysplit.invalid',
  'EASYSPLIT_APPLE_PRIVATE_KEY',
  'EASYSPLIT_IDENTITY_HMAC_SECRET',
  'EASYSPLIT_INVITE_HMAC_SECRET',
  'EASYSPLIT_ANALYTICS_SECRET',
  '-----BEGIN PRIVATE KEY-----',
];
const textualExtensions = new Set([
  '.css', '.cjs', '.html', '.js', '.json', '.mjs', '.plist', '.svg', '.txt', '.xml',
]);
const stack = [bundleRoot];
let scannedFiles = 0;
let bundleText = '';
while (stack.length) {
  const current = stack.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) stack.push(full);
    else {
      scannedFiles += 1;
      if (entry.name.endsWith('.map')) throw new Error(`Release bundle ships source map: ${entry.name}`);
      if (!textualExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const text = fs.readFileSync(full, 'utf8');
      bundleText += `\n${text}`;
      for (const marker of forbidden) {
        if (text.includes(marker)) throw new Error(`Release bundle contains forbidden release marker: ${marker}`);
      }
    }
  }
}
if (scannedFiles === 0) throw new Error('Release bundle is empty');
const expectedApi = String(process.env.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN || '').trim();
const expectedWeb = String(process.env.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN || '').trim();
const expectedWs = String(process.env.NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN || '').trim();
const expectedOrigins = [['API', expectedApi], ['Web', expectedWeb], ['WebSocket', expectedWs]];
const requiredOriginCounts = new Map();
for (const [label, value] of expectedOrigins) {
  if (!value) throw new Error(`Configured production ${label} origin is required for release verification`);
  requiredOriginCounts.set(value, (requiredOriginCounts.get(value) || 0) + 1);
}
for (const [value, minimumCount] of requiredOriginCounts) {
  const actualCount = bundleText.split(value).length - 1;
  if (actualCount < minimumCount) {
    throw new Error(`Release bundle contains ${actualCount}/${minimumCount} required production origin references for ${value}`);
  }
}
const requiredAuthMarkers = [
  ['Firebase auth domain', 'easysplit-24576.firebaseapp.com'],
  ['Firebase project ID', 'easysplit-24576'],
  ['Firebase app ID', '1:510350845002:web:cc49a335ab30154bbcb2b3'],
  ['native Google OAuth client', '510350845002-o6t8t84c5fnvncgkspqdit0s0ndgsir9.apps.googleusercontent.com'],
];
for (const [label, marker] of requiredAuthMarkers) {
  if (!bundleText.includes(marker)) throw new Error(`Release bundle is missing the production ${label}`);
}

console.log(JSON.stringify({
  releaseConfig: 'PASS',
  appId: 'com.easysplit.app',
  version: '1.0',
  androidTargetSdk: 36,
  scannedBundleFiles: scannedFiles,
  sourceMaps: 'absent',
  gate4Diagnostics: 'absent',
  authIdentity: 'production',
  bundleRoot,
}, null, 2));
