const crypto = require('crypto');
const fs = require('fs');

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;
const EASYSPLIT_APPLE_CLIENT_ID = 'com.easysplit.app';

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function releaseConfigError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.errorCode = 'APPLE_REVOCATION_NOT_CONFIGURED';
  error.publicMessage = 'Sign in with Apple account deletion is temporarily unavailable.';
  return error;
}

function appleRequestError(message, details = '') {
  const error = new Error(details ? `${message}: ${details}` : message);
  error.statusCode = 502;
  error.errorCode = 'APPLE_REVOCATION_FAILED';
  error.publicMessage = 'Apple authorization could not be revoked. Please try again.';
  return error;
}
function readPrivateKey(env = process.env) {
  const inlineKey = String(env.EASYSPLIT_APPLE_PRIVATE_KEY || env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (inlineKey) return inlineKey;
  const keyPath = String(env.EASYSPLIT_APPLE_PRIVATE_KEY_PATH || env.APPLE_PRIVATE_KEY_PATH || '').trim();
  if (!keyPath) return '';
  try {
    return fs.readFileSync(keyPath, 'utf8').trim();
  } catch (error) {
    throw releaseConfigError(`Could not read APPLE_PRIVATE_KEY_PATH: ${error.message}`);
  }
}

function getAppleRevocationConfig(env = process.env) {
  const config = {
    teamId: String(env.EASYSPLIT_APPLE_TEAM_ID || env.APPLE_TEAM_ID || '').trim(),
    keyId: String(env.EASYSPLIT_APPLE_KEY_ID || env.APPLE_KEY_ID || '').trim(),
    clientId: String(env.EASYSPLIT_APPLE_CLIENT_ID || env.APPLE_CLIENT_ID || EASYSPLIT_APPLE_CLIENT_ID).trim(),
    privateKey: readPrivateKey(env),
  };
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw releaseConfigError(`Missing Apple revocation credentials: ${missing.join(', ')}`);
  }
  return config;
}

function normalizeAuthorizationCode(value) {
  if (typeof value !== 'string') return '';
  const code = value.trim();
  return code && code.length <= 4096 ? code : '';
}
function createAppleClientSecret(config, nowMs = Date.now()) {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64UrlJson({ alg: 'ES256', kid: config.keyId });
  const payload = base64UrlJson({
    iss: config.teamId,
    iat: issuedAt,
    exp: issuedAt + CLIENT_SECRET_TTL_SECONDS,
    aud: APPLE_AUDIENCE,
    sub: config.clientId,
  });
  const signingInput = `${header}.${payload}`;
  let signature;
  try {
    signature = crypto.sign('sha256', Buffer.from(signingInput), {
      key: config.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
  } catch (error) {
    throw releaseConfigError(`Invalid Apple private key: ${error.message}`);
  }
  return `${signingInput}.${signature.toString('base64url')}`;
}

async function postAppleForm(url, params, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw appleRequestError('Fetch is unavailable');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return response;
}
async function exchangeAppleAuthorizationCode(code, options = {}) {
  const authorizationCode = normalizeAuthorizationCode(code);
  if (!authorizationCode) throw appleRequestError('A fresh Apple authorization code is required');
  const config = options.config || getAppleRevocationConfig(options.env);
  const clientSecret = createAppleClientSecret(config, options.nowMs);
  const response = await postAppleForm(APPLE_TOKEN_URL, {
    client_id: config.clientId,
    client_secret: clientSecret,
    code: authorizationCode,
    grant_type: 'authorization_code',
  }, options.fetchImpl);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw appleRequestError('Apple token exchange failed', payload.error || `HTTP ${response.status}`);
  }
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : '';
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!refreshToken && !accessToken) throw appleRequestError('Apple token exchange returned no revocable token');
  return { config, refreshToken, accessToken };
}

async function revokeAppleAuthorization(code, options = {}) {
  const tokens = await exchangeAppleAuthorizationCode(code, options);
  const token = tokens.refreshToken || tokens.accessToken;
  const tokenTypeHint = tokens.refreshToken ? 'refresh_token' : 'access_token';
  const clientSecret = createAppleClientSecret(tokens.config, options.nowMs);
  const response = await postAppleForm(APPLE_REVOKE_URL, {
    client_id: tokens.config.clientId,
    client_secret: clientSecret,
    token,
    token_type_hint: tokenTypeHint,
  }, options.fetchImpl);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw appleRequestError('Apple token revocation failed', payload.error || `HTTP ${response.status}`);
  }
  return { revoked: true, tokenType: tokenTypeHint };
}

module.exports = {
  APPLE_AUDIENCE,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  EASYSPLIT_APPLE_CLIENT_ID,
  createAppleClientSecret,
  exchangeAppleAuthorizationCode,
  getAppleRevocationConfig,
  normalizeAuthorizationCode,
  revokeAppleAuthorization,
};
