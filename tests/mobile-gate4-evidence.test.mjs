import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GATE4_CORE_MARKERS, GATE4_STAGES } from '../.github/validation/gate4-contract.mjs';
import { collectNativeEvidenceErrors } from '../.github/validation/require-native-evidence.mjs';
import { serveGate4Reporter } from '../.github/validation/gate4-reporter.mjs';

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('reporter rejects stale, out-of-order, duplicate, and post-terminal evidence', async () => {
  const output = await mkdtemp(join(tmpdir(), 'easysplit-gate4-reporter-'));
  const runId = 'run-integrity';
  const server = await serveGate4Reporter(output, 0, runId);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (path, body) => fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await send('/progress', {
      runId: 'stale-run', platform: 'ios', stage: 'APPLICATION_READY', status: 'RUNNING', markers: [],
    })).status, 400);
    assert.equal((await send('/progress', {
      runId, platform: 'ios', stage: 'REALTIME_PARTICIPANT', status: 'PASS', markers: GATE4_CORE_MARKERS.slice(1, 2),
    })).status, 400);
    const progress = [];
    for (let index = 0; index < GATE4_STAGES.length; index += 1) {
      const stage = GATE4_STAGES[index];
      if (stage !== 'NATIVE_CORE_FLOW') {
        progress.push({ stage, status: 'RUNNING', markers: GATE4_CORE_MARKERS.slice(0, Math.max(0, index - 1)) });
      }
      progress.push({ stage, status: 'PASS', markers: GATE4_CORE_MARKERS.slice(0, index) });
    }
    progress.at(-1).markers = [...GATE4_CORE_MARKERS];
    const first = progress.shift();
    assert.equal((await send('/progress', { runId, platform: 'ios', ...first })).status, 200);
    assert.equal((await send('/progress', { runId, platform: 'ios', ...first })).status, 400);
    assert.equal((await send('/progress', {
      runId, platform: 'ios', stage: 'REALTIME_PARTICIPANT', status: 'RUNNING', markers: GATE4_CORE_MARKERS.slice(0, 1),
    })).status, 400);
    for (const update of progress) {
      assert.equal((await send('/progress', { runId, platform: 'ios', ...update })).status, 200);
    }

    const terminal = { runId, platform: 'ios', stage: 'NATIVE_CORE_FLOW', status: 'PASS', markers: GATE4_CORE_MARKERS };
    assert.equal((await send('/report', terminal)).status, 200);
    assert.equal((await send('/report', terminal)).status, 409);
    assert.equal((await send('/progress', {
      runId, platform: 'ios', stage: 'NATIVE_CORE_FLOW', status: 'PASS', markers: GATE4_CORE_MARKERS,
    })).status, 409);
    assert.deepEqual(JSON.parse(await readFile(join(output, 'ios-result.json'), 'utf8')), terminal);
    assert.equal((await readFile(join(output, 'ios-progress.jsonl'), 'utf8')).trim().split('\n').length, 11);
  } finally {
    await close(server);
    await rm(output, { recursive: true, force: true });
  }
});

test('native evidence validator reports every Gate 4 and Gate 3 gap instead of stopping at the first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'easysplit-gate4-evidence-errors-'));
  const gate4 = join(root, 'gate4');
  const gate3 = join(root, 'gate3');
  await mkdir(gate4);
  await mkdir(gate3);
  try {
    await writeFile(join(gate4, 'gate4-result.txt'), 'runner failed\n');
    await writeFile(join(gate4, 'gate4-exit-code.txt'), '23\n');
    await writeFile(join(gate4, 'android-result.json'), JSON.stringify({
      runId: 'wrong-run', platform: 'android', status: 'FAIL', stage: 'SESSION_CREATION', markers: [], error: 'failed',
    }));
    await writeFile(join(gate3, 'result.txt'), 'ANDROID_COLD_LAUNCH=PASS\n');
    await writeFile(join(gate3, 'exit-code.txt'), '19\n');
    const errors = await collectNativeEvidenceErrors('android', gate4, gate3, 'expected-run');
    assert.ok(errors.some((error) => error.includes('Gate 4 wrapper exit code is 23')));
    assert.ok(errors.some((error) => error.includes('Gate 4 terminal report is invalid')));
    assert.ok(errors.some((error) => error.includes('Gate 3 wrapper exit code is 19')));
    assert.ok(errors.some((error) => error.includes('Gate 3 screenshot is missing')));
    assert.ok(errors.some((error) => error.includes('ANDROID_BACK_ROOT=PASS')));
    assert.ok(errors.length > 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native evidence validator accepts a complete Android Gate 4 plus Gate 3 evidence set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'easysplit-gate4-evidence-pass-'));
  const gate4 = join(root, 'gate4');
  const gate3 = join(root, 'gate3');
  const runId = 'run-pass';
  await mkdir(gate4);
  await mkdir(gate3);
  const gate3Markers = [
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
  ];
  try {
    await Promise.all([
      writeFile(join(gate4, 'gate4-result.txt'), `${GATE4_CORE_MARKERS.join('\n')}\n`),
      writeFile(join(gate4, 'gate4-exit-code.txt'), '0\n'),
      writeFile(join(gate4, 'android-result.json'), `${JSON.stringify({
        runId, platform: 'android', status: 'PASS', stage: 'NATIVE_CORE_FLOW', markers: GATE4_CORE_MARKERS,
      })}\n`),
      writeFile(join(gate4, 'android-progress.jsonl'), '{"stage":"APPLICATION_READY"}\n'),
      writeFile(join(gate4, 'gate4-final.png'), 'png'),
      writeFile(join(gate4, 'gate4-logcat.txt'), 'logcat'),
      writeFile(join(gate3, 'result.txt'), `${gate3Markers.join('\n')}\n`),
      writeFile(join(gate3, 'exit-code.txt'), '0\n'),
      writeFile(join(gate3, 'final.png'), 'png'),
      writeFile(join(gate3, 'logcat.txt'), 'logcat'),
    ]);
    assert.deepEqual(await collectNativeEvidenceErrors('android', gate4, gate3, runId), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
