import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';

const ADB = process.env.ADB || 'adb';
const PACKAGE = 'com.easysplit.app';
const ACTIVITY = `${PACKAGE}/.MainActivity`;
const DEVTOOLS_PORT = 9222;
const RUNTIME_TIMEOUT_MS = 120_000;
const GESTURAL_NAV_OVERLAY = 'com.android.internal.systemui.navbar.gestural';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function adb(...args) {
  return execFileSync(ADB, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

async function waitFor(label, check, timeoutMs = 60_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function cdpEvaluate(webSocketDebuggerUrl, expression) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('CDP evaluation timed out'));
    }, 10_000);

    socket.on('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text || 'CDP expression failed'));
        return;
      }
      resolve(message.result?.result?.value);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function launchAccepted(output) {
  // Android's `am start -W` can report Status: timeout on heavily loaded hosted
  // emulators even while MainActivity is already launching. Runtime state below
  // is the source of truth; any other launch status remains a hard failure.
  return /Status:\s*(?:ok|timeout)/i.test(String(output || ''));
}

async function connectWebView(timeoutMs = RUNTIME_TIMEOUT_MS) {
  const pid = await waitFor('EasySplit process', async () => {
    const processIds = adb('shell', 'pidof', PACKAGE).split(/\s+/).filter(Boolean);
    return processIds.length === 1 ? processIds[0] : null;
  }, timeoutMs);

  const socketName = await waitFor('EasySplit WebView DevTools socket', async () => {
    const socketTable = adb('shell', 'cat', '/proc/net/unix');
    const socketLine = socketTable
      .split('\n')
      .find((line) => line.includes(`webview_devtools_remote_${pid}`));
    return socketLine?.match(/@(webview_devtools_remote[^\s]*)/)?.[1] || null;
  }, timeoutMs);

  try {
    adb('forward', '--remove', `tcp:${DEVTOOLS_PORT}`);
  } catch {}
  adb('forward', `tcp:${DEVTOOLS_PORT}`, `localabstract:${socketName}`);

  return await waitFor('EasySplit WebView page', async () => {
    const response = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`);
    if (!response.ok) return null;
    const pages = await response.json();
    return pages.find((page) => page.type === 'page' && page.url.startsWith('https://localhost/')) || null;
  }, timeoutMs);
}

function isEasySplitFocused() {
  const activities = adb('shell', 'dumpsys', 'activity', 'activities');
  return /topResumedActivity=.*com\.easysplit\.app\/\.MainActivity/.test(activities);
}

async function waitForEasySplitFocused(label = 'EasySplit foreground activity') {
  return waitFor(label, async () => isEasySplitFocused(), RUNTIME_TIMEOUT_MS, 750);
}

async function completeGuestOnboardingIfNeeded(page) {
  const onboardingVisible = await cdpEvaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))`,
  );
  if (!onboardingVisible) return;

  const fieldsFilled = await cdpEvaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      const fields = dialog?.querySelectorAll('input');
      if (!fields || fields.length < 2) return false;
      const setValue = (field, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter) return false;
        setter.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      return setValue(fields[0], 'Android Smoke') && setValue(fields[1], '0501234567');
    })()`,
  );
  if (!fieldsFilled) throw new Error('Guest onboarding fields could not be filled');

  await waitFor('enabled guest onboarding submit', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      const submit = dialog?.querySelector('button[type="submit"]');
      return Boolean(submit && !submit.disabled);
    })()`,
  ));

  const submitted = await cdpEvaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      const submit = dialog?.querySelector('button[type="submit"]');
      if (!submit || submit.disabled) return false;
      submit.click();
      return true;
    })()`,
  );
  if (!submitted) throw new Error('Guest onboarding could not be submitted');

  await waitFor('guest onboarding dismissal', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `!document.querySelector('[role="dialog"][aria-modal="true"]')`,
  ));

  await expectPersistedGuestProfile(page, 'guest onboarding persistence');
}

async function expectPersistedGuestProfile(page, label) {
  try {
    await waitFor(label, async () => cdpEvaluate(
      page.webSocketDebuggerUrl,
      `(() => {
        try {
          const profile = JSON.parse(localStorage.getItem('billsplit_local_profile') || 'null');
          return profile?.displayName === 'Android Smoke'
            && profile?.phoneNumber === '0501234567'
            && localStorage.getItem('billsplit_account_scope') === 'guest'
            && !document.querySelector('[role="dialog"][aria-modal="true"]');
        } catch (_) {
          return false;
        }
      })()`,
    ));
  } catch (error) {
    const snapshot = await cdpEvaluate(
      page.webSocketDebuggerUrl,
      `(() => {
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
        return {
          localProfile: localStorage.getItem('billsplit_local_profile'),
          localPhone: localStorage.getItem('billsplit_phone'),
          accountScope: localStorage.getItem('billsplit_account_scope'),
          sessionBackup: sessionStorage.getItem('billsplit_guest_profile_backup'),
          dialogLabel: dialog?.getAttribute('aria-label') || null,
          dialogInputs: [...(dialog?.querySelectorAll('input') || [])].map((input) => input.value),
        };
      })()`,
    ).catch((snapshotError) => ({ snapshotError: snapshotError.message }));
    throw new Error(`${error.message}; guest profile snapshot=${JSON.stringify(snapshot)}`);
  }
}

function assertEmulatorSystemHealthy() {
  const windows = adb('shell', 'dumpsys', 'window', 'windows');
  const infrastructureAnrs = [...windows.matchAll(/Application Not Responding:\s*([^\r\n}]+)/g)]
    .map((match) => match[1].trim())
    .filter((processName) => processName !== PACKAGE);
  if (infrastructureAnrs.length) {
    throw new Error(`Android emulator infrastructure ANR detected: ${[...new Set(infrastructureAnrs)].join(', ')}`);
  }
}

function androidResourceContainsInteger(rawValue, expected) {
  return (String(rawValue).match(/0x[0-9a-f]+|-?\d+/gi) || [])
    .some((value) => Number(value) === expected);
}

function gestureNavigationState() {
  const overlays = adb('shell', 'cmd', 'overlay', 'list', 'android');
  const interactionMode = adb(
    'shell', 'cmd', 'overlay', 'lookup',
    'android', 'android:integer/config_navBarInteractionMode',
  );
  const overlayEnabled = overlays
    .split('\n')
    .some((line) => line.includes('[x]') && line.includes(GESTURAL_NAV_OVERLAY));
  return {
    overlayEnabled,
    interactionMode,
    gestural: overlayEnabled && androidResourceContainsInteger(interactionMode, 2),
  };
}

async function requireAndroid16GestureNavigation() {
  const sdk = adb('shell', 'getprop', 'ro.build.version.sdk');
  if (sdk !== '36') throw new Error(`Android runtime smoke requires API 36, received API ${sdk || 'unknown'}`);

  const availableOverlays = adb('shell', 'cmd', 'overlay', 'list', 'android');
  if (!availableOverlays.includes(GESTURAL_NAV_OVERLAY)) {
    throw new Error(`Android gestural navigation overlay is unavailable:\n${availableOverlays}`);
  }

  // Android's own CTS GestureNavRule enables this overlay and then requires
  // config_navBarInteractionMode=2 before injecting a predictive Back swipe.
  // A cold AVD does not promise this mode, so treating an unverified edge swipe
  // as Back makes the runtime test dependent on emulator state.
  adb('shell', 'cmd', 'overlay', 'enable', GESTURAL_NAV_OVERLAY);
  const state = await waitFor('Android gesture-navigation mode', async () => {
    const current = gestureNavigationState();
    return current.gestural ? current : null;
  }, 30_000, 500);

  await waitFor('SystemUI after gesture-navigation setup', async () => (
    adb('shell', 'pidof', 'com.android.systemui') || null
  ), 30_000, 500);
  await sleep(2_000);
  console.log(`ANDROID_GESTURE_NAVIGATION_MODE=${String(state.interactionMode).trim()}`);
  console.log('ANDROID_GESTURE_NAVIGATION=PASS');
}

function capacitorBackNotificationCount() {
  const logcat = adb(
    'logcat', '-d', '-v', 'brief',
    '-s', 'Capacitor/AppPlugin:V', '*:S',
  );
  return (logcat.match(/Notifying listeners for event backButton/g) || []).length;
}

function predictiveBackEvidence() {
  const logcat = adb(
    'logcat', '-d', '-v', 'brief',
    '-s', 'CoreBackPreview:D', '*:S',
  );
  return {
    easySplitStarts: (
      logcat.match(/startBackNavigation.*com\.easysplit\.app\/\.MainActivity/g) || []
    ).length,
    committed: (logcat.match(/onBackNavigationDone.*triggerBack=true/g) || []).length,
  };
}

function androidBackGesture() {
  // Use the short shell gesture already proven to commit through CoreBackPreview
  // on this API-36 image. The CTS-aligned prerequisite above makes its meaning
  // deterministic by requiring gesture-navigation mode before injection.
  const sizeOutput = adb('shell', 'wm', 'size');
  const size = sizeOutput.match(/Physical size:\s*(\d+)x(\d+)/i)
    || sizeOutput.match(/(\d+)x(\d+)/);
  if (!size) throw new Error(`Could not determine emulator display size: ${sizeOutput}`);

  const width = Number(size[1]);
  const height = Number(size[2]);
  const y = Math.round(height * 0.5);
  const startX = Math.max(24, Math.round(width * 0.03));
  const endX = startX + Math.max(320, Math.round(width * 0.38));
  adb(
    'shell', 'input', 'touchscreen', '-d', '0', 'swipe',
    String(startX), String(y), String(endX), String(y), '120',
  );
}

async function waitForMobileRuntimeReady(page, label = 'EasySplit mobile runtime') {
  return waitFor(label, async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    'window.__EASYSPLIT_MOBILE_RUNTIME_READY__ === true',
  ), RUNTIME_TIMEOUT_MS, 250);
}

async function performAndroidBack(label, completionCheck) {
  assertEmulatorSystemHealthy();
  const baselineNotifications = capacitorBackNotificationCount();
  const baselineBackEvidence = predictiveBackEvidence();

  androidBackGesture();
  await waitFor(`committed Android Back for ${label}`, async () => {
    const currentBackEvidence = predictiveBackEvidence();
    const starts = currentBackEvidence.easySplitStarts - baselineBackEvidence.easySplitStarts;
    const commits = currentBackEvidence.committed - baselineBackEvidence.committed;
    const notifications = capacitorBackNotificationCount() - baselineNotifications;
    const completed = await completionCheck();
    return starts === 1 && commits === 1 && notifications === 1 && completed;
  }, 30_000, 250);

  const currentBackEvidence = predictiveBackEvidence();
  const startDelta = currentBackEvidence.easySplitStarts - baselineBackEvidence.easySplitStarts;
  const commitDelta = currentBackEvidence.committed - baselineBackEvidence.committed;
  const notificationDelta = capacitorBackNotificationCount() - baselineNotifications;
  if (startDelta !== 1 || commitDelta !== 1 || notificationDelta !== 1) {
    throw new Error(
      `Android Back ${label} was not exactly-once: EasySplit starts=${startDelta}, commits=${commitDelta}, Capacitor callbacks=${notificationDelta}`,
    );
  }

  assertEmulatorSystemHealthy();
  console.log(`ANDROID_BACK_GESTURE_OK=${label}:left:committed`);
}

async function expectRoute(page, route, { paramName, paramValue, hash } = {}) {
  return waitFor(`route ${route}`, async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const params = new URLSearchParams(window.location.search);
      const routeOk = (params.get('esRoute') || '/') === ${JSON.stringify(route)};
      const paramOk = ${paramName ? `params.get(${JSON.stringify(paramName)}) === ${JSON.stringify(paramValue)}` : 'true'};
      const hashOk = ${hash ? `window.location.hash === ${JSON.stringify(hash)}` : 'true'};
      return routeOk && paramOk && hashOk;
    })()`,
  ), RUNTIME_TIMEOUT_MS);
}

