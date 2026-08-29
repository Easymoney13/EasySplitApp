const ROUTABLE_PATH = /^\/(session|group)\/[^/]+$/;

export function incomingRouteFromUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input || ''));
  } catch (_) {
    return null;
  }

  let pathname = parsed.pathname;
  if (parsed.protocol === 'easysplit:') {
    const hostSegment = parsed.hostname ? `/${parsed.hostname}` : '';
    pathname = `${hostSegment}${parsed.pathname}`;
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  pathname = pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (!ROUTABLE_PATH.test(pathname)) return null;

  const routeParams = new URLSearchParams(parsed.search);
  routeParams.delete('esRoute');
  const routeSearch = routeParams.toString();
  const isSession = pathname.startsWith('/session/');
  const invite = isSession ? new URLSearchParams(parsed.hash.replace(/^#/, '')).get('invite') : null;

  return {
    path: `${pathname}${routeSearch ? `?${routeSearch}` : ''}`,
    hash: invite ? `#invite=${encodeURIComponent(invite)}` : '',
  };
}
