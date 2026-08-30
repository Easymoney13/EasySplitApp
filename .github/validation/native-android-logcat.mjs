const RENDERER_TERMINATION_PATTERN = /aw_browser_terminator.*Renderer process .*crash detected/i;
const INTENTIONAL_RENDERER_TERMINATION_PATTERN = /crash detected \(code -1\)/i;
const CLEAN_RENDERER_EXIT_PATTERN = /Zygote.*Process (\d+) exited cleanly \(0\)/i;

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

function rendererProcessId(line) {
  return line.match(/Renderer process \((\d+)\)/i)?.[1] || null;
}

export function recordIntentionalRendererTerminations(
  expectedCounts,
  beforeLogcat,
  afterLogcat,
  { requireCleanExit = false } = {},
) {
  const cleanExitProcessIds = new Set(
    String(afterLogcat)
      .split('\n')
      .map((line) => line.match(CLEAN_RENDERER_EXIT_PATTERN)?.[1] || null)
      .filter(Boolean),
  );
  const expectedLine = (line) => (
    INTENTIONAL_RENDERER_TERMINATION_PATTERN.test(line)
    && (!requireCleanExit || cleanExitProcessIds.has(rendererProcessId(line)))
  );
  const beforeCounts = lineCounts(
    rendererTerminationLines(beforeLogcat).filter(expectedLine),
  );
  const afterCounts = lineCounts(
    rendererTerminationLines(afterLogcat).filter(expectedLine),
  );

  for (const [line, count] of afterCounts) {
    const newOccurrences = count - (beforeCounts.get(line) || 0);
    if (newOccurrences > 0) {
      expectedCounts.set(line, (expectedCounts.get(line) || 0) + newOccurrences);
    }
  }
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
