function getFetchInputUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.href === 'string') return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return '';
  try {
    const parsed = new URL(origin);
    if (parsed.origin && parsed.origin !== 'null') return parsed.origin;
    if (parsed.protocol && parsed.host) return `${parsed.protocol}//${parsed.host}`;
    return '';
  } catch (_) {
    return '';
  }
}

function isUnprotectedApiPath(pathname) {
  return pathname === '/api/exchange-rates' || pathname === '/api/network-ip';
}

function isProtectedApi(input, pageOrigin, apiOrigin = pageOrigin) {
  const rawUrl = getFetchInputUrl(input);
  const normalizedPageOrigin = normalizeOrigin(pageOrigin);
  const normalizedApiOrigin = normalizeOrigin(apiOrigin) || normalizedPageOrigin;
  if (!rawUrl || !normalizedApiOrigin) return false;

  try {
    const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl);
    const url = isAbsolute ? new URL(rawUrl) : new URL(rawUrl, normalizedPageOrigin || normalizedApiOrigin);
    return normalizeOrigin(url.href) === normalizedApiOrigin
      && url.pathname.startsWith('/api/')
      && !isUnprotectedApiPath(url.pathname);
  } catch (_) {
    return false;
  }
}

function isProtectedSameOriginApi(input, origin) {
  return isProtectedApi(input, origin, origin);
}

module.exports = {
  getFetchInputUrl,
  isProtectedApi,
  isProtectedSameOriginApi,
};
