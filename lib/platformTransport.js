/**
 * EasySplit client transport boundary.
 *
 * Web parity is the default: when no mobile/public backend origin is configured,
 * API requests stay relative and realtime connects to the current page origin.
 * Native builds can opt into a remote backend by setting the public origins.
 */

function trimTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeHttpOrigin(value, variableName) {
  const raw = trimTrailingSlashes(value);
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error(`${variableName} must be an absolute http(s) origin`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${variableName} must use http or https`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error(`${variableName} must be an origin only (no path, query, credentials, or fragment)`);
  }
  return parsed.origin;
}

function normalizeWebSocketOrigin(value, variableName) {
  const raw = trimTrailingSlashes(value);
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error(`${variableName} must be an absolute ws(s) origin`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`${variableName} must use ws or wss`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error(`${variableName} must be an origin only (no path, query, credentials, or fragment)`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function configuredApiOrigin() {
  return normalizeHttpOrigin(
    process.env.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN || '',
    'NEXT_PUBLIC_EASYSPLIT_API_ORIGIN',
  );
}

function configuredPublicWebOrigin() {
  return normalizeHttpOrigin(
    process.env.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN || '',
    'NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN',
  );
}

function configuredRealtimeOrigin() {
  return normalizeWebSocketOrigin(
    process.env.NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN || '',
    'NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN',
  );
}

function apiUrl(path) {
  if (typeof path !== 'string' || !path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const origin = configuredApiOrigin();
  if (!origin) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${normalizedPath}`;
}

function publicWebUrl(path) {
  if (typeof path !== 'string' || !path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const configured = configuredPublicWebOrigin();
  const origin = configured || (typeof window !== 'undefined' ? window.location?.origin || '' : '');
  if (!origin) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${normalizedPath}`;
}

function hasConfiguredApiOrigin() {
  return Boolean(configuredApiOrigin());
}

function getApiOrigin() {
  const configured = configuredApiOrigin();
  if (configured) return configured;
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return '';
}

function realtimeUrl() {
  const configuredWs = configuredRealtimeOrigin();
  if (configuredWs) return configuredWs;

  const apiOrigin = configuredApiOrigin();
  if (apiOrigin) {
    const parsed = new URL(apiOrigin);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${parsed.protocol}//${parsed.host}`;
  }

  if (typeof window === 'undefined' || !window.location) return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

module.exports = {
  apiUrl,
  configuredApiOrigin,
  configuredPublicWebOrigin,
  configuredRealtimeOrigin,
  getApiOrigin,
  hasConfiguredApiOrigin,
  normalizeHttpOrigin,
  normalizeWebSocketOrigin,
  publicWebUrl,
  realtimeUrl,
};
