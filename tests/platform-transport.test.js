const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE = require.resolve('../lib/platformTransport');

function loadWithEnv(env = {}, windowValue) {
  const oldApi = process.env.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN;
  const oldWs = process.env.NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN;
  const oldWeb = process.env.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN;
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const oldWindow = global.window;

  if ('api' in env) process.env.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN = env.api;
  else delete process.env.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN;
  if ('ws' in env) process.env.NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN = env.ws;
  else delete process.env.NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN;
  if ('web' in env) process.env.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN = env.web;
  else delete process.env.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN;
  if (windowValue === undefined) delete global.window;
  else global.window = windowValue;
  delete require.cache[MODULE];
  const mod = require(MODULE);

  return {
    mod,
    restore() {
      if (oldApi === undefined) delete process.env.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN;
      else process.env.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN = oldApi;
      if (oldWs === undefined) delete process.env.NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN;
      else process.env.NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN = oldWs;
      if (oldWeb === undefined) delete process.env.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN;
      else process.env.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN = oldWeb;
      if (hadWindow) global.window = oldWindow;
      else delete global.window;
      delete require.cache[MODULE];
    },
  };
}

test('web parity: API paths remain relative when no backend origin is configured', () => {
  const { mod, restore } = loadWithEnv({}, { location: { origin: 'https://web.easysplit.test', protocol: 'https:', host: 'web.easysplit.test' } });
  try {
    assert.equal(mod.apiUrl('/api/session/abc'), '/api/session/abc');
    assert.equal(mod.getApiOrigin(), 'https://web.easysplit.test');
    assert.equal(mod.realtimeUrl(), 'wss://web.easysplit.test');
    assert.equal(mod.publicWebUrl('/session/abc'), 'https://web.easysplit.test/session/abc');
  } finally { restore(); }
});

test('native configuration sends API and realtime to the remote EasySplit backend', () => {
  const { mod, restore } = loadWithEnv(
    { api: 'https://api.easysplit.test/' },
    { location: { origin: 'capacitor://localhost', protocol: 'capacitor:', host: 'localhost' } },
  );
  try {
    assert.equal(mod.apiUrl('/api/session/abc'), 'https://api.easysplit.test/api/session/abc');
    assert.equal(mod.getApiOrigin(), 'https://api.easysplit.test');
    assert.equal(mod.realtimeUrl(), 'wss://api.easysplit.test');
  } finally { restore(); }
});

test('explicit websocket origin overrides derived realtime origin', () => {
  const { mod, restore } = loadWithEnv({ api: 'https://api.easysplit.test', ws: 'wss://realtime.easysplit.test/' });
  try { assert.equal(mod.realtimeUrl(), 'wss://realtime.easysplit.test'); }
  finally { restore(); }
});

test('absolute http API URLs pass through unchanged', () => {
  const { mod, restore } = loadWithEnv({ api: 'https://api.easysplit.test' });
  try { assert.equal(mod.apiUrl('https://other.example/path'), 'https://other.example/path'); }
  finally { restore(); }
});

test('misconfigured public origins fail closed instead of silently targeting the WebView', () => {
  const first = loadWithEnv({ api: 'api.easysplit.test' });
  try { assert.throws(() => first.mod.apiUrl('/api/test'), /absolute http\(s\) origin/); }
  finally { first.restore(); }

  const second = loadWithEnv({ api: 'https://api.easysplit.test/base' });
  try { assert.throws(() => second.mod.apiUrl('/api/test'), /origin only/); }
  finally { second.restore(); }
});

test('native share URLs use the public web origin instead of the local WebView origin', () => {
  const { mod, restore } = loadWithEnv(
    { api: 'https://api.easysplit.test', web: 'https://easysplit.test' },
    { location: { origin: 'https://localhost', protocol: 'https:', host: 'localhost' } },
  );
  try {
    assert.equal(mod.hasConfiguredApiOrigin(), true);
    assert.equal(mod.publicWebUrl('/session/abc'), 'https://easysplit.test/session/abc');
  } finally { restore(); }
});

test('unsafe schemes and origin-like URLs containing paths are rejected', () => {
  const badScheme = loadWithEnv({ api: 'javascript:alert(1)' });
  try { assert.throws(() => badScheme.mod.apiUrl('/api/test'), /absolute http\(s\) origin|must use http/); }
  finally { badScheme.restore(); }

  const badWs = loadWithEnv({ ws: 'https://realtime.easysplit.test' });
  try { assert.throws(() => badWs.mod.realtimeUrl(), /must use ws or wss/); }
  finally { badWs.restore(); }
});
