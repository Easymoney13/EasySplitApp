import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateGate4Report } from './gate4-contract.mjs';

const ANDROID_GATE3_MARKERS = Object.freeze([
  'ANDROID_GESTURE_NAVIGATION=PASS',
  'ANDROID_COLD_LAUNCH=PASS',
  'ANDROID_GUEST_LIVE_CONTINUITY=PASS',
  'ANDROID_GUEST_COLD_CONTINUITY=PASS',
  'ANDROID_BACK_CAMERA_DISMISS=PASS',
  'ANDROID_LIVE_DEEP_LINK=PASS',
  'ANDROID_COLD_DEEP_LINK=PASS',
  'ANDROID_BACK_ROOT=PASS',
  'ANDROID_BACKGROUND_RESUME=PASS',
  'ANDROID_CRASH_ANR_SCAN=PASS',
]);

const IOS_SMOKE_MARKERS = Object.freeze([
  'IOS_SIMULATOR_LAUNCH=PASS',
  'IOS_HOME_SCREENSHOT=PASS',
  'IOS_LIVE_DEEP_LINK_DISPATCH=PASS',
  'IOS_LIVE_DEEP_LINK_SCREENSHOT=PASS',
  'IOS_COLD_DEEP_LINK_DISPATCH=PASS',
  'IOS_COLD_DEEP_LINK_SCREENSHOT=PASS',
  'IOS_CRASH_SCAN=PASS',
]);

async function requireNonEmpty(path, errors, label) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) errors.push(`${label} is empty: ${path}`);
  } catch (_) {
    errors.push(`${label} is missing: ${path}`);
  }
}

async function readRequired(path, errors, label) {
  await requireNonEmpty(path, errors, label);
  try {
    return await readFile(path, 'utf8');
  } catch (_) {
    return '';
  }
}

export async function collectNativeEvidenceErrors(platform, gate4Dir, companionDir, runId) {
  const errors = [];
  const gate4Result = await readRequired(join(gate4Dir, 'gate4-result.txt'), errors, 'Gate 4 result');
  const gate4Exit = await readRequired(join(gate4Dir, 'gate4-exit-code.txt'), errors, 'Gate 4 exit code');
  const terminalPath = join(gate4Dir, `${platform}-result.json`);
  const terminalRaw = await readRequired(terminalPath, errors, 'Gate 4 terminal report');
  await requireNonEmpty(join(gate4Dir, `${platform}-progress.jsonl`), errors, 'Gate 4 progress history');
  await requireNonEmpty(join(gate4Dir, 'gate4-final.png'), errors, 'Gate 4 screenshot');
  await requireNonEmpty(
    join(gate4Dir, platform === 'ios' ? 'gate4-app.log' : 'gate4-logcat.txt'),
    errors,
    'Gate 4 runtime log',
  );

  if (gate4Exit.trim() !== '0') errors.push(`Gate 4 wrapper exit code is ${gate4Exit.trim() || 'missing'}`);
  let report = null;
  if (terminalRaw) {
    try {
      report = JSON.parse(terminalRaw);
      validateGate4Report(report, platform, runId);
    } catch (error) {
      errors.push(`Gate 4 terminal report is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (report?.markers) {
    for (const marker of report.markers) {
      if (!gate4Result.includes(marker)) errors.push(`Gate 4 wrapper output is missing ${marker}`);
    }
  }

  if (platform === 'android') {
    const result = await readRequired(join(companionDir, 'result.txt'), errors, 'Gate 3 result');
    const exitCode = await readRequired(join(companionDir, 'exit-code.txt'), errors, 'Gate 3 exit code');
    await requireNonEmpty(join(companionDir, 'final.png'), errors, 'Gate 3 screenshot');
    await requireNonEmpty(join(companionDir, 'logcat.txt'), errors, 'Gate 3 logcat');
    if (exitCode.trim() !== '0') errors.push(`Gate 3 wrapper exit code is ${exitCode.trim() || 'missing'}`);
    for (const marker of ANDROID_GATE3_MARKERS) {
      if (!result.split(/\r?\n/).includes(marker)) errors.push(`Gate 3 result is missing ${marker}`);
    }
  } else if (platform === 'ios') {
    const result = await readRequired(join(companionDir, 'result.txt'), errors, 'iOS smoke result');
    const exitCode = await readRequired(join(companionDir, 'exit-code.txt'), errors, 'iOS smoke exit code');
    for (const file of ['home.png', 'live-deep-link.png', 'cold-deep-link.png', 'app.log']) {
      await requireNonEmpty(join(companionDir, file), errors, `iOS smoke ${file}`);
    }
    if (exitCode.trim() !== '0') errors.push(`iOS smoke wrapper exit code is ${exitCode.trim() || 'missing'}`);
    for (const marker of IOS_SMOKE_MARKERS) {
      if (!result.split(/\r?\n/).includes(marker)) errors.push(`iOS smoke result is missing ${marker}`);
    }
  } else {
    errors.push(`Unsupported native platform: ${platform}`);
  }

  return errors;
}

async function main() {
  const [platform, gate4Dir, companionDir, runId] = process.argv.slice(2);
  if (!platform || !gate4Dir || !companionDir || !runId) {
    throw new Error('Usage: require-native-evidence.mjs <ios|android> <gate4-dir> <smoke|gate3-dir> <run-id>');
  }
  const errors = await collectNativeEvidenceErrors(platform, gate4Dir, companionDir, runId);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`EVIDENCE_ERROR: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`NATIVE_${platform.toUpperCase()}_EVIDENCE=PASS\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
