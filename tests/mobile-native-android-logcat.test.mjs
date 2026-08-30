import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordIntentionalRendererTerminations,
  rendererTerminationLines,
  unexpectedRendererTerminationLines,
} from '../.github/validation/native-android-logcat.mjs';

const intentional = 'E/aw_browser_terminator( 100): Renderer process (200) crash detected (code -1).';
const realCrash = 'E/aw_browser_terminator( 100): Renderer process (201) crash detected (code 11).';
const cleanExit = 'I/Zygote  ( 300): Process 200 exited cleanly (0)';

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

test('root Back excuses code -1 only when the same renderer exits cleanly', () => {
  const expected = new Map();
  recordIntentionalRendererTerminations(
    expected,
    '',
    `${intentional}\n${cleanExit}`,
    { requireCleanExit: true },
  );

  assert.deepEqual(unexpectedRendererTerminationLines(`${intentional}\n${cleanExit}`, expected), []);
});

test('root Back does not excuse code -1 without a matching clean renderer exit', () => {
  const expected = new Map();
  recordIntentionalRendererTerminations(
    expected,
    '',
    `${intentional}\nI/Zygote  ( 300): Process 999 exited cleanly (0)`,
    { requireCleanExit: true },
  );

  assert.deepEqual(unexpectedRendererTerminationLines(intentional, expected), [intentional]);
});
