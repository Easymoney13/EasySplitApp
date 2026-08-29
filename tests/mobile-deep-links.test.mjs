import test from 'node:test';
import assert from 'node:assert/strict';
import { incomingRouteFromUrl, nativeInviteUrlFromWeb } from '../mobile/deep-link-core.mjs';

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

test('native shares derive a routable app URL while keeping the public URL available as fallback text', () => {
  assert.equal(
    nativeInviteUrlFromWeb('https://easysplit.example/session/s_123?groupId=g_1#invite=secret-token'),
    'easysplit://session/s_123?groupId=g_1#invite=secret-token',
  );
  assert.equal(
    nativeInviteUrlFromWeb('https://easysplit.example/group/g_123?esRoute=/session/attacker'),
    'easysplit://group/g_123',
  );
});

test('outgoing app links reject non-web and non-room targets', () => {
  assert.equal(nativeInviteUrlFromWeb('javascript:alert(1)'), '');
  assert.equal(nativeInviteUrlFromWeb('https://easysplit.example/settings'), '');
  assert.equal(nativeInviteUrlFromWeb('not a URL'), '');
});

test('deep links reject unsupported schemes and non-core paths', () => {
  assert.equal(incomingRouteFromUrl('javascript:alert(1)'), null);
  assert.equal(incomingRouteFromUrl('easysplit://settings'), null);
  assert.equal(incomingRouteFromUrl('not a URL'), null);
});
