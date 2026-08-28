import { execFileSync, spawnSync } from 'node:child_process';
import WebSocket from 'ws';

const adb = process.env.ADB || 'adb';
const packageName = 'com.easysplit.app';
const activity = `${packageName}/.MainActivity`;
const debugPort = '9222';

function adbRun(args, options = {}) {
  return execFileSync(adb, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function adbTry(args) {
  return spawnSync(adb, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, operation, timeoutMs = 20_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function evaluate(webSocketDebuggerUrl, expression) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Chrome DevTools evaluation timed out'));
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
        reject(new Error(message.result.exceptionDetails.text || 'Evaluation failed'));
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

async function getWebViewPage() {
  return await waitFor('EasySplit WebView', async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) return null;
    const pages = await response.json();
    return pages.find((page) =>
      page.type === 'page'
      && (page.url === 'https://localhost/' || page.title === 'EasySplit')
    ) || null;
  });
}

adbTry(['forward', '--remove', `tcp:${debugPort}`]);
adbRun(['logcat', '-c']);
adbRun(['shell', 'am', 'force-stop', packageName]);
const launch = adbRun(['shell', 'am', 'start', '-W', '-n', activity]);
if (!/Status:\s+ok/.test(launch)) {
  throw new Error(`Cold launch failed:\n${launch}`);
}

const pid = await waitFor('EasySplit process', async () => {
  const result = adbTry(['shell', 'pidof', packageName]);
  const value = String(result.stdout || '').trim();
  return value || null;
});

const socketName = await waitFor('WebView DevTools socket', async () => {
  const unixSockets = adbRun(['shell', 'cat', '/proc/net/unix']);
  const exact = `webview_devtools_remote_${pid}`;
  if (unixSockets.includes(exact)) return exact;
  const match = unixSockets.match(/webview_devtools_remote_\d+/g)?.at(-1);
  return match || null;
});

adbRun(['forward', `tcp:${debugPort}`, `localabstract:${socketName}`]);
const page = await getWebViewPage();

const opened = await evaluate(
  page.webSocketDebuggerUrl,
  `(() => {
    const button = document.querySelector('button.home-start-card');
    if (!button) return { clicked: false, reason: 'home-start-card missing' };
    button.click();
    return { clicked: true };
  })()`,
);
if (!opened?.clicked) {
  throw new Error(`Could not open Start Split sheet: ${JSON.stringify(opened)}`);
}

await sleep(1_000);
const modalBefore = await evaluate(
  page.webSocketDebuggerUrl,
  `(() => ({
    open: document.body.innerText.includes('Start a New Split')
      || document.body.innerText.includes('פתיחת חלוקה'),
    platform: window.Capacitor?.getPlatform?.(),
    native: window.Capacitor?.isNativePlatform?.(),
  }))()`,
);
if (!modalBefore?.open || modalBefore.platform !== 'android' || modalBefore.native !== true) {
  throw new Error(`Invalid pre-back state: ${JSON.stringify(modalBefore)}`);
}

adbRun(['shell', 'input', 'keyevent', '4']);
await sleep(1_250);

const processAfterBack = adbTry(['shell', 'pidof', packageName]);
if (!String(processAfterBack.stdout || '').trim()) {
  throw new Error('EasySplit process died after Android Back');
}

const focus = adbRun(['shell', 'dumpsys', 'window', 'windows']);
const focusLine = focus.split('\n').find((line) => line.includes('mCurrentFocus')) || '';
if (!focusLine.includes(packageName)) {
  throw new Error(`Android Back backgrounded EasySplit instead of dismissing the sheet: ${focusLine}`);
}

const modalAfter = await evaluate(
  page.webSocketDebuggerUrl,
  `(() => ({
    open: document.body.innerText.includes('Start a New Split')
      || document.body.innerText.includes('פתיחת חלוקה'),
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  }))()`,
);
if (modalAfter?.open || modalAfter?.visibility !== 'visible') {
  throw new Error(`Start Split sheet was not dismissed cleanly: ${JSON.stringify(modalAfter)}`);
}

const logcat = adbRun(['logcat', '-d', '-v', 'brief']);
const fatal = logcat
  .split('\n')
  .filter((line) =>
    /FATAL EXCEPTION|ANR in com\.easysplit\.app|Process com\.easysplit\.app.*died/i.test(line)
  );
if (fatal.length > 0) {
  throw new Error(`Native crash/ANR detected:\n${fatal.join('\n')}`);
}

const screenshot = spawnSync(adb, ['exec-out', 'screencap', '-p'], {
  encoding: null,
  maxBuffer: 10 * 1024 * 1024,
});
if (screenshot.status === 0 && screenshot.stdout) {
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile('gate12-android-back-result.png', screenshot.stdout)
  );
}
await import('node:fs/promises').then(({ writeFile }) =>
  writeFile('gate12-android-logcat.txt', logcat, 'utf8')
);

console.log(JSON.stringify({
  result: 'PASS',
  pid,
  focus: focusLine.trim(),
  before: modalBefore,
  after: modalAfter,
}, null, 2));
