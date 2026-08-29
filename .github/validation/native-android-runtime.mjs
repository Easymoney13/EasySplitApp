import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';

const ADB = process.env.ADB || 'adb';
const PACKAGE = 'com.easysplit.app';
const ACTIVITY = `${PACKAGE}/.MainActivity`;
const DEVTOOLS_PORT = 9222;

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

async function connectWebView() {
  const pid = await waitFor('EasySplit process', async () => adb('shell', 'pidof', PACKAGE) || null);
  const socketTable = adb('shell', 'cat', '/proc/net/unix');
  const socketLine = socketTable
    .split('\n')
    .find((line) => line.includes(`webview_devtools_remote_${pid}`))
    || socketTable.split('\n').reverse().find((line) => line.includes('webview_devtools_remote'));
  if (!socketLine) throw new Error(`No WebView DevTools socket found for PID ${pid}`);
  const socketName = socketLine.match(/@(webview_devtools_remote[^\s]*)/)?.[1];
  if (!socketName) throw new Error(`Could not parse WebView socket: ${socketLine}`);

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
  });
}

function isEasySplitFocused() {
  const activities = adb('shell', 'dumpsys', 'activity', 'activities');
  return /topResumedActivity=.*com\.easysplit\.app\/\.MainActivity/.test(activities);
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
  ));
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
    .filter((line) => /FATAL EXCEPTION|ANR in com\.easysplit\.app|Process com\.easysplit\.app.*died/i.test(line));
  if (fatal.length) throw new Error(`Native crash/ANR detected:\n${fatal.join('\n')}`);
}

async function main() {
  adb('logcat', '-c');
  adb('shell', 'am', 'force-stop', PACKAGE);

  const launch = adb('shell', 'am', 'start', '-W', '-n', ACTIVITY);
  if (!/Status: ok/.test(launch)) throw new Error(`Cold launch failed:\n${launch}`);

  let page = await connectWebView();
  await waitFor('hydrated EasySplit home', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector('[data-testid="start-split-button"]'))`,
  ));

  const clicked = await cdpEvaluate(
    page.webSocketDebuggerUrl,
    `(() => { const button = document.querySelector('[data-testid="start-split-button"]'); if (!button) return false; button.click(); return true; })()`,
  );
  if (!clicked) throw new Error('Start Split button could not be clicked');

  await waitFor('Start Split sheet', async () => cdpEvaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector('[data-testid="start-split-sheet"]'))`,
  ));

  adb('shell', 'input', 'keyevent', '4');
  await sleep(1_000);
  if (!isEasySplitFocused()) throw new Error('Back from Start Split sheet backgrounded the app');

  page = await connectWebView();
  const sheetStillOpen = await cdpEvaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector('[data-testid="start-split-sheet"]'))`,
  );
  if (sheetStillOpen) throw new Error('Back did not dismiss the Start Split sheet');

  const liveDeepLink = openDeepLink('easysplit://session/smoke-session?groupId=smoke-group#invite=smoke-token');
  if (!/Status: ok/.test(liveDeepLink)) throw new Error(`Live deep-link dispatch failed:\n${liveDeepLink}`);
  page = await connectWebView();
  await expectRoute(page, '/session/smoke-session', {
    paramName: 'groupId',
    paramValue: 'smoke-group',
    hash: '#invite=smoke-token',
  });

  adb('shell', 'input', 'keyevent', '4');
  await sleep(1_000);
  page = await connectWebView();
  await expectRoute(page, '/');

  adb('shell', 'am', 'force-stop', PACKAGE);
  const coldDeepLink = openDeepLink('easysplit://group/smoke-group');
  if (!/Status: ok/.test(coldDeepLink)) throw new Error(`Cold deep-link dispatch failed:\n${coldDeepLink}`);
  page = await connectWebView();
  await expectRoute(page, '/group/smoke-group');

  adb('shell', 'input', 'keyevent', '4');
  await sleep(1_000);
  page = await connectWebView();
  await expectRoute(page, '/');

  adb('shell', 'input', 'keyevent', '4');
  await sleep(1_000);
  if (isEasySplitFocused()) throw new Error('Back on root did not return control to Android');

  const warmLaunch = adb('shell', 'am', 'start', '-W', '-n', ACTIVITY);
  if (!/Status: ok/.test(warmLaunch)) throw new Error(`Warm resume failed:\n${warmLaunch}`);
  await sleep(1_000);
  if (!isEasySplitFocused()) throw new Error('EasySplit did not resume after normal backgrounding');

  assertNoNativeCrash();

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
