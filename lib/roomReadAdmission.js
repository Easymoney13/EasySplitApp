'use strict';
const { createHash } = require('node:crypto');

// Cache only rate-budget classification. Every response still requires a fresh
// room read and membership check, so revocation is never cached as authorization.
function createRoomReadAdmission({ discover, now = Date.now, windowMs = 600_000, maxEntries = 5000 } = {}) {
  const known = new Map();
  const budgets = new Map();
  function identity(req, token) {
    if (req.user?.uid) return `user:${req.user.uid}`;
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return '';
    return `token:${createHash('sha256').update(token).digest('hex')}`;
  }
  function scope(req) { return req.path.startsWith('/api/groups/') ? 'group' : 'session'; }
  function trim(map) {
    while (map.size > maxEntries) map.delete(map.keys().next().value);
  }
  function remember(req, roomId, token = req.headers?.['x-room-token']) {
    const who = identity(req, token);
    if (!who || !roomId) return;
    const key = `${scope(req)}:${roomId}:${who}`;
    known.delete(key);
    known.set(key, now() + windowMs);
    trim(known);
  }
  function middleware(req, res, next) {
    const who = identity(req, req.headers?.['x-room-token']);
    const roomId = req.params.idOrCode || req.params.sessionId || req.params.groupId;
    const key = `${scope(req)}:${roomId}:${who}`;
    const time = now();
    if (!who || (known.get(key) || 0) <= time) {
      known.delete(key);
      return discover(req, res, next);
    }
    const payment = req.path.includes('/payment-target/');
    const budgetKey = `${payment ? 'payment' : 'read'}:${who}`;
    let bucket = budgets.get(budgetKey);
    if (!bucket || time >= bucket.until) bucket = { count: 0, until: time + windowMs };
    bucket.count += 1;
    budgets.set(budgetKey, bucket);
    trim(budgets);
    if (bucket.count > (payment ? 60 : 600)) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.until - time) / 1000))));
      return res.status(429).json({ error: 'Too many room reads. Please wait and try again.' });
    }
    return next();
  }
  return { middleware, remember };
}

module.exports = { createRoomReadAdmission };
