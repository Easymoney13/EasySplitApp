import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = new URL('../', import.meta.url);
const wrapper = new URL('.github/validation/run-native-android-runtime.sh', root);

test('runtime wrapper preserves validator failure and still captures diagnostics', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'easysplit-android-wrapper-'));
  const diagnostics = join(fixtureRoot, 'diagnostics');
  const fakeAdb = join(fixtureRoot, 'adb');
  const fakeNode = join(fixtureRoot, 'node');
  const fakeApk = join(fixtureRoot, 'app-debug.apk');

  try {
    await writeFile(fakeAdb, `#!/usr/bin/env bash
case "$1" in
  install) printf 'Success\\n' ;;
  exec-out) printf 'fake-png-bytes' ;;
  logcat) printf 'fake-logcat-line\\n' ;;
  *) exit 64 ;;
esac
`);
    await writeFile(fakeNode, `#!/usr/bin/env bash
printf 'validator failed after isolated scenarios\\n'
exit 23
`);
    await writeFile(fakeApk, 'fixture');
    await chmod(fakeAdb, 0o755);
    await chmod(fakeNode, 0o755);

    await execFileAsync('bash', [wrapper.pathname, diagnostics, fakeApk], {
      env: {
        ...process.env,
        ADB: fakeAdb,
        EASYSPLIT_NODE_BIN: fakeNode,
      },
    });

    assert.equal((await readFile(join(diagnostics, 'exit-code.txt'), 'utf8')).trim(), '23');
    assert.match(
      await readFile(join(diagnostics, 'result.txt'), 'utf8'),
      /validator failed after isolated scenarios/,
    );
    assert.equal(await readFile(join(diagnostics, 'final.png'), 'utf8'), 'fake-png-bytes');
    assert.match(await readFile(join(diagnostics, 'logcat.txt'), 'utf8'), /fake-logcat-line/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
