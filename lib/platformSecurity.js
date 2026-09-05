/** Server-side origin helpers for explicitly authorized native EasySplit clients. */

function normalizeOrigin(origin) {
  const raw = String(origin || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.origin && parsed.origin !== 'null') return parsed.origin;
    if (parsed.protocol && parsed.host) return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {}
  return '';
}

function parseAllowedOrigins(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}

const DEFAULT_MOBILE_CLIENT_ORIGINS = Object.freeze([
  'capacitor://localhost',
  'https://localhost',
]);

function resolveAllowedMobileOrigins(value = '') {
  return parseAllowedOrigins([
    ...DEFAULT_MOBILE_CLIENT_ORIGINS,
    String(value || ''),
  ].join(','));
}

function isSameHostOrigin(origin, host) {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === String(host).trim();
  } catch (_) {
    return false;
  }
}

function isAllowedClientOrigin(origin, host, allowedOrigins) {
  if (!origin) return true;
  if (isSameHostOrigin(origin, host)) return true;
  return allowedOrigins instanceof Set && allowedOrigins.has(normalizeOrigin(origin));
}

function appendVaryHeader(res, value) {
  const existing = typeof res.getHeader === 'function' ? String(res.getHeader('Vary') || '') : '';
  const values = existing.split(',').map((part) => part.trim()).filter(Boolean);
  if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) values.push(value);
  res.setHeader('Vary', values.join(', '));
}

function findMatchedAllowedOrigin(origin, allowedOrigins) {
  if (!origin || !(allowedOrigins instanceof Set)) return null;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return null;
  for (const allowed of allowedOrigins) {
    if (allowed === normalized) {
      return allowed;
    }
  }
  return null;
}

function createApiCorsMiddleware(allowedOrigins) {
  const safeOrigins = allowedOrigins instanceof Set ? allowedOrigins : new Set();

  return function easySplitApiCors(req, res, nextMiddleware) {
    const requestPath = String(req.path || req.url || '').split('?')[0];
    if (!requestPath.startsWith('/api/')) return nextMiddleware();

    const origin = String(req.headers?.origin || '');
    const host = String(req.headers?.host || '');
    const isCrossOrigin = Boolean(origin) && !isSameHostOrigin(origin, host);

    if (isCrossOrigin) {
      const matched = findMatchedAllowedOrigin(origin, safeOrigins);
      if (!matched) {
        return res.status(403).end();
      }

      res.setHeader('Access-Control-Allow-Origin', matched);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Room-Token, X-EasySplit-Client-Id, X-Firebase-AppCheck');
      res.setHeader('Access-Control-Max-Age', '600');
      appendVaryHeader(res, 'Origin');

      if (String(req.method || '').toUpperCase() === 'OPTIONS') {
        return res.status(204).end();
      }
    }

    return nextMiddleware();
  };
}

function createCsrfProtectionMiddleware(allowedOrigins) {
  const safeOrigins = allowedOrigins instanceof Set ? allowedOrigins : new Set();

  return function csrfProtection(req, res, nextMiddleware) {
    const method = String(req.method || '').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return nextMiddleware();
    }

    const requestPath = String(req.path || req.url || '').split('?')[0];
    if (!requestPath.startsWith('/api/')) {
      return nextMiddleware();
    }

    const origin = String(req.headers?.origin || '');
    const host = String(req.headers?.host || '');
    const secFetchSite = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
    const isCrossOrigin = Boolean(origin) && !isSameHostOrigin(origin, host);

    // 1. Cross-site request validation via browser Sec-Fetch-Site metadata
    if (secFetchSite === 'cross-site') {
      const matched = origin ? findMatchedAllowedOrigin(origin, safeOrigins) : null;
      if (!matched) {
        return res.status(403).json({ error: 'Cross-site request forgery attempt blocked' });
      }
    }

    // 2. Cross-origin mutation validation
    if (isCrossOrigin) {
      const matched = findMatchedAllowedOrigin(origin, safeOrigins);
      if (!matched) {
        return res.status(403).json({ error: 'Cross-origin request rejected' });
      }
    }

    // 3. Simple form protection: Cross-site HTML forms cannot set custom headers
    // or send application/json without triggering a CORS preflight.
    const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
    const isSimpleForm = contentType.startsWith('application/x-www-form-urlencoded') ||
                         contentType.startsWith('multipart/form-data') ||
                         contentType.startsWith('text/plain');

    const hasCustomHeader = Boolean(
      req.headers?.['x-easysplit-client-id'] ||
      req.headers?.['x-room-token'] ||
      req.headers?.['authorization'] ||
      req.headers?.['x-csrf-token'] ||
      req.headers?.['x-requested-with']
    );

    if (isSimpleForm && (isCrossOrigin || secFetchSite === 'cross-site') && !hasCustomHeader) {
      return res.status(403).json({ error: 'Invalid CSRF context for state mutation' });
    }

    return nextMiddleware();
  };
}

module.exports = {
  DEFAULT_MOBILE_CLIENT_ORIGINS,
  appendVaryHeader,
  createApiCorsMiddleware,
  createCsrfProtectionMiddleware,
  isAllowedClientOrigin,
  isSameHostOrigin,
  normalizeOrigin,
  parseAllowedOrigins,
  resolveAllowedMobileOrigins,
};
