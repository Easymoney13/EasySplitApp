import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { GATE4_CORE_MARKERS, validateGate4Report } from '../.github/validation/gate4-contract.mjs';

test('Gate 4 accepts only a complete successful native report for the expected platform', () => {
  for (const platform of ['ios', 'android']) {
    assert.equal(validateGate4Report({ platform, status: 'PASS', markers: GATE4_CORE_MARKERS }, platform), true);
    assert.throws(
      () => validateGate4Report({ platform, status: 'PASS', markers: GATE4_CORE_MARKERS.slice(1) }, platform),
      /GATE4_SESSION_CREATION=PASS/,
    );
    assert.throws(
      () => validateGate4Report({ platform, status: 'FAIL', markers: [], error: 'flow failed' }, platform),
      /flow failed/,
    );
  }
});

test('Gate 4 native runner is test-only and drives shared UI plus realtime/payment behavior', async () => {
  const [viteConfig, runner, home, session, manual, workflow, androidWrapper, iosWrapper, androidMain, androidDebug] = await Promise.all([
    readFile('vite.mobile.config.ts', 'utf8'),
    readFile('mobile/gate4/nativeCoreFlow.ts', 'utf8'),
    readFile('src/app/page.tsx', 'utf8'),
    readFile('src/app/session/[id]/page.tsx', 'utf8'),
    readFile('src/components/ManualBillModal.tsx', 'utf8'),
    readFile('.github/workflows/capacitor-native-builds.yml', 'utf8'),
    readFile('.github/validation/run-native-android-gate4.sh', 'utf8'),
    readFile('.github/validation/run-native-ios-gate4.sh', 'utf8'),
    readFile('android/app/src/main/AndroidManifest.xml', 'utf8'),
    readFile('android/app/src/debug/AndroidManifest.xml', 'utf8'),
  ]);
  assert.match(viteConfig, /EASYSPLIT_GATE4_E2E === 'true'/);
  assert.match(viteConfig, /order: 'pre'/);
  assert.match(viteConfig, /gate4\/nativeCoreFlow\.ts/);
  assert.match(home, /data-testid="create-manual-split"/);
  assert.match(manual, /data-testid="manual-bill-submit"/);
  for (const selector of ['session-workspace', 'split-everyone', 'payer-select', 'settle-and-pay', 'mark-payment-complete', 'settlement-complete']) {
    assert.equal(session.includes(`data-testid="${selector}"`), true, `missing ${selector}`);
  }
  assert.match(session, /data-testid=\{`tip-\$\{pct\}`\}/);
  assert.match(runner, /new WebSocket\(realtimeUrl\(\)\)/);
  assert.match(runner, /payment-target/);
  assert.match(runner, /status === 'settled'/);
  assert.match(runner, /Capacitor\.getPlatform\(\)/);
  assert.match(runner, /App\.getLaunchUrl\(\)/);
  assert.match(runner, /easysplit:\\\/\\\/gate4/);
  assert.ok(
    runner.indexOf("click('[data-testid=\"settle-and-pay\"]')") < runner.indexOf("query<HTMLSelectElement>('[data-testid=\"payer-select\"]')"),
    'the settlement dialog must open before the runner queries its payer selector',
  );
  assert.match(workflow, /EASYSPLIT_GATE4_E2E: 'true'/);
  assert.match(workflow, /GATE4_NATIVE_CORE_FLOW=PASS/);
  assert.match(workflow, /run-native-ios-gate4\.sh/);
  assert.match(workflow, /run-native-android-gate4\.sh/);
  for (const wrapper of [androidWrapper, iosWrapper]) {
    assert.match(wrapper, /api\/network-ip/);
    assert.match(wrapper, /gate4-reporter\.mjs wait/);
  }
  assert.doesNotMatch(androidMain, /usesCleartextTraffic="true"/);
  assert.match(androidDebug, /usesCleartextTraffic="true"/);
});
