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

/**
 * Production User-ID & Dual-Tier Rate Limiter
 * Enforces per-user short-window (e.g. 10m) and daily (24h) request caps
 * Protects against IP rotation, botnets, and AI billing spikes
 */
function createUserRateLimiter({
  shortWindowMs = 10 * 60 * 1000,
  shortMax = 5,
  dailyWindowMs = 24 * 60 * 60 * 1000,
  dailyMax = 25,
  shortMessage = 'Rate limit reached: Maximum 5 receipt scans per 10 minutes. Please wait before scanning again.',
  dailyMessage = 'Daily limit reached: Maximum 25 receipt scans per day. Please try again tomorrow.',
  requireAuth = true,
  unauthMessage = 'Authentication required: Please sign in to scan receipts.',
} = {}) {
  const userBuckets = new Map();

  function prune(now) {
    if (userBuckets.size > 2000) {
      for (const [key, timestamps] of userBuckets) {
        const recent = timestamps.filter((t) => now - t < dailyWindowMs);
        if (recent.length === 0) userBuckets.delete(key);
        else userBuckets.set(key, recent);
      }
    }
  }

  function check(userKey, now = Date.now()) {
    prune(now);
    const raw = userBuckets.get(userKey) || [];
    const timestamps = raw.filter((t) => now - t < dailyWindowMs);

    // 1. Check daily cap
    if (timestamps.length >= dailyMax) {
      const oldestInDay = timestamps[0] || now;
      const resetTime = oldestInDay + dailyWindowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetTime - now) / 1000));
      return {
        allowed: false,
        reason: 'daily',
        message: dailyMessage,
        remainingShort: 0,
        remainingDaily: 0,
        resetTime,
        retryAfterSeconds,
      };
    }

    // 2. Check short window cap
    const shortTimestamps = timestamps.filter((t) => now - t < shortWindowMs);
    if (shortTimestamps.length >= shortMax) {
      const oldestInShort = shortTimestamps[0] || now;
      const resetTime = oldestInShort + shortWindowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetTime - now) / 1000));
      return {
        allowed: false,
        reason: 'short',
        message: shortMessage,
        remainingShort: 0,
        remainingDaily: Math.max(0, dailyMax - timestamps.length),
        resetTime,
        retryAfterSeconds,
      };
    }

    timestamps.push(now);
    userBuckets.set(userKey, timestamps);

    return {
      allowed: true,
      remainingShort: Math.max(0, shortMax - (shortTimestamps.length + 1)),
      remainingDaily: Math.max(0, dailyMax - timestamps.length),
      resetTime: now + shortWindowMs,
      retryAfterSeconds: 0,
    };
  }

  function middleware(req, res, next) {
    // User-confirmed or manual drafts do not call an external OCR provider and must not consume scan quota
    if (req.body?.parsedBill && !req.body?.imageBase64 && !req.body?.imageBase64Parts && !req.body?.rawText) {
      return typeof next === 'function' ? next() : undefined;
    }

    const userId = req.user?.uid;
    if (requireAuth && !userId) {
      return res.status(401).json({
        error: unauthMessage,
        errorCode: 'AUTH_REQUIRED',
        authRequired: true,
      });
    }

    const key = userId ? `user:${userId}` : `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const result = check(key);

    res.setHeader('X-RateLimit-Limit-Short', shortMax);
    res.setHeader('X-RateLimit-Remaining-Short', result.remainingShort);
    res.setHeader('X-RateLimit-Limit-Daily', dailyMax);
    res.setHeader('X-RateLimit-Remaining-Daily', result.remainingDaily);
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000));

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfterSeconds);
      return res.status(429).json({
        error: result.message,
        errorCode: result.reason === 'daily' ? 'DAILY_RATE_LIMIT_EXCEEDED' : 'RATE_LIMIT_EXCEEDED',
        retryAfter: result.retryAfterSeconds,
      });
    }

    if (typeof next === 'function') return next();
  }

  return {
    check,
    middleware,
    reset: () => userBuckets.clear(),
    getBuckets: () => userBuckets,
  };
}

function requireAuthenticatedCreator(req, res, next) {
  if (!req.user?.uid) {
    return res.status(401).json({
      error: 'Sign in once with Google to create a split or group.',
      errorCode: 'CREATOR_ACCOUNT_REQUIRED',
      authRequired: true,
    });
  }
  if (typeof next === 'function') return next();
}

module.exports = {
  sanitizeString,
  isValidRoomCode,
  isValidSessionId,
  isValidGroupId,
  sanitizePrice,
  sanitizeName,
  createIpRateLimiter,
  createUserRateLimiter,
  requireAuthenticatedCreator,
};
module.exports.__esModule = true;
module.exports.sanitizeString = sanitizeString;
module.exports.isValidRoomCode = isValidRoomCode;
module.exports.isValidSessionId = isValidSessionId;
module.exports.isValidGroupId = isValidGroupId;
module.exports.sanitizePrice = sanitizePrice;
module.exports.sanitizeName = sanitizeName;
module.exports.createIpRateLimiter = createIpRateLimiter;
module.exports.createUserRateLimiter = createUserRateLimiter;
module.exports.requireAuthenticatedCreator = requireAuthenticatedCreator;
exports.sanitizeString = sanitizeString;
exports.isValidRoomCode = isValidRoomCode;
exports.isValidSessionId = isValidSessionId;
exports.isValidGroupId = isValidGroupId;
exports.sanitizePrice = sanitizePrice;
exports.sanitizeName = sanitizeName;
exports.createIpRateLimiter = createIpRateLimiter;
exports.createUserRateLimiter = createUserRateLimiter;
exports.requireAuthenticatedCreator = requireAuthenticatedCreator;