function openDeepLink(url) {
  return adb(
    'shell', 'am', 'start', '-W',
    '-a', 'android.intent.action.VIEW',
    '-c', 'android.intent.category.BROWSABLE',
    '-d', url,
    '-p', PACKAGE,
  );
}

function assertNoNativeCrash() {
  const logcat = adb('logcat', '-d', '-v', 'brief');
  const fatal = logcat
    .split('\n')
    .filter((line) => (
      /ANR in com\.easysplit\.app|Process:\s*com\.easysplit\.app/i.test(line)
      || /Fatal signal \d+.*com\.easysplit\.app|Cmdline:\s*com\.easysplit\.app/i.test(line)
    ));
  if (fatal.length) throw new Error(`Native crash/ANR detected:\n${fatal.join('\n')}`);
}

function appProcessIds() {
  try {
    return adb('shell', 'pidof', PACKAGE).split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

async function forceStopApp(label) {
  adb('shell', 'am', 'force-stop', PACKAGE);
  await waitFor(`${label} process exit`, async () => appProcessIds().length === 0, 30_000, 250);
}

async function resetAppData(label) {
  const clearResult = adb('shell', 'pm', 'clear', PACKAGE);
  if (!/^Success$/m.test(clearResult)) {
    throw new Error(`${label} package-data reset failed: ${clearResult || 'no output'}`);
  }
  await waitFor(`${label} clean process exit`, async () => appProcessIds().length === 0, 30_000, 250);
  console.log(`ANDROID_SCENARIO_DATA_RESET=${label}`);
}

async function launchHomeWithGuest(label) {
  await resetAppData(label);
  const launch = adb('shell', 'am', 'start', '-W', '-n', ACTIVITY);
  if (!launchAccepted(launch)) throw new Error(`${label} dispatch failed:\n${launch}`);

  const page = await connectWebView();
  await waitForEasySplitFocused(`${label} foreground`);
  await waitForMobileRuntimeReady(page, `${label} mobile runtime Back listener`);
  await waitFor(`${label} hydrated home`, async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector('[data-testid="start-split-button"]'))`,
  ), RUNTIME_TIMEOUT_MS);
  await completeGuestOnboardingIfNeeded(page);
  await expectRoute(page, '/');
  await expectPersistedGuestProfile(page, `${label} guest profile`);
  assertEmulatorSystemHealthy();
  return page;
}

async function openLiveSession(pageLabel) {
  const liveDeepLink = openDeepLink('easysplit://session/smoke-session?groupId=smoke-group#invite=smoke-token');
  if (!launchAccepted(liveDeepLink)) throw new Error(`${pageLabel} dispatch failed:\n${liveDeepLink}`);
  const page = await connectWebView();
  await waitForEasySplitFocused(`${pageLabel} foreground`);
  await waitForMobileRuntimeReady(page, `${pageLabel} mobile runtime Back listener`);
  await expectRoute(page, '/session/smoke-session', {
    paramName: 'groupId',
    paramValue: 'smoke-group',
    hash: '#invite=smoke-token',
  });
  return page;
}

async function openColdGroup(pageLabel) {
  await forceStopApp(pageLabel);
  const coldDeepLink = openDeepLink('easysplit://group/smoke-group');
  if (!launchAccepted(coldDeepLink)) throw new Error(`${pageLabel} dispatch failed:\n${coldDeepLink}`);
  const page = await connectWebView();
  await waitForEasySplitFocused(`${pageLabel} foreground`);
  await waitForMobileRuntimeReady(page, `${pageLabel} mobile runtime Back listener`);
  await expectRoute(page, '/group/smoke-group');
  return page;
}

async function testGuestContinuity() {
  await launchHomeWithGuest('cold launch');
  console.log('ANDROID_COLD_LAUNCH=PASS');

  let page = await openLiveSession('guest live deep link');
  await expectPersistedGuestProfile(page, 'guest profile after live deep link');
  console.log('ANDROID_GUEST_LIVE_CONTINUITY=PASS');

  page = await openColdGroup('guest cold deep link');
  await expectPersistedGuestProfile(page, 'guest profile after cold deep link');
  console.log('ANDROID_GUEST_COLD_CONTINUITY=PASS');
}

async function testSheetBack() {
  let page = await launchHomeWithGuest('sheet Back setup');

  const clicked = await cdpEvaluate(
    page.webSocketDebuggerUrl,
    `(() => { const button = document.querySelector('[data-testid="start-split-button"]'); if (!button) return false; button.click(); return true; })()`,
  );
  if (!clicked) throw new Error('Start Split button could not be clicked');

  await waitFor('Start Split sheet', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector('[data-testid="start-split-sheet"]'))`,
  ), RUNTIME_TIMEOUT_MS);

  await performAndroidBack('sheet', async () => !await cdpEvaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector('[data-testid="start-split-sheet"]'))`,
  ));
  if (!isEasySplitFocused()) throw new Error('Back from Start Split sheet backgrounded the app');

  page = await connectWebView();
  const sheetStillOpen = await cdpEvaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector('[data-testid="start-split-sheet"]'))`,
  );
  if (sheetStillOpen) throw new Error('Back did not dismiss the Start Split sheet');
  console.log('ANDROID_BACK_SHEET_DISMISS=PASS');
}

