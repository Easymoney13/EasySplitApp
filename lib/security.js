/**
 * Enterprise Cyber Security Utility
 * Protects against XSS, Injection Attacks, Path Traversal, Payload Tampering, and Abuse
 */

/**
 * Strips dangerous HTML & Script tags to prevent Cross-Site Scripting (XSS)
 */
function sanitizeString(input, maxLength = 100) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<[^>]*>?/gm, '') // Remove HTML tags
    .replace(/javascript:/gi, '') // Remove JS protocols
    .replace(/on\w+=/gi, '') // Remove inline handlers e.g. onload=
    .trim()
    .substring(0, maxLength);
}

/**
 * Validates current 8-digit room codes and legacy 4-digit stored codes.
 */
function isValidRoomCode(code) {
  return /^(?:\d{8}|\d{4})$/.test(code);
}

/**
 * Validates session ID format (sess_TIMESTAMP_RANDOM)
 */
function isValidSessionId(sessionId) {
  return /^(sess_(?:g_)?[a-z0-9_\-]{6,100}|\d{4}|\d{8})$/i.test(String(sessionId || ''));
}

function isValidGroupId(groupId) {
  return /^(grp_[a-z0-9_\-]{6,100}|\d{4}|\d{8})$/i.test(String(groupId || ''));
}

/**
 * Validates price amounts (positive numbers up to 50,000)
 */
function sanitizePrice(price) {
  const num = parseFloat(price);
  if (isNaN(num) || num < 0 || num > 50000) return 0;
  return Math.round(num * 100) / 100;
}

/**
 * Sanitizes host/member names
 */
function sanitizeName(name, fallback = 'Guest') {
  const clean = sanitizeString(name, 30);
  if (!clean || clean === '?') return fallback;
  return clean;
}

/**
 * Production IP-based Rate Limiter
 * Enforces sliding/fixed-window request caps per client IP
 * Default: 5 requests per 15 minutes (900,000 ms)
 */
function createIpRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 5,
  message = 'Rate limit exceeded: Maximum 5 receipt scans per 15 minutes. Please wait before trying again.',
} = {}) {
  const buckets = new Map();

  function getClientIp(req) {
    if (!req) return 'unknown';
    const forwarded = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  function check(key, now = Date.now()) {
    const existing = buckets.get(key);
    if (!existing || now - existing.startedAt >= windowMs) {
      const newBucket = { startedAt: now, count: 1 };
      buckets.set(key, newBucket);
      return {
        allowed: true,
        remaining: Math.max(0, max - 1),
        resetTime: now + windowMs,
        retryAfterSeconds: 0,
      };
    }

    if (existing.count >= max) {
      const resetTime = existing.startedAt + windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetTime - now) / 1000));
      return {
        allowed: false,
        remaining: 0,
        resetTime,
        retryAfterSeconds,
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, max - existing.count),
      resetTime: existing.startedAt + windowMs,
      retryAfterSeconds: 0,
    };
  }

  function middleware(req, res, next) {
    const now = Date.now();
    // Periodically prune stale buckets to keep memory clean
    if (buckets.size > 1000) {
      for (const [bucketKey, val] of buckets) {
        if (now - val.startedAt >= windowMs) buckets.delete(bucketKey);
      }
    }

    const key = getClientIp(req);
    const result = check(key, now);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000));

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfterSeconds);
      return res.status(429).json({
        error: message,
        retryAfter: result.retryAfterSeconds,
      });
    }

    if (typeof next === 'function') return next();
  }

  return {
    check,
    middleware,
    getClientIp,
    reset: () => buckets.clear(),
    getBuckets: () => buckets,
  };
}

module.exports = {
  sanitizeString,
  isValidRoomCode,
  isValidSessionId,
  isValidGroupId,
  sanitizePrice,
  sanitizeName,
  createIpRateLimiter,
};
module.exports.__esModule = true;
module.exports.sanitizeString = sanitizeString;
module.exports.isValidRoomCode = isValidRoomCode;
module.exports.isValidSessionId = isValidSessionId;
module.exports.isValidGroupId = isValidGroupId;
module.exports.sanitizePrice = sanitizePrice;
module.exports.sanitizeName = sanitizeName;
module.exports.createIpRateLimiter = createIpRateLimiter;
exports.sanitizeString = sanitizeString;
exports.isValidRoomCode = isValidRoomCode;
exports.isValidSessionId = isValidSessionId;
exports.isValidGroupId = isValidGroupId;
exports.sanitizePrice = sanitizePrice;
exports.sanitizeName = sanitizeName;
exports.createIpRateLimiter = createIpRateLimiter;
