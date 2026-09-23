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

// Execute the real archive script with isolated command doubles. This proves
// failed audits stop before provisioning/signing without needing Apple secrets.
function runArchive({ auditStatus = 0, copiedAuditStatus = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-archive-'));
  try {
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.mkdirSync(path.join(directory, 'bin'));
    fs.mkdirSync(path.join(directory, 'node_modules/.bin'), { recursive: true });
    for (const name of ['archive-ios-release.sh', 'verify-ios-release-toolchain.sh']) {
      fs.copyFileSync(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
    }
    const writeCommand = (name, contents) => {
      const target = path.join(directory, name);
      fs.writeFileSync(target, `#!/usr/bin/env bash\nset -euo pipefail\n${contents}\n`);
      fs.chmodSync(target, 0o755);
    };
    writeCommand('bin/xcodebuild', `
if [[ "$*" == '-version' ]]; then
  printf 'Xcode 26.4.1\\nBuild version TEST\\n'
else
  printf 'archive %s\\n' "$*" >> "$EASYSPLIT_TEST_COMMAND_LOG"
fi`);
    writeCommand('bin/xcrun', "printf '26.4\\n'");
    writeCommand('bin/npm', `
printf 'npm %s\\n' "$*" >> "$EASYSPLIT_TEST_COMMAND_LOG"
[[ "$*" == 'run verify:mobile-release' ]] || exit 99
exit ${auditStatus}`);
    writeCommand('node_modules/.bin/cap', `
printf 'cap %s\\n' "$*" >> "$EASYSPLIT_TEST_COMMAND_LOG"
[[ "$*" == 'sync ios' ]] || exit 98`);
    writeCommand('bin/node', `
printf 'node %s\\n' "$*" >> "$EASYSPLIT_TEST_COMMAND_LOG"
[[ "$*" == 'scripts/verify-mobile-release.mjs ios/App/App/public' ]] || exit 97
exit ${copiedAuditStatus}`);
    const commandLog = path.join(directory, 'commands.log');
    const result = spawnSync('bash', [path.join(directory, 'scripts/archive-ios-release.sh')], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${directory}/bin:${process.env.PATH}`,
        EASYSPLIT_APPLE_TEAM_ID: 'TESTTEAM',
        EASYSPLIT_IOS_ARCHIVE_PATH: path.join(directory, 'Test.xcarchive'),
        EASYSPLIT_TEST_COMMAND_LOG: commandLog,
      },
      encoding: 'utf8',
    });
    return {
      ...result,
      commands: fs.existsSync(commandLog) ? fs.readFileSync(commandLog, 'utf8').trim().split('\n') : [],
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('iOS archive never syncs or signs when production bundle verification fails', () => {
  const result = runArchive({ auditStatus: 23 });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(result.commands, ['npm run verify:mobile-release']);
});

test('iOS archive never signs when the copied native assets fail verification', () => {
  const result = runArchive({ copiedAuditStatus: 24 });
  assert.equal(result.status, 24, result.stderr);
  assert.deepEqual(result.commands, [
    'npm run verify:mobile-release',
    'cap sync ios',
    'node scripts/verify-mobile-release.mjs ios/App/App/public',
  ]);
});

test('iOS archive signs only after auditing the exact synced bundle', () => {
  const result = runArchive();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands.slice(0, 3), [
    'npm run verify:mobile-release',
    'cap sync ios',
    'node scripts/verify-mobile-release.mjs ios/App/App/public',
  ]);
  assert.equal(result.commands.length, 4);
  assert.match(result.commands[3], /^archive /);
  assert.match(result.commands[3], /-configuration Release -sdk iphoneos -destination generic\/platform=iOS/);
  assert.match(result.commands[3], /DEVELOPMENT_TEAM=TESTTEAM/);
});