async function testLiveDeepLinkBack() {
  await launchHomeWithGuest('live deep-link Back setup');
  let page = await openLiveSession('live deep-link Back');
  await expectPersistedGuestProfile(page, 'guest profile after live deep link');

  await performAndroidBack('live-deep-link', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `(new URLSearchParams(window.location.search).get('esRoute') || '/') === '/'`,
  ));
  page = await connectWebView();
  await expectRoute(page, '/');
  console.log('ANDROID_LIVE_DEEP_LINK=PASS');
}

async function testColdDeepLinkBack() {
  await launchHomeWithGuest('cold deep-link Back setup');
  let page = await openColdGroup('cold deep-link Back');
  await expectPersistedGuestProfile(page, 'guest profile after cold deep link');

  await performAndroidBack('cold-deep-link', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `(new URLSearchParams(window.location.search).get('esRoute') || '/') === '/'`,
  ));
  page = await connectWebView();
  await expectRoute(page, '/');
  console.log('ANDROID_COLD_DEEP_LINK=PASS');
}

async function testRootBackAndResume() {
  let page = await launchHomeWithGuest('root Back setup');
  await performAndroidBack('root', async () => !isEasySplitFocused());
  if (isEasySplitFocused()) throw new Error('Back on root did not return control to Android');
  console.log('ANDROID_BACK_ROOT=PASS');

  const warmLaunch = adb('shell', 'am', 'start', '-W', '-n', ACTIVITY);
  if (!launchAccepted(warmLaunch)) throw new Error(`Warm resume dispatch failed:\n${warmLaunch}`);
  await waitForEasySplitFocused('EasySplit foreground after warm resume');
  page = await connectWebView();
  await waitForMobileRuntimeReady(page, 'warm resume mobile runtime Back listener');
  await waitFor('hydrated EasySplit home after warm resume', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector('[data-testid="start-split-button"]'))`,
  ), RUNTIME_TIMEOUT_MS);
  await expectPersistedGuestProfile(page, 'guest profile after warm resume');
  console.log('ANDROID_BACKGROUND_RESUME=PASS');
}

async function runScenario(name, scenario, failures) {
  console.log(`ANDROID_SCENARIO_START=${name}`);
  try {
    await scenario();
    console.log(`ANDROID_SCENARIO_RESULT=${name}:PASS`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`ANDROID_SCENARIO_RESULT=${name}:FAIL`);
    console.error(error.stack || error.message);
  }
}

async function main() {
  adb('logcat', '-c');
  await requireAndroid16GestureNavigation();
  assertEmulatorSystemHealthy();

  const failures = [];
  await runScenario('guest-continuity', testGuestContinuity, failures);
  await runScenario('sheet-back', testSheetBack, failures);
  await runScenario('live-deep-link-back', testLiveDeepLinkBack, failures);
  await runScenario('cold-deep-link-back', testColdDeepLinkBack, failures);
  await runScenario('root-back-resume', testRootBackAndResume, failures);

  await runScenario('crash-anr-scan', async () => {
    assertNoNativeCrash();
    assertEmulatorSystemHealthy();
    console.log('ANDROID_CRASH_ANR_SCAN=PASS');
  }, failures);

  if (failures.length) {
    throw new Error(`Android runtime scenarios failed: ${failures.map(({ name }) => name).join(', ')}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  try {
    console.error('\n=== focused activity ===');
    console.error(adb('shell', 'dumpsys', 'window', 'windows'));
    console.error('\n=== EasySplit log tail ===');
    console.error(adb('logcat', '-d', '-v', 'brief').split('\n').slice(-250).join('\n'));
  } catch {}
  process.exit(1);
});
