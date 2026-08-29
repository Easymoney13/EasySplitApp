const ROUTABLE_PATH = /^\/(session|group)\/[^/]+$/;

function normalizedRouteParts(input) {
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
    pathname,
    routeSearch,
    invite,
  };
}

export function incomingRouteFromUrl(input) {
  const target = normalizedRouteParts(input);
  if (!target) return null;
  return {
    path: `${target.pathname}${target.routeSearch ? `?${target.routeSearch}` : ''}`,
    hash: target.invite ? `#invite=${encodeURIComponent(target.invite)}` : '',
  };
}

export function nativeInviteUrlFromWeb(input) {
  let parsed;
  try {
    parsed = new URL(String(input || ''));
  } catch (_) {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';

  const target = normalizedRouteParts(parsed.href);
  if (!target) return '';
  const route = target.pathname.replace(/^\//, '');
  const search = target.routeSearch ? `?${target.routeSearch}` : '';
  const hash = target.invite ? `#invite=${encodeURIComponent(target.invite)}` : '';
  return `easysplit://${route}${search}${hash}`;
}
