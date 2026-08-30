const RENDERER_TERMINATION_PATTERN = /aw_browser_terminator.*Renderer process .*crash detected/i;
const INTENTIONAL_RENDERER_TERMINATION_PATTERN = /crash detected \(code -1\)/i;
const ZYGOTE_LOG_PREFIX = '(?:I\\/Zygote\\s*\\(\\s*\\d+\\):|\\S+\\s+\\S+\\s+\\d+\\s+\\d+\\s+I\\s+Zygote\\s*:)';
const ACTIVITY_MANAGER_LOG_PREFIX = '(?:I\\/ActivityManager\\s*\\(\\s*\\d+\\):|\\S+\\s+\\S+\\s+\\d+\\s+\\d+\\s+I\\s+ActivityManager\\s*:)';
const CAPACITOR_LOG_PREFIX = '(?:D\\/Capacitor\\s*\\(\\s*\\d+\\):|\\S+\\s+\\S+\\s+\\d+\\s+\\d+\\s+D\\s+Capacitor\\s*:)';
const CLEAN_RENDERER_EXIT_PATTERN = new RegExp(`^${ZYGOTE_LOG_PREFIX}\\s*Process (\\d+) exited cleanly \\(0\\)`, 'i');
const KILLED_RENDERER_EXIT_PATTERN = new RegExp(`^${ZYGOTE_LOG_PREFIX}\\s*Process (\\d+) exited due to signal 9 \\(Killed\\)`, 'i');
const SYSTEM_RENDERER_KILL_PATTERN = new RegExp(`^${ACTIVITY_MANAGER_LOG_PREFIX}\\s*Killing (\\d+):com\\.google\\.android\\.webview:sandboxed_process.*:\\s*isolated not needed\\s*$`, 'i');
const APP_DESTROYED_PATTERN = new RegExp(`^${CAPACITOR_LOG_PREFIX}\\s*App destroyed\\s*$`, 'i');

export function readLogcatWithRetries(readLogcat, { attempts = 3 } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error('Logcat retry attempts must be a positive integer');
  }

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return String(readLogcat());
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function rendererTerminationLines(logcat = '') {
  return String(logcat)
    .split('\n')
    .filter((line) => RENDERER_TERMINATION_PATTERN.test(line));
}

function lineCounts(lines) {
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
  return counts;
}

function updateMaxLineCounts(maxCounts, lines) {
  for (const [line, count] of lineCounts(lines)) {
    maxCounts.set(line, Math.max(maxCounts.get(line) || 0, count));
  }
}

function unexpectedObservedLines(observedCounts, expectedLines) {
  const expectedCounts = lineCounts(expectedLines);
  const unexpected = [];
  for (const [line, count] of observedCounts) {
    const unexpectedCount = Math.max(0, count - (expectedCounts.get(line) || 0));
    for (let index = 0; index < unexpectedCount; index += 1) unexpected.push(line);
  }
  return unexpected;
}

function rendererProcessId(line) {
  return line.match(/Renderer process \((\d+)\)/i)?.[1] || null;
}

function logEmitterProcessId(line) {
  return line.match(/^[A-Z]\/[^()]+\(\s*(\d+)\):/)?.[1]
    || line.match(/^\S+\s+\S+\s+(\d+)\s+\d+\s+[A-Z]\s+[^:]+:/)?.[1]
    || null;
}

function newLogcatLines(beforeLogcat, afterLogcat) {
  const remainingBeforeLines = lineCounts(String(beforeLogcat).split('\n'));
  return String(afterLogcat)
    .split('\n')
    .filter((line) => {
      const remaining = remainingBeforeLines.get(line) || 0;
      if (!remaining) return true;
      remainingBeforeLines.set(line, remaining - 1);
      return false;
    });
}

