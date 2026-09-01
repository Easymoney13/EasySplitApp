import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(root, 'scripts/verify-ios-release-toolchain.sh');

function runWithVersions(xcodeVersion, sdkVersion) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-xcode-'));
  try {
    const xcodebuild = path.join(directory, 'xcodebuild');
    const xcrun = path.join(directory, 'xcrun');
    fs.writeFileSync(xcodebuild, `#!/usr/bin/env bash\nprintf 'Xcode ${xcodeVersion}\\nBuild version TEST\\n'\n`);
    fs.writeFileSync(xcrun, `#!/usr/bin/env bash\nprintf '${sdkVersion}\\n'\n`);
    fs.chmodSync(xcodebuild, 0o755);
    fs.chmodSync(xcrun, 0o755);
    return spawnSync('bash', [verifier], {
      cwd: root,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('iOS release toolchain accepts Xcode 26 with iPhoneOS 26 SDK', () => {
  const result = runWithVersions('26.4.1', '26.4');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release toolchain PASS/);
});

test('iOS release toolchain rejects Xcode older than 26', () => {
  const result = runWithVersions('25.4', '26.0');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require Xcode 26\+/);
});

test('iOS release toolchain rejects iPhoneOS SDK older than 26', () => {
  const result = runWithVersions('26.0', '25.4');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require the iPhoneOS 26\+ SDK/);
});
