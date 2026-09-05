import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = async (path) => (await fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('Sign in with Apple release wiring is pinned and native-iOS scoped', async () => {
  const [pkg, helper, entitlements, project] = await Promise.all([
    read('package.json'),
    read('lib/nativeAppleAuth.ts'),
    read('ios/App/App/App.entitlements'),
    read('ios/App/App.xcodeproj/project.pbxproj'),
  ]);
  assert.match(pkg, /"@capawesome\/capacitor-apple-sign-in": "0\.1\.3"/);
  assert.match(helper, /Capacitor\.getPlatform\(\) === 'ios'/);
  assert.match(helper, /crypto\.getRandomValues/);
  assert.match(helper, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(helper, /SignInScope\.Email/);
  assert.match(helper, /SignInScope\.FullName/);
  assert.match(entitlements, /com\.apple\.developer\.applesignin/);
  assert.equal((project.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g) || []).length, 2);
});

test('release package keeps API 36 and store identity stable', async () => {
  const [vars, gradle, capacitor, project] = await Promise.all([
    read('android/variables.gradle'),
    read('android/app/build.gradle'),
    read('capacitor.config.ts'),
    read('ios/App/App.xcodeproj/project.pbxproj'),
  ]);
  assert.match(vars, /targetSdkVersion = 36/);
  assert.match(gradle, /applicationId "com\.easysplit\.app"/);
  assert.match(capacitor, /appId: 'com\.easysplit\.app'/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = com\.easysplit\.app;/);
});

test('Android release signing fails closed outside the isolated dry-run workflow', async () => {
  const [pkg, gradle] = await Promise.all([
    read('package.json'),
    read('android/app/build.gradle'),
  ]);
  assert.match(pkg, /"mobile:bundle:android":/);
  for (const key of [
    'EASYSPLIT_ANDROID_KEYSTORE_PATH',
    'EASYSPLIT_ANDROID_KEYSTORE_PASSWORD',
    'EASYSPLIT_ANDROID_KEY_ALIAS',
    'EASYSPLIT_ANDROID_KEY_PASSWORD',
  ]) {
    assert.match(gradle, new RegExp(key));
  }
  assert.match(gradle, /easysplitReleaseDryRun/);
  assert.match(gradle, /EASYSPLIT_RELEASE_DRY_RUN/);
  assert.match(gradle, /GITHUB_WORKFLOW_REF/);
  assert.match(gradle, /releaseDryRunRefAllowed/);
  assert.match(gradle, /releaseDryRunEventAllowed/);
  assert.match(gradle, /releaseDryRunEvent == 'workflow_dispatch'/);
  assert.match(gradle, /releaseDryRunEvent == 'push'/);
  assert.match(gradle, /refs\/heads\/main/);
  assert.match(gradle, /refs\/heads\/codex\/gate5-stage12-current/);
  assert.match(gradle, /GITHUB_REPOSITORY/);
  assert.match(gradle, /Easymoney13\/EasySplitApp/);
  assert.match(gradle, /startsWith/);
  assert.match(gradle, /mobile-release-dry-run\.yml/);
  assert.doesNotMatch(gradle, /EASYSPLIT_ALLOW_UNSIGNED_RELEASE/);
  assert.match(gradle, /release dry run must not receive Android signing credentials/);
});

test('iOS store archive requires current App Store toolchain and Apple team', async () => {
  const [pkg, archiveScript, toolchain] = await Promise.all([
    read('package.json'),
    read('scripts/archive-ios-release.sh'),
    read('scripts/verify-ios-release-toolchain.sh'),
  ]);
  assert.match(pkg, /"mobile:archive:ios":/);
  assert.match(archiveScript, /EASYSPLIT_APPLE_TEAM_ID/);
  assert.match(archiveScript, /verify-ios-release-toolchain\.sh/);
  assert.match(archiveScript, /-configuration Release/);
  assert.match(archiveScript, /-allowProvisioningUpdates/);
  assert.match(toolchain, /MIN_XCODE_MAJOR=26/);
  assert.match(toolchain, /MIN_IOS_SDK_MAJOR=26/);
  assert.doesNotMatch(toolchain, /EASYSPLIT_MIN_XCODE_MAJOR|EASYSPLIT_MIN_IOS_SDK_MAJOR/);
  assert.match(toolchain, /xcrun --sdk iphoneos --show-sdk-version/);
});

test('Apple account deletion revokes authorization before deleting EasySplit data', async () => {
  const [server, revocation, context] = await Promise.all([
    read('server.js'),
    read('lib/appleTokenRevocation.js'),
    read('src/components/LanguageContext.tsx'),
  ]);
  assert.match(revocation, /https:\/\/appleid\.apple\.com\/auth\/token/);
  assert.match(revocation, /https:\/\/appleid\.apple\.com\/auth\/revoke/);
  assert.match(revocation, /alg: 'ES256'/);
  assert.match(revocation, /grant_type: 'authorization_code'/);
  assert.match(server, /provider === 'apple\.com'[\s\S]*revokeAppleAuthorization[\s\S]*deleteUserAccountData/);
  assert.match(context, /providerId === 'apple\.com'[\s\S]*signInNativeApple\(\)[\s\S]*authorizationCode/);
});

test('release dry-run workflow is pinned to reviewed origins and current store toolchains', async () => {
  const [workflow, vite, audit] = await Promise.all([
    read('.github/workflows/mobile-release-dry-run.yml'),
    read('vite.mobile.config.ts'),
    read('scripts/verify-mobile-release.mjs'),
  ]);
  assert.doesNotMatch(workflow, /inputs:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.match(workflow, /push:\n    branches:\n      - codex\/gate5-stage12-current/);
  assert.match(workflow, /runs-on: macos-26/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /https:\/\/billspltapp\.onrender\.com/);
  assert.match(workflow, /wss:\/\/billspltapp\.onrender\.com/);
  const workflowHeader = workflow.slice(0, workflow.indexOf('jobs:'));
  assert.doesNotMatch(workflowHeader, /NEXT_PUBLIC_EASYSPLIT_/);
  assert.match(workflow, /Require App Store-compatible Xcode and SDK/);
  assert.match(workflow, /-configuration Release/);
  assert.match(workflow, /-sdk iphoneos/);
  assert.match(workflow, /generic\/platform=iOS/);
  assert.match(workflow, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(workflow, /java-version: '21'/);
  assert.match(workflow, /EASYSPLIT_RELEASE_DRY_RUN: 'true'/);
  assert.match(workflow, /-PeasysplitReleaseDryRun=true/);
  assert.match(workflow, /:app:lintRelease :app:bundleRelease/);
  assert.doesNotMatch(workflow, /EASYSPLIT_ALLOW_UNSIGNED_RELEASE/);
  assert.doesNotMatch(workflow, /EASYSPLIT_GATE4_E2E/);
  assert.match(vite, /sourcemap: gate4NativeE2E/);
  assert.match(audit, /Release bundle ships source map/);
  assert.match(audit, /GATE4_NATIVE_CORE_FLOW=PASS/);
  assert.match(audit, /EASYSPLIT_APPLE_PRIVATE_KEY/);
});

test('release dry-run probes production transport without mutating production data', async () => {
  const [pkg, workflow, probe] = await Promise.all([
    read('package.json'),
    read('.github/workflows/mobile-release-dry-run.yml'),
    read('scripts/verify-mobile-release-endpoints.mjs'),
  ]);
  assert.match(pkg, /\"verify:mobile-release-endpoints\"/);
  assert.match(workflow, /npm run verify:mobile-release-endpoints/);
  assert.match(probe, /method: 'OPTIONS'/);
  assert.match(probe, /capacitor:\/\/localhost/);
  assert.match(probe, /https:\/\/localhost/);
  assert.match(probe, /expected HTTP 401/);
  assert.match(probe, /access-control-allow-methods/);
  assert.match(probe, /access-control-allow-headers/);
  assert.match(probe, /new WebSocket/);
  assert.doesNotMatch(probe, /method: 'POST'|method: 'PUT'|method: 'PATCH'|method: 'DELETE'/);
});

test('release dry-run verifies packaged artifacts rather than trusting source configuration', async () => {
  const workflow = await read('.github/workflows/mobile-release-dry-run.yml');
  assert.match(workflow, /verify-mobile-release\.mjs "\$APP\/public"/);
  assert.match(workflow, /verify-mobile-release\.mjs "\$RUNNER_TEMP\/easysplit-aab\/base\/assets\/public"/);
  assert.match(workflow, /PrivacyInfo\.xcprivacy/);
  assert.match(workflow, /510350845002-11pq3jtk5vb5f2kv1nrn1jqd02f04dqp\.apps\.googleusercontent\.com/);
  assert.match(workflow, /com\.googleusercontent\.apps\.510350845002-11pq3jtk5vb5f2kv1nrn1jqd02f04dqp/);
  assert.match(workflow, /vtool -show-build/);
  assert.match(workflow, /CAPACITOR_DEBUG/);
  assert.match(workflow, /embedded\.mobileprovision/);
  assert.match(workflow, /iOS dry-run app is unexpectedly signed/);
  assert.match(workflow, /Android dry-run AAB is unexpectedly signed/);
  assert.match(workflow, /UNSIGNED-DIAGNOSTIC-ONLY/);
  assert.match(workflow, /EasySplit-release-UNSIGNED-DIAGNOSTIC\.aab/);
  assert.match(workflow, /16 KB page-size review/);
  assert.match(workflow, /lint-results-release\.html/);
  assert.match(workflow, /bundletool-all-1\.18\.3\.jar/);
  assert.match(workflow, /a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29/);
  assert.match(workflow, /bundletool\.jar" validate --bundle/);
  assert.match(workflow, /--xpath=\/manifest\/@package/);
  assert.match(workflow, /targetSdkVersion\)" = '36'/);
});

test('release dry-run uses immutable actions and verified Gradle distribution inputs', async () => {
  const [workflow, wrapper] = await Promise.all([
    read('.github/workflows/mobile-release-dry-run.yml'),
    read('android/gradle/wrapper/gradle-wrapper.properties'),
  ]);
  const actionRefs = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionRefs.length >= 5);
  for (const actionRef of actionRefs) {
    assert.match(actionRef, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  }
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 3);
  assert.match(workflow, /gradle\/actions\/wrapper-validation@[0-9a-f]{40}/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /compression-level: 0/);
  assert.match(wrapper, /distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-8\.14\.3-all\.zip/);
  assert.match(wrapper, /distributionSha256Sum=ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c/);
});
