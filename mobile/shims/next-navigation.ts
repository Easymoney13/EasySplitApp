import { useMemo } from 'react';
import {
  NAV_EVENT,
  buildShellSearch,
  currentDepth,
  paramsFromRoute,
  routeFromSearch,
} from '../router-core.mjs';

function notifyNavigation() {
  window.dispatchEvent(new Event(NAV_EVENT));
}

function push(path: string) {
  const depth = currentDepth(window.history.state) + 1;
  const search = buildShellSearch(path);
  window.history.pushState({ ...(window.history.state || {}), esDepth: depth }, '', `${window.location.pathname}${search}`);
  notifyNavigation();
}

function replace(path: string) {
  const depth = currentDepth(window.history.state);
  const search = buildShellSearch(path);
  window.history.replaceState({ ...(window.history.state || {}), esDepth: depth }, '', `${window.location.pathname}${search}`);
  notifyNavigation();
}

export function useRouter() {
  return useMemo(() => ({
    push,
    replace,
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => window.dispatchEvent(new Event('easysplit:mobile-refresh')),
    prefetch: async () => undefined,
  }), []);
}

export function useParams() {
  return paramsFromRoute(routeFromSearch(window.location.search));
}
