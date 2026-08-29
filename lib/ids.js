const crypto = require('crypto');

function createEntityId(prefix) {
  const safePrefix = String(prefix || 'id').replace(/[^a-z0-9_]/gi, '').toLowerCase();
  return `${safePrefix}_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;
}

function createAccessToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashAccessToken(token) {
  if (!token || typeof token !== 'string') return '';
  return crypto.createHash('sha256').update(token).digest('hex');
}

function tokenMatches(token, expectedHash) {
  const actualHash = hashAccessToken(token);
  if (!actualHash || !expectedHash || actualHash.length !== expectedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
}

function collectRoomCodes(data) {
  const codes = new Set();
  Object.values(data?.sessions || {}).forEach((session) => {
    if (session?.code) codes.add(String(session.code));
  });
  Object.values(data?.groups || {}).forEach((group) => {
    if (group?.code) codes.add(String(group.code));
  });
  return codes;
}

function createUniqueRoomCode(data, randomInt = crypto.randomInt, { digits = 8 } = {}) {
  const occupied = collectRoomCodes(data);
  const lowerBound = digits === 5 ? 10_000 : 10_000_000;
  const upperBound = digits === 5 ? 100_000 : 100_000_000;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(randomInt(lowerBound, upperBound));
    if (!occupied.has(code)) return code;
  }
  // A deterministic fallback guarantees a result while the namespace has room.
  // A bounded deterministic fallback still finds every remaining free code.
  for (let candidate = lowerBound; candidate < upperBound; candidate += 1) {
    const code = String(candidate);
    if (!occupied.has(code)) return code;
  }
  throw new Error('Could not allocate a unique room code');
}

module.exports = {
  createEntityId,
  createAccessToken,
  hashAccessToken,
  tokenMatches,
  collectRoomCodes,
  createUniqueRoomCode,
};
