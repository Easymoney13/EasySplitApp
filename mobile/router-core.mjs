export const ROUTE_PARAM = 'esRoute';
export const NAV_EVENT = 'easysplit:navigate';

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

export function normalizeInternalPath(input) {
  const raw = String(input || '/').trim();
  if (!raw || raw === '/') return { pathname: '/', searchParams: new URLSearchParams() };

  try {
    const parsed = new URL(raw, 'https://easysplit.invalid');
    const pathname = parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`;
    return {
      pathname: pathname || '/',
      searchParams: new URLSearchParams(parsed.search),
    };
  } catch (_) {
    return { pathname: '/', searchParams: new URLSearchParams() };
  }
}

export function routeFromSearch(search) {
  const params = new URLSearchParams(search || '');
  const route = params.get(ROUTE_PARAM) || '/';
  return normalizeInternalPath(route).pathname;
}

export function paramsFromRoute(route) {
  const normalized = normalizeInternalPath(route).pathname;
  const sessionMatch = normalized.match(/^\/session\/([^/]+)$/);
  if (sessionMatch) return { id: safeDecodeURIComponent(sessionMatch[1]) };
  const groupMatch = normalized.match(/^\/group\/([^/]+)$/);
  if (groupMatch) return { id: safeDecodeURIComponent(groupMatch[1]) };
  return {};
}

export function buildShellSearch(path) {
  const { pathname, searchParams: routeParams } = normalizeInternalPath(path);
  const next = new URLSearchParams();
  next.set(ROUTE_PARAM, pathname);
  for (const [key, value] of routeParams.entries()) {
    if (key !== ROUTE_PARAM) next.append(key, value);
  }

  return `?${next.toString()}`;
}

export function hasManagedDepth(state) {
  const value = Number(state?.esDepth);
  return Number.isInteger(value) && value >= 0;
}

export function currentDepth(state) {
  if (!hasManagedDepth(state)) return 0;
  return Number(state.esDepth);
}

export function pushShellRoute(browserWindow, path) {
  const depth = currentDepth(browserWindow.history.state) + 1;
  const search = buildShellSearch(path);
  browserWindow.history.pushState(
    { ...(browserWindow.history.state || {}), esDepth: depth },
    '',
    `${browserWindow.location.pathname}${search}`,
  );
  browserWindow.dispatchEvent(new Event(NAV_EVENT));
}

export function initialHistoryPlan(search, state) {
  if (hasManagedDepth(state)) {
    return { seedHome: false, depth: currentDepth(state) };
  }
  const route = routeFromSearch(search);
  return {
    seedHome: route !== '/',
    depth: route === '/' ? 0 : 1,
  };
}


export function backAction(search, state) {
  if (currentDepth(state) > 0) return 'history-back';
  if (routeFromSearch(search) !== '/') return 'home';
  return 'exit';
}
