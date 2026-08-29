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

function createApiCorsMiddleware(allowedOrigins) {
  return function easySplitApiCors(req, res, nextMiddleware) {
    const requestPath = String(req.path || req.url || '').split('?')[0];
    if (!requestPath.startsWith('/api/')) return nextMiddleware();

    const origin = String(req.headers?.origin || '');
    const host = String(req.headers?.host || '');
    const isCrossOrigin = Boolean(origin) && !isSameHostOrigin(origin, host);
    const allowed = !isCrossOrigin || isAllowedClientOrigin(origin, host, allowedOrigins);

    if (isCrossOrigin && allowed) {
      res.setHeader('Access-Control-Allow-Origin', normalizeOrigin(origin));
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Room-Token, X-EasySplit-Client-Id, X-Firebase-AppCheck');
      res.setHeader('Access-Control-Max-Age', '600');
      appendVaryHeader(res, 'Origin');
    }

    if (isCrossOrigin && !allowed) return res.status(403).end();

    if (String(req.method || '').toUpperCase() === 'OPTIONS') {
      if (isCrossOrigin && allowed) return res.status(204).end();
    }

    return nextMiddleware();
  };
}

module.exports = {
  DEFAULT_MOBILE_CLIENT_ORIGINS,
  appendVaryHeader,
  createApiCorsMiddleware,
  isAllowedClientOrigin,
  isSameHostOrigin,
  normalizeOrigin,
  parseAllowedOrigins,
  resolveAllowedMobileOrigins,
};
