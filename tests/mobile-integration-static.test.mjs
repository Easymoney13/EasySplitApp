import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');

async function exists(path) {
  try {
    await access(new URL(path, root));
    return true;
  } catch {
    return false;
  }
}

test('mobile package scripts are pinned and guarded by Node 22 without changing web scripts', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts.build, 'next build');
  assert.equal(pkg.scripts.start, 'NODE_ENV=production node server.js');
  assert.match(pkg.scripts['mobile:build'], /mobile:check-node/);
  assert.equal(pkg.devDependencies['@capacitor/cli'], '8.5.0');
  assert.equal(pkg.devDependencies.vite, '8.2.2');
});

test('mobile shell is included in Tailwind scanning and generated output stays untracked', async () => {
  const tailwind = await read('tailwind.config.js');
  const gitignore = await read('.gitignore');
  assert.match(tailwind, /\.\/mobile\/\*\*\/\*\.\{js,ts,jsx,tsx,mdx\}/);
  assert.match(gitignore, /\/mobile-dist\//);
  assert.match(gitignore, /!\.env\.mobile\.example/);
});

test('shared room pages keep mobile recovery and group scanning uses the native camera bridge explicitly', async () => {
  const session = await read('src/app/session/[id]/page.tsx');
  const group = await read('src/app/group/[id]/page.tsx');

  for (const source of [session, group]) {
    assert.match(source, /MOBILE_RECOVERY_EVENT/);
    assert.match(source, /addEventListener\(MOBILE_RECOVERY_EVENT/);
  }

  assert.match(group, /from ['"]@capacitor\/core['"]/);
  assert.match(group, /from ['"]@capacitor\/camera['"]/);
  assert.match(group, /Capacitor\.isNativePlatform\(\)/);
  assert.match(group, /CapCamera\.getPhoto/);
  assert.doesNotMatch(group, /window\.location\.href\s*=\s*`\/session\//);
});

test('committed native projects wire Camera and Haptics on both iOS and Android', async () => {
  assert.equal(await exists('ios/App/CapApp-SPM/Package.swift'), true);
  assert.equal(await exists('android/capacitor.settings.gradle'), true);
  assert.equal(await exists('android/app/capacitor.build.gradle'), true);

  const pkg = JSON.parse(await read('package.json'));
  const iosPackage = await read('ios/App/CapApp-SPM/Package.swift');
  const androidSettings = await read('android/capacitor.settings.gradle');
  const androidBuild = await read('android/app/capacitor.build.gradle');

  assert.ok(pkg.dependencies['@capacitor/camera']);
  assert.ok(pkg.dependencies['@capacitor/haptics']);
  assert.match(iosPackage, /CapacitorCamera/);
  assert.match(iosPackage, /CapacitorHaptics/);
  assert.match(androidSettings, /include ':capacitor-camera'/);
  assert.match(androidSettings, /include ':capacitor-haptics'/);
  assert.match(androidBuild, /implementation project\(':capacitor-camera'\)/);
  assert.match(androidBuild, /implementation project\(':capacitor-haptics'\)/);
});

test('native projects wire sharing, external payment apps, and inbound app links', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const runtime = await read('mobile/runtime/mobileRuntime.ts');
  const manifest = await read('android/app/src/main/AndroidManifest.xml');
  const androidSettings = await read('android/capacitor.settings.gradle');
  const androidBuild = await read('android/app/capacitor.build.gradle');
  const plist = await read('ios/App/App/Info.plist');
  const iosPackage = await read('ios/App/CapApp-SPM/Package.swift');

  assert.ok(pkg.dependencies['@capacitor/share']);
  assert.ok(pkg.dependencies['@capacitor/app-launcher']);
  assert.match(runtime, /App\.addListener\('appUrlOpen'/);
  assert.match(runtime, /App\.getLaunchUrl\(\)/);
  assert.match(manifest, /android:scheme="easysplit"/);
  assert.match(manifest, /android:scheme="bit"/);
  assert.match(manifest, /android:scheme="paybox"/);
  assert.match(plist, /<string>easysplit<\/string>/);
  assert.match(plist, /LSApplicationQueriesSchemes/);
  assert.match(androidSettings, /include ':capacitor-app-launcher'/);
  assert.match(androidSettings, /include ':capacitor-share'/);
  assert.match(androidBuild, /implementation project\(':capacitor-app-launcher'\)/);
  assert.match(androidBuild, /implementation project\(':capacitor-share'\)/);
  assert.match(iosPackage, /CapacitorAppLauncher/);
  assert.match(iosPackage, /CapacitorShare/);

  const home = await read('src/app/page.tsx');
  const session = await read('src/app/session/[id]/page.tsx');
  const group = await read('src/app/group/[id]/page.tsx');
  const qrModal = await read('src/components/QRCodeModal.tsx');
  const bit = await read('lib/bitDeepLink.ts');
  for (const source of [home, qrModal]) {
    assert.doesNotMatch(source, /navigator\.share/);
    assert.match(source, /shareInvite/);
  }
  for (const source of [session, group]) {
    assert.doesNotMatch(source, /paybox:\/\//);
    assert.match(source, /openPayBoxPayment/);
  }
  assert.match(bit, /webAppUrl: isAndroidBrowser \? intentUrl : deepLink/);
  assert.match(bit, /if \(!Capacitor\.isNativePlatform\(\)\)/);
});

test('Android back gives an open Start Split sheet first refusal before shell navigation', async () => {
  const events = await read('lib/mobileEvents.ts');
  const runtime = await read('mobile/runtime/mobileRuntime.ts');
  const home = await read('src/app/page.tsx');
  const config = await read('capacitor.config.ts');

  assert.match(events, /MOBILE_BACK_REQUEST_EVENT/);
  assert.match(runtime, /new Event\(MOBILE_BACK_REQUEST_EVENT, \{ cancelable: true \}\)/);
  assert.match(runtime, /if \(backRequest\.defaultPrevented\) return/);
  assert.match(home, /window\.addEventListener\(MOBILE_BACK_REQUEST_EVENT/);
  assert.match(home, /event\.preventDefault\(\)/);
  assert.match(home, /setShowStartSplitModal\(false\)/);
  assert.match(home, /data-testid="start-split-button"/);
  assert.match(home, /data-testid="start-split-sheet"/);
  assert.doesNotMatch(config, /disableBackButtonHandler:\s*true/);
});

test('Android runtime smoke completes first-run onboarding before testing Back', async () => {
  const runtimeSmoke = await read('.github/validation/native-android-runtime.mjs');
  const onboardingSetup = runtimeSmoke.indexOf('await completeGuestOnboardingIfNeeded(page)');
  const sheetClick = runtimeSmoke.indexOf("document.querySelector('[data-testid=\"start-split-button\"]');");

  assert.notEqual(onboardingSetup, -1);
  assert.notEqual(sheetClick, -1);
  assert.ok(onboardingSetup < sheetClick);
  assert.match(runtimeSmoke, /waitFor\('guest onboarding dismissal'/);
});

test('Android runtime smoke uses a short predictive Back gesture with verified completion', async () => {
  const runtimeSmoke = await read('.github/validation/native-android-runtime.mjs');

  assert.match(runtimeSmoke, /const edgeOffset = Math\.max\(24, Math\.round\(width \* 0\.03\)\)/);
  assert.match(runtimeSmoke, /'touchscreen', '-d', '0', 'swipe'/);
  assert.match(runtimeSmoke, /String\(startX\).*String\(endX\).*'120'/s);
  assert.match(runtimeSmoke, /for \(const edge of \['left', 'right'\]\)/);
  assert.match(runtimeSmoke, /Notifying listeners for event backButton/);
  assert.match(runtimeSmoke, /waitForAndroidBackOutcome\(baselineNotifications, completionCheck\)/);
  assert.match(runtimeSmoke, /Once either signal changes, never inject a second Back/);
});

test('Android runtime treats an omitted shell route as Home', async () => {
  const runtimeSmoke = await read('.github/validation/native-android-runtime.mjs');

  assert.match(runtimeSmoke, /\(params\.get\('esRoute'\) \|\| '\/'\) ===/);
  assert.match(runtimeSmoke, /\(new URLSearchParams\(window\.location\.search\)\.get\('esRoute'\) \|\| '\/'\) === '\/'/);
});

test('Android runtime allows full logcat output for crash scanning', async () => {
  const runtimeSmoke = await read('.github/validation/native-android-runtime.mjs');

  assert.match(runtimeSmoke, /maxBuffer: 16 \* 1024 \* 1024/);
});
