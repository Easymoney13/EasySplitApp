import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMobileEnv } from '../mobile/env-core.mjs';

const valid = {
  NEXT_PUBLIC_EASYSPLIT_API_ORIGIN: 'https://api.easysplit.example',
  NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN: 'https://easysplit.example',
};

test('mobile build requires an API origin instead of silently targeting WebView localhost', () => {
  assert.throws(() => validateMobileEnv({ NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN: valid.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN }), /API_ORIGIN is required/);
});

test('mobile build requires a public web origin so share/QR never emit localhost', () => {
  assert.throws(() => validateMobileEnv({ NEXT_PUBLIC_EASYSPLIT_API_ORIGIN: valid.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN }), /WEB_ORIGIN is required/);
});

test('mobile origin config rejects paths and credentials', () => {
  assert.throws(() => validateMobileEnv({ ...valid, NEXT_PUBLIC_EASYSPLIT_API_ORIGIN: 'https://api.easysplit.example/v1' }), /origin only/);
  assert.throws(() => validateMobileEnv({ ...valid, NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN: 'https://u:p@easysplit.example' }), /origin only/);
});

test('websocket origin is optional but validated when supplied', () => {
  assert.equal(validateMobileEnv(valid), true);
  assert.equal(validateMobileEnv({ ...valid, NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN: 'wss://api.easysplit.example' }), true);
  assert.throws(() => validateMobileEnv({ ...valid, NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN: 'https://api.easysplit.example' }), /must use ws or wss/);
});
