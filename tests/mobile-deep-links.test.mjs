import test from 'node:test';
import assert from 'node:assert/strict';
import { incomingRouteFromUrl } from '../mobile/deep-link-core.mjs';

test('custom EasySplit links route sessions and preserve bearer invite fragments', () => {
  assert.deepEqual(
    incomingRouteFromUrl('easysplit://session/s_123?groupId=g_1#invite=secret-token'),
    { path: '/session/s_123?groupId=g_1', hash: '#invite=secret-token' },
  );
});

test('public web links route groups without trusting a nested shell route', () => {
  assert.deepEqual(
    incomingRouteFromUrl('https://easysplit.example/group/g_123?esRoute=/session/attacker'),
    { path: '/group/g_123', hash: '' },
  );
});

test('deep links reject unsupported schemes and non-core paths', () => {
  assert.equal(incomingRouteFromUrl('javascript:alert(1)'), null);
  assert.equal(incomingRouteFromUrl('easysplit://settings'), null);
  assert.equal(incomingRouteFromUrl('not a URL'), null);
});
