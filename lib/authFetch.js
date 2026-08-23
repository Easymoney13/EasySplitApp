function getFetchInputUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.href === 'string') return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

function isProtectedSameOriginApi(input, origin) {
  const rawUrl = getFetchInputUrl(input);
  if (!rawUrl || typeof origin !== 'string' || !origin) return false;
  try {
    const url = new URL(rawUrl, origin);
    return url.origin === origin
      && url.pathname.startsWith('/api/')
      && url.pathname !== '/api/exchange-rates'
      && url.pathname !== '/api/network-ip';
  } catch (_) {
    return false;
  }
}

module.exports = {
  getFetchInputUrl,
  isProtectedSameOriginApi,
};