function rootBackTerminationLines(beforeLogcat, afterLogcat, appProcessIds) {
  const newLines = newLogcatLines(beforeLogcat, afterLogcat);
  const allowedAppProcessIds = new Set(appProcessIds.map(String));
  const expected = [];

  for (let crashIndex = 0; crashIndex < newLines.length; crashIndex += 1) {
    const crashLine = newLines[crashIndex];
    if (!RENDERER_TERMINATION_PATTERN.test(crashLine)
      || !INTENTIONAL_RENDERER_TERMINATION_PATTERN.test(crashLine)) continue;

    const rendererPid = rendererProcessId(crashLine);
    const emitterPid = logEmitterProcessId(crashLine);
    if (!rendererPid || !emitterPid || !allowedAppProcessIds.has(emitterPid)) continue;

    const appDestroyedIndex = newLines
      .slice(0, crashIndex)
      .findLastIndex((line) => (
        APP_DESTROYED_PATTERN.test(line)
        && allowedAppProcessIds.has(logEmitterProcessId(line))
      ));
    if (appDestroyedIndex < 0) continue;

    // Android may report ActivityManager's intentional isolated-process kill
    // immediately before or after Chromium observes that same renderer exit.
    // In both cases it must follow the app's root-Back destruction evidence.
    const systemKillIndex = newLines.findIndex((line, index) => (
      index > appDestroyedIndex
      && line.match(SYSTEM_RENDERER_KILL_PATTERN)?.[1] === rendererPid
    ));
    if (systemKillIndex < 0) continue;

    const systemDisposition = newLines
      .some((line, index) => (
        // ActivityManager, Chromium, and Zygote write from different threads,
        // so their three matching lines are not guaranteed to be interleaved.
        index > appDestroyedIndex
        && (
          line.match(CLEAN_RENDERER_EXIT_PATTERN)?.[1] === rendererPid
          || line.match(KILLED_RENDERER_EXIT_PATTERN)?.[1] === rendererPid
        )
      ));
    if (systemDisposition) expected.push(crashLine);
  }

  return expected;
}

export function intentionalRendererTerminationLines(
  beforeLogcat,
  afterLogcat,
  { requireRootBackTeardown = false, appProcessIds = [] } = {},
) {
  if (requireRootBackTeardown) {
    const expectedLines = rootBackTerminationLines(beforeLogcat, afterLogcat, appProcessIds);
    if (expectedLines.length > 1) {
      throw new Error(`Root Back emitted ${expectedLines.length} renderer terminations; expected at most one`);
    }
    return expectedLines;
  }

  return newLogcatLines(beforeLogcat, afterLogcat)
    .filter((line) => (
      RENDERER_TERMINATION_PATTERN.test(line)
      && INTENTIONAL_RENDERER_TERMINATION_PATTERN.test(line)
    ));
}

export function recordIntentionalRendererTerminations(
  expectedCounts,
  beforeLogcat,
  afterLogcat,
  options = {},
) {
  const expectedLines = intentionalRendererTerminationLines(
    beforeLogcat,
    afterLogcat,
    options,
  );
  for (const line of expectedLines) {
    expectedCounts.set(line, (expectedCounts.get(line) || 0) + 1);
  }
  return expectedLines;
}

export async function waitForIntentionalRendererTerminations(
  readLogcat,
  beforeLogcat,
  options = {},
  { timeoutMs = 5_000, intervalMs = 100 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let latestLogcat = String(beforeLogcat);
  const observedTerminationCounts = new Map();

  while (Date.now() <= deadline) {
    latestLogcat = String(await readLogcat());
    updateMaxLineCounts(observedTerminationCounts, rendererTerminationLines(
      newLogcatLines(beforeLogcat, latestLogcat).join('\n'),
    ));
    const expectedLines = intentionalRendererTerminationLines(
      beforeLogcat,
      latestLogcat,
      options,
    );
    if (expectedLines.length) {
      if (unexpectedObservedLines(observedTerminationCounts, expectedLines).length) {
        throw new Error('Renderer termination evidence included an unexpected occurrence');
      }
      return { afterLogcat: latestLogcat, expectedLines };
    }
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  if (!observedTerminationCounts.size) {
    return { afterLogcat: latestLogcat, expectedLines: [] };
  }
  throw new Error('Renderer termination did not receive complete root Back system-teardown evidence');
}

export function unexpectedRendererTerminationLines(logcat, expectedCounts) {
  const actualCounts = lineCounts(rendererTerminationLines(logcat));
  const unexpected = [];

  for (const [line, count] of actualCounts) {
    const unexpectedCount = Math.max(0, count - (expectedCounts.get(line) || 0));
    for (let index = 0; index < unexpectedCount; index += 1) unexpected.push(line);
  }

  return unexpected;
}
