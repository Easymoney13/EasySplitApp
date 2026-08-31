import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { GATE4_CORE_MARKERS, validateGate4Report } from '../.github/validation/gate4-contract.mjs';

test('Gate 4 accepts only a complete successful report for the exact platform and run', () => {
  for (const platform of ['ios', 'android']) {
    const runId = `run-${platform}`;
    const report = { runId, platform, stage: 'NATIVE_CORE_FLOW', status: 'PASS', markers: GATE4_CORE_MARKERS };
    assert.equal(validateGate4Report(report, platform, runId), true);
    assert.throws(
      () => validateGate4Report({ ...report, markers: GATE4_CORE_MARKERS.slice(1) }, platform, runId),
      /must exactly match/,
    );
    assert.throws(
      () => validateGate4Report({ ...report, markers: [...GATE4_CORE_MARKERS, 'EXTRA=PASS'] }, platform, runId),
      /must exactly match/,
    );
    assert.throws(
      () => validateGate4Report({ ...report, stage: 'PAYMENT_COMPLETION' }, platform, runId),
      /NATIVE_CORE_FLOW/,
    );
    assert.throws(() => validateGate4Report(report, platform, 'stale-run'), /Expected Gate 4 run stale-run/);
    assert.throws(
      () => validateGate4Report({ ...report, status: 'FAIL', error: 'flow failed' }, platform, runId),
      /flow failed/,
    );
  }
});

test('Gate 4 runner stays test-only and uses real session UI, transport, and credential helpers', async () => {
  const [viteConfig, runner, session, workflow, androidWrapper, iosWrapper, androidMain, androidDebug] = await Promise.all([
    readFile('vite.mobile.config.ts', 'utf8'),
    readFile('mobile/gate4/nativeCoreFlow.ts', 'utf8'),
    readFile('src/app/session/[id]/page.tsx', 'utf8'),
    readFile('.github/workflows/capacitor-native-builds.yml', 'utf8'),
    readFile('.github/validation/run-native-android-gate4.sh', 'utf8'),
    readFile('.github/validation/run-native-ios-gate4.sh', 'utf8'),
    readFile('android/app/src/main/AndroidManifest.xml', 'utf8'),
    readFile('android/app/src/debug/AndroidManifest.xml', 'utf8'),
  ]);
  assert.match(viteConfig, /EASYSPLIT_GATE4_E2E === 'true'/);
  assert.match(viteConfig, /injectTo: 'head-pre'/);
  assert.match(viteConfig, /VITE_GATE4_RUN_ID is required/);
  assert.doesNotMatch(session, /data-testid="(?:session-workspace|split-everyone|payer-select|settle-and-pay|mark-payment-complete|settlement-complete)"/);
  for (const label of ['Room Members', 'Receipt Items', 'Split All', 'Settle & Pay', 'Each paid their share', 'Finish and Pay', 'Bill Split Settled!']) {
    assert.equal(runner.includes(label), true, `Gate 4 runner is missing UI anchor: ${label}`);
  }
  assert.match(runner, /request\('\/api\/receipt\/scan'/);
  assert.match(runner, /saveRoomCredentials\('session'/);
  assert.match(runner, /saveSessionInviteToken\(sessionId/);
  assert.match(runner, /pushShellRoute\(window/);
  assert.match(runner, /new WebSocket\(realtimeUrl\(\)\)/);
  assert.match(runner, /payment-target/);
  assert.doesNotMatch(runner, /start-split-sheet|profile-display-name|create-manual-split/);
  assert.doesNotMatch(runner, /setAuthLoading|firebaseUser\s*=/);

  assert.match(workflow, /ios-native:[\s\S]*needs: shared-verification/);
  assert.match(workflow, /android-native:[\s\S]*needs: shared-verification/);
  assert.doesNotMatch(workflow, /android-native:[\s\S]*needs: ios-native/);
  assert.match(workflow, /run-native-android-validation\.sh/);
  assert.match(workflow, /gate3-app-debug\.apk/);
  assert.match(workflow, /gate4-app-debug\.apk/);
  assert.match(workflow, /Gate 3 and Gate 4 APKs are unexpectedly identical/);
  assert.match(workflow, /Run iOS launch and deep-link smoke independently\n\s+if: always\(\)/);
  assert.match(workflow, /Require complete iOS runtime evidence\n\s+if: always\(\)/);
  assert.match(workflow, /Require complete Android Gate 4 and Gate 3 evidence\n\s+if: always\(\)/);
  assert.match(workflow, /! grep -Rqs '__EASYSPLIT_GATE4_AUTH_DIAGNOSTICS__' mobile-dist/);
  for (const wrapper of [androidWrapper, iosWrapper]) {
    assert.match(wrapper, /gate4-exit-code\.txt/);
    assert.match(wrapper, /gate4-reporter\.mjs wait/);
    assert.match(wrapper, /exit 0/);
  }
  assert.doesNotMatch(androidMain, /usesCleartextTraffic="true"/);
  assert.match(androidDebug, /usesCleartextTraffic="true"/);
});
