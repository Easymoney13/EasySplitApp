import test from 'node:test';
import assert from 'node:assert/strict';
import {
  intentionalRendererTerminationLines,
  readLogcatWithRetries,
  recordIntentionalRendererTerminations,
  rendererTerminationLines,
  unexpectedRendererTerminationLines,
  waitForIntentionalRendererTerminations,
} from '../.github/validation/native-android-logcat.mjs';

const intentional = 'E/aw_browser_terminator( 100): Renderer process (200) crash detected (code -1).';
const realCrash = 'E/aw_browser_terminator( 100): Renderer process (201) crash detected (code 11).';
const appDestroyed = 'D/Capacitor( 100): App destroyed';
const systemKill = 'I/ActivityManager( 300): Killing 200:com.google.android.webview:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:0/u0a216i12 (adj 0): isolated not needed';
const cleanExit = 'I/Zygote  ( 300): Process 200 exited cleanly (0)';
const killedExit = 'I/Zygote  ( 300): Process 200 exited due to signal 9 (Killed)';

const rootBackOptions = { requireRootBackTeardown: true, appProcessIds: ['100'] };

function recordRootBack(afterLogcat, beforeLogcat = '') {
  const expected = new Map();
  recordIntentionalRendererTerminations(
    expected,
    beforeLogcat,
    afterLogcat,
    rootBackOptions,
  );
  return expected;
}

test('logcat reads recover from a transient ADB failure without changing their output', () => {
  let reads = 0;
  const logcat = readLogcatWithRetries(() => {
    reads += 1;
    if (reads < 3) throw new Error('transient adb failure');
    return 'complete logcat';
  });

  assert.equal(logcat, 'complete logcat');
  assert.equal(reads, 3);
});

test('logcat reads still fail closed after the bounded retry budget', () => {
  let reads = 0;
  assert.throws(
    () => readLogcatWithRetries(() => {
      reads += 1;
      throw new Error(`adb failure ${reads}`);
    }),
    /adb failure 3/,
  );
  assert.equal(reads, 3);
});

test('renderer scan records only a new code -1 emitted by an intentional process stop', () => {
  const expected = new Map();
  recordIntentionalRendererTerminations(expected, 'unrelated', `unrelated\n${intentional}`);

  assert.equal(expected.get(intentional), 1);
  assert.deepEqual(unexpectedRendererTerminationLines(intentional, expected), []);
});

test('renderer scan never excuses a non-kill renderer crash during the intentional-stop window', () => {
  const expected = new Map();
  recordIntentionalRendererTerminations(expected, '', `${intentional}\n${realCrash}`);

  assert.deepEqual(unexpectedRendererTerminationLines(`${intentional}\n${realCrash}`, expected), [realCrash]);
});

test('renderer scan detects a repeated crash beyond the exact expected occurrence count', () => {
  const expected = new Map();
  recordIntentionalRendererTerminations(expected, '', intentional);

  assert.deepEqual(
    unexpectedRendererTerminationLines(`${intentional}\n${intentional}`, expected),
    [intentional],
  );
});

test('renderer scan ignores unrelated logcat lines and retains every crash occurrence', () => {
  assert.deepEqual(rendererTerminationLines(`noise\n${realCrash}\nnoise\n${realCrash}`), [realCrash, realCrash]);
});

test('root Back accepts a new same-PID Android teardown with a clean renderer exit', () => {
  const expected = recordRootBack(
    `${appDestroyed}\n${intentional}\n${systemKill}\n${cleanExit}`,
  );

  assert.deepEqual(unexpectedRendererTerminationLines(intentional, expected), []);
});

test('root Back accepts a new same-PID Android isolated-process SIGKILL', () => {
  const expected = recordRootBack(
    `${appDestroyed}\n${intentional}\n${systemKill}\n${killedExit}`,
  );

  assert.deepEqual(unexpectedRendererTerminationLines(intentional, expected), []);
});

test('root Back accepts cross-thread Zygote evidence logged before ActivityManager cleanup', () => {
  const expected = recordRootBack(
    `${appDestroyed}\n${intentional}\n${cleanExit}\n${systemKill}`,
  );

  assert.deepEqual(unexpectedRendererTerminationLines(intentional, expected), []);
});

test('root Back accepts Android 16 reporting its isolated-process kill before Chromium observes it', () => {
  const expected = recordRootBack(
    `${appDestroyed}\n${systemKill}\n${intentional}\n${killedExit}`,
  );

  assert.deepEqual(unexpectedRendererTerminationLines(intentional, expected), []);
});

for (const [name, logcat] of [
  ['missing app destruction', `${intentional}\n${systemKill}\n${killedExit}`],
  ['app destruction from a different PID', `${appDestroyed.replace('( 100)', '( 999)')}\n${intentional}\n${systemKill}\n${killedExit}`],
  ['wrong emitting app PID', `${appDestroyed}\n${intentional.replace('( 100)', '( 999)')}\n${systemKill}\n${killedExit}`],
  ['missing Android kill reason', `${appDestroyed}\n${intentional}\n${killedExit}`],
  ['wrong Android kill reason', `${appDestroyed}\n${intentional}\n${systemKill.replace('isolated not needed', 'crash')}\n${killedExit}`],
  ['mismatched ActivityManager PID', `${appDestroyed}\n${intentional}\n${systemKill.replace('Killing 200:', 'Killing 999:')}\n${killedExit}`],
  ['mismatched Zygote PID', `${appDestroyed}\n${intentional}\n${systemKill}\n${killedExit.replace('Process 200', 'Process 999')}`],
  ['unexpected renderer exit signal', `${appDestroyed}\n${intentional}\n${systemKill}\n${killedExit.replace('signal 9 (Killed)', 'signal 6 (Aborted)')}`],
]) {
  test(`root Back rejects ${name}`, () => {
    const expected = recordRootBack(logcat);

    assert.deepEqual(unexpectedRendererTerminationLines(intentional, expected), [intentional]);
  });
}

