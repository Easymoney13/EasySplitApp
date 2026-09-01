import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/verify-mobile-release.mjs');
const production = {
  NEXT_PUBLIC_EASYSPLIT_API_ORIGIN: 'https://billspltapp.onrender.com',
  NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN: 'https://billspltapp.onrender.com',
  NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN: 'wss://billspltapp.onrender.com',
};
const validText = [
  production.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN,
  production.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN,
  production.NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN,
  'easysplit-24576.firebaseapp.com',
  'easysplit-24576',
  '1:510350845002:web:cc49a335ab30154bbcb2b3',
  '510350845002-o6t8t84c5fnvncgkspqdit0s0ndgsir9.apps.googleusercontent.com',
].join('\n');

function withBundle(files, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-release-audit-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(directory, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function run(directory, env = production) {
  return spawnSync(process.execPath, [script, directory], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('packaged release audit accepts a clean production asset directory', () => {
  withBundle({ 'index.js': validText, 'loading.mp4': Buffer.from([0, 1, 2, 3]) }, (directory) => {
    const result = run(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"releaseConfig": "PASS"/);
  });
});

test('packaged release audit rejects a missing production transport origin', () => {
  withBundle({ 'index.js': `${production.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN}\neasysplit-24576` }, (directory) => {
    const result = run(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required production origin references/);
  });
});

test('packaged release audit rejects source maps', () => {
  withBundle({ 'index.js': validText, 'index.js.map': '{}' }, (directory) => {
    const result = run(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ships source map/);
  });
});

test('packaged release audit rejects server secret material', () => {
  withBundle({
    'index.js': `${validText}\nEASYSPLIT_APPLE_PRIVATE_KEY`,
  }, (directory) => {
    const result = run(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden release marker/);
  });
});
