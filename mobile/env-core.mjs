const HTTP_KEYS = [
  'NEXT_PUBLIC_EASYSPLIT_API_ORIGIN',
  'NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN',
];

function assertOrigin(value, key, protocols) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`${key} is required for the mobile bundle`);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error(`${key} must be an absolute origin`);
  }

  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${key} must use ${protocols.map((p) => p.replace(':', '')).join(' or ')}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error(`${key} must be an origin only (no path, query, credentials, or fragment)`);
  }
  return parsed.origin;
}

export function validateMobileEnv(env) {
  for (const key of HTTP_KEYS) {
    assertOrigin(env[key], key, ['http:', 'https:']);
  }

  const ws = String(env.NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN || '').trim();
  if (ws) assertOrigin(ws, 'NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN', ['ws:', 'wss:']);

  return true;
}