test('root Back never reuses stale teardown evidence from before the action', () => {
  const staleEvidence = `${appDestroyed}\n${intentional}\n${systemKill}\n${cleanExit}`;
  const afterLogcat = `${staleEvidence}\n${intentional}`;
  const expected = recordRootBack(afterLogcat, staleEvidence);

  assert.deepEqual(unexpectedRendererTerminationLines(intentional, expected), [intentional]);
});

test('root Back records one proven teardown and leaves an extra termination failing', () => {
  const secondTermination = intentional.replace('Renderer process (200)', 'Renderer process (202)');
  const fullLogcat = `${appDestroyed}\n${intentional}\n${systemKill}\n${killedExit}\n${secondTermination}`;
  const expected = recordRootBack(fullLogcat);

  assert.deepEqual(
    unexpectedRendererTerminationLines(`${intentional}\n${secondTermination}`, expected),
    [secondTermination],
  );
});

test('root Back rejects duplicate renderer terminations even when they share valid evidence', () => {
  assert.throws(
    () => recordRootBack(
      `${appDestroyed}\n${intentional}\n${intentional}\n${systemKill}\n${killedExit}`,
    ),
    /emitted 2 renderer terminations/,
  );
});

test('root Back rejects two independently complete renderer teardown chains', () => {
  const secondIntentional = intentional.replace('Renderer process (200)', 'Renderer process (202)');
  const secondSystemKill = systemKill.replace('Killing 200:', 'Killing 202:');
  const secondKilledExit = killedExit.replace('Process 200', 'Process 202');
  assert.throws(
    () => recordRootBack(
      `${appDestroyed}\n${intentional}\n${systemKill}\n${killedExit}\n${secondIntentional}\n${secondSystemKill}\n${secondKilledExit}`,
    ),
    /emitted 2 renderer terminations/,
  );
});

test('root Back polling waits behaviorally for delayed system disposition', async () => {
  const snapshots = [
    appDestroyed,
    `${appDestroyed}\n${intentional}`,
    `${appDestroyed}\n${intentional}\n${systemKill}`,
    `${appDestroyed}\n${intentional}\n${systemKill}\n${killedExit}`,
  ];
  let reads = 0;
  const evidence = await waitForIntentionalRendererTerminations(
    async () => snapshots[Math.min(reads++, snapshots.length - 1)],
    '',
    rootBackOptions,
    { timeoutMs: 100, intervalMs: 1 },
  );

  assert.equal(reads, 4);
  assert.deepEqual(evidence.expectedLines, [intentional]);
});

test('root Back polling fails when a termination never receives a complete disposition', async () => {
  await assert.rejects(
    waitForIntentionalRendererTerminations(
      async () => `${appDestroyed}\n${intentional}\n${systemKill}`,
      '',
      rootBackOptions,
      { timeoutMs: 5, intervalMs: 1 },
    ),
    /complete root Back system-teardown evidence/,
  );
});

test('root Back polling remembers an incomplete termination after log rotation hides it', async () => {
  const snapshots = [`${appDestroyed}\n${intentional}`, ''];
  let reads = 0;
  await assert.rejects(
    waitForIntentionalRendererTerminations(
      async () => snapshots[Math.min(reads++, snapshots.length - 1)],
      '',
      rootBackOptions,
      { timeoutMs: 5, intervalMs: 1 },
    ),
    /complete root Back system-teardown evidence/,
  );
});

test('root Back rejects app-authored text that imitates ActivityManager and Zygote', () => {
  const fakeSystemKill = `I/FakeTag( 100): ${systemKill.replace(/^I\/ActivityManager\( 300\): /, '')}`;
  const fakeKilledExit = `I/FakeTag( 100): ${killedExit.replace(/^I\/Zygote  \( 300\): /, '')}`;
  const expected = recordRootBack(
    `${appDestroyed}\n${intentional}\n${fakeSystemKill}\n${fakeKilledExit}`,
  );

  assert.deepEqual(unexpectedRendererTerminationLines(intentional, expected), [intentional]);
});

test('root Back rejects app destruction text emitted under a non-Capacitor tag', () => {
  const fakeAppDestroyed = 'D/FakeTag( 100): Capacitor lifecycle says App destroyed';
  const expected = recordRootBack(
    `${fakeAppDestroyed}\n${intentional}\n${systemKill}\n${killedExit}`,
  );

  assert.deepEqual(unexpectedRendererTerminationLines(intentional, expected), [intentional]);
});

test('root Back pure classifier ignores non--1 crashes even with teardown-like evidence', () => {
  assert.deepEqual(
    intentionalRendererTerminationLines(
      '',
      `${appDestroyed}\n${realCrash}\n${systemKill.replace('200:', '201:')}\n${cleanExit.replace('200', '201')}`,
      rootBackOptions,
    ),
    [],
  );
});
