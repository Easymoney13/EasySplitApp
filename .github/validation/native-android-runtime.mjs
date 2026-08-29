import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';

const ADB = process.env.ADB || 'adb';
const PACKAGE = 'com.easysplit.app';
const ACTIVITY = `${PACKAGE}/.MainActivity`;
const DEVTOOLS_PORT = 9222;
const RUNTIME_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function adb(...args) {
  return execFileSync(ADB, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
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
  const pid = await waitFor('EasySplit process', async () => adb('shell', 'pidof', PACKAGE) || null, timeoutMs);

  const socketName = await waitFor('EasySplit WebView DevTools socket', async () => {
    const socketTable = adb('shell', 'cat', '/proc/net/unix');
    const socketLine = socketTable
      .split('\n')
      .find((line) => line.includes(`webview_devtools_remote_${pid}`))
      || socketTable.split('\n').reverse().find((line) => line.includes('webview_devtools_remote'));
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
    return pages.find((page) => page.type === 'page' && page.url.startsWith('https://localhost/'))
      || pages.find((page) => page.type === 'page')
      || null;
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

function capacitorBackNotificationCount() {
  const logcat = adb(
    'logcat', '-d', '-v', 'brief',
    '-s', 'Capacitor/AppPlugin:V', '*:S',
  );
  return (logcat.match(/Notifying listeners for event backButton/g) || []).length;
}

function androidBackGesture(edge) {
  // EasySplit targets Android 16 (API 36), where KEYCODE_BACK interception is no
  // longer a valid way to exercise predictive Back. Inject the same left-edge
  // touchscreen gesture a user performs so AndroidX OnBackPressedDispatcher and
  // Capacitor's App.backButton listener are tested through the real system path.
  const sizeOutput = adb('shell', 'wm', 'size');
  const size = sizeOutput.match(/Physical size:\s*(\d+)x(\d+)/i)
    || sizeOutput.match(/(\d+)x(\d+)/);
  if (!size) throw new Error(`Could not determine emulator display size: ${sizeOutput}`);

  const width = Number(size[1]);
  const height = Number(size[2]);
  const y = Math.round(height * 0.5);
  const edgeOffset = Math.max(24, Math.round(width * 0.03));
  const travel = Math.max(320, Math.round(width * 0.38));
  const startX = edge === 'left' ? edgeOffset : width - edgeOffset;
  const endX = edge === 'left' ? startX + travel : startX - travel;

  // Keep the injected swipe well below Android's long-press cutoff. The former
  // 300 ms duration was cancelled by SystemUI before predictive Back started.
  adb(
    'shell', 'input', 'touchscreen', '-d', '0', 'swipe',
    String(startX), String(y), String(endX), String(y), '120',
  );
}

async function waitForAndroidBackOutcome(baselineNotifications, completionCheck, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const completed = await completionCheck();
    const callbackObserved = capacitorBackNotificationCount() > baselineNotifications;
    if (completed || callbackObserved) return { completed, callbackObserved };
    await sleep(250);
  }
  return null;
}

async function performAndroidBack(label, completionCheck) {
  assertEmulatorSystemHealthy();
  const baselineNotifications = capacitorBackNotificationCount();

  for (const edge of ['left', 'right']) {
    androidBackGesture(edge);
    const outcome = await waitForAndroidBackOutcome(baselineNotifications, completionCheck);
    if (!outcome) continue;

    // Once either signal changes, never inject a second Back: the UI transition
    // can trail the native callback on a loaded hosted emulator.
    if (!outcome.callbackObserved) {
      await waitFor(
        `Capacitor backButton callback for ${label}`,
        async () => capacitorBackNotificationCount() > baselineNotifications,
        5_000,
        250,
      );
    }
    if (!outcome.completed) {
      await waitFor(`Android Back completion for ${label}`, completionCheck, 15_000, 250);
    }

    assertEmulatorSystemHealthy();
    console.log(`ANDROID_BACK_GESTURE_OK=${label}:${edge}`);
    return;
  }

  throw new Error(`Android Back gesture did not reach Capacitor for ${label} from either edge`);
}

async function expectRoute(page, route, { paramName, paramValue, hash } = {}) {
  return waitFor(`route ${route}`, async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const params = new URLSearchParams(window.location.search);
      const routeOk = params.get('esRoute') === ${JSON.stringify(route)};
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
    .filter((line) => /ANR in com\.easysplit\.app|Process com\.easysplit\.app.*died|Process:\s*com\.easysplit\.app/i.test(line));
  if (fatal.length) throw new Error(`Native crash/ANR detected:\n${fatal.join('\n')}`);
}

async function main() {
  adb('logcat', '-c');
  assertEmulatorSystemHealthy();
  adb('shell', 'am', 'force-stop', PACKAGE);

  const launch = adb('shell', 'am', 'start', '-W', '-n', ACTIVITY);
  if (!launchAccepted(launch)) throw new Error(`Cold launch dispatch failed:\n${launch}`);

  // Do not trust `am start -W` alone. A cold launch passes only when the actual
  // EasySplit WebView exists, the activity is foreground, and React hydrated.
  let page = await connectWebView();
  await waitForEasySplitFocused('EasySplit foreground after cold launch');
  await waitFor('hydrated EasySplit home', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector('[data-testid="start-split-button"]'))`,
  ), RUNTIME_TIMEOUT_MS);
  await completeGuestOnboardingIfNeeded(page);
  assertEmulatorSystemHealthy();

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

  const liveDeepLink = openDeepLink('easysplit://session/smoke-session?groupId=smoke-group#invite=smoke-token');
  if (!launchAccepted(liveDeepLink)) throw new Error(`Live deep-link dispatch failed:\n${liveDeepLink}`);
  page = await connectWebView();
  await waitForEasySplitFocused('EasySplit foreground after live deep link');
  await expectRoute(page, '/session/smoke-session', {
    paramName: 'groupId',
    paramValue: 'smoke-group',
    hash: '#invite=smoke-token',
  });

  await performAndroidBack('live-deep-link', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `new URLSearchParams(window.location.search).get('esRoute') === '/'`,
  ));
  page = await connectWebView();
  await expectRoute(page, '/');

  adb('shell', 'am', 'force-stop', PACKAGE);
  const coldDeepLink = openDeepLink('easysplit://group/smoke-group');
  if (!launchAccepted(coldDeepLink)) throw new Error(`Cold deep-link dispatch failed:\n${coldDeepLink}`);
  page = await connectWebView();
  await waitForEasySplitFocused('EasySplit foreground after cold deep link');
  await expectRoute(page, '/group/smoke-group');

  await performAndroidBack('cold-deep-link', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `new URLSearchParams(window.location.search).get('esRoute') === '/'`,
  ));
  page = await connectWebView();
  await expectRoute(page, '/');

  await performAndroidBack('root', async () => !isEasySplitFocused());
  if (isEasySplitFocused()) throw new Error('Back on root did not return control to Android');

  const warmLaunch = adb('shell', 'am', 'start', '-W', '-n', ACTIVITY);
  if (!launchAccepted(warmLaunch)) throw new Error(`Warm resume dispatch failed:\n${warmLaunch}`);
  await waitForEasySplitFocused('EasySplit foreground after warm resume');
  page = await connectWebView();
  await waitFor('hydrated EasySplit home after warm resume', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector('[data-testid="start-split-button"]'))`,
  ), RUNTIME_TIMEOUT_MS);

  assertNoNativeCrash();
  assertEmulatorSystemHealthy();

  console.log('ANDROID_COLD_LAUNCH=PASS');
  console.log('ANDROID_BACK_SHEET_DISMISS=PASS');
  console.log('ANDROID_LIVE_DEEP_LINK=PASS');
  console.log('ANDROID_COLD_DEEP_LINK=PASS');
  console.log('ANDROID_BACK_ROOT=PASS');
  console.log('ANDROID_BACKGROUND_RESUME=PASS');
  console.log('ANDROID_CRASH_ANR_SCAN=PASS');
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
