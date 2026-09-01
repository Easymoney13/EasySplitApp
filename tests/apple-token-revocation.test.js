const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  APPLE_AUDIENCE,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  createAppleClientSecret,
  getAppleRevocationConfig,
  revokeAppleAuthorization,
} = require('../lib/appleTokenRevocation');

function testKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey,
  };
}

function config(privateKey) {
  return {
    teamId: 'TEAM123456',
    keyId: 'KEY1234567',
    clientId: 'com.easysplit.app',
    privateKey,
  };
}
test('Apple client secret is a short-lived ES256 JWT for the configured app', () => {
  const keys = testKeys();
  const nowMs = 1_800_000_000_000;
  const jwt = createAppleClientSecret(config(keys.privateKey), nowMs);
  const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

  assert.deepEqual(header, { alg: 'ES256', kid: 'KEY1234567' });
  assert.equal(payload.iss, 'TEAM123456');
  assert.equal(payload.sub, 'com.easysplit.app');
  assert.equal(payload.aud, APPLE_AUDIENCE);
  assert.equal(payload.exp - payload.iat, 300);
  assert.equal(crypto.verify(
    'sha256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key: keys.publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(encodedSignature, 'base64url'),
  ), true);
});

test('Apple revocation exchanges a fresh authorization code then revokes the refresh token', async () => {
  const keys = testKeys();
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: new URLSearchParams(options.body) });
    if (url === APPLE_TOKEN_URL) {
      return { ok: true, status: 200, json: async () => ({ refresh_token: 'refresh-token' }) };
    }
    if (url === APPLE_REVOKE_URL) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await revokeAppleAuthorization('fresh-code', {
    config: config(keys.privateKey),
    fetchImpl,
    nowMs: 1_800_000_000_000,
  });

  assert.deepEqual(result, { revoked: true, tokenType: 'refresh_token' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, APPLE_TOKEN_URL);
  assert.equal(requests[0].body.get('code'), 'fresh-code');
  assert.equal(requests[0].body.get('grant_type'), 'authorization_code');
  assert.equal(requests[1].url, APPLE_REVOKE_URL);
  assert.equal(requests[1].body.get('token'), 'refresh-token');
  assert.equal(requests[1].body.get('token_type_hint'), 'refresh_token');
});
test('Apple revocation fails closed when release credentials are absent', () => {
  assert.throws(
    () => getAppleRevocationConfig({}),
    (error) => error?.statusCode === 503
      && error?.errorCode === 'APPLE_REVOCATION_NOT_CONFIGURED',
  );
});

test('Apple revocation does not continue to revoke after a failed token exchange', async () => {
  const keys = testKeys();
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
  };
  await assert.rejects(
    revokeAppleAuthorization('expired-code', { config: config(keys.privateKey), fetchImpl }),
    (error) => error?.statusCode === 502 && error?.errorCode === 'APPLE_REVOCATION_FAILED',
  );
  assert.equal(requests, 1);
});
