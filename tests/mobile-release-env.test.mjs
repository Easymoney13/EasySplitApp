import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/verify-mobile-release-env.mjs');
const production = {
  NEXT_PUBLIC_EASYSPLIT_API_ORIGIN: 'https://billspltapp.onrender.com',
  NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN: 'https://billspltapp.onrender.com',
  NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN: 'wss://billspltapp.onrender.com',
};

function run(extra = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      NEXT_PUBLIC_EASYSPLIT_API_ORIGIN: '',
      NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN: '',
      NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN: '',
      ...extra,
    },
    encoding: 'utf8',
  });
}

test('store-release origin preflight accepts only the reviewed production origins', () => {
  const result = run(production);
  assert.equal(result.status, 0, result.stderr);
});

test('store-release origin preflight rejects missing origins', () => {
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required for a store release/);
});

test('store-release origin preflight rejects HTTP and loopback', () => {
  const http = run({
    ...production,
    NEXT_PUBLIC_EASYSPLIT_API_ORIGIN: 'http://billspltapp.onrender.com',
  });
  assert.notEqual(http.status, 0);
  assert.match(http.stderr, /must use https/);

  const loopback = run({
    ...production,
    NEXT_PUBLIC_EASYSPLIT_API_ORIGIN: 'https://127.0.0.1',
  });
  assert.notEqual(loopback.status, 0);
  assert.match(loopback.stderr, /real production host/);
});

test('store-release origin preflight rejects placeholder and non-WSS origins', () => {
  const placeholder = run({
    ...production,
    NEXT_PUBLIC_EASYSPLIT_API_ORIGIN: 'https://api.easysplit.invalid',
  });
  assert.notEqual(placeholder.status, 0);
  assert.match(placeholder.stderr, /real production host/);

  const socket = run({
    ...production,
    NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN: 'ws://billspltapp.onrender.com',
  });
  assert.notEqual(socket.status, 0);
  assert.match(socket.stderr, /must use wss/);
});

test('store-release origin preflight rejects an arbitrary real HTTPS host', () => {
  const result = run({
    ...production,
    NEXT_PUBLIC_EASYSPLIT_API_ORIGIN: 'https://example.com',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must equal the reviewed EasySplit production origin/);
});
