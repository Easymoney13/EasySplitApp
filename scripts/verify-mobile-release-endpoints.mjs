import WebSocket from 'ws';

const production = {
  api: 'https://billspltapp.onrender.com',
  web: 'https://billspltapp.onrender.com',
  ws: 'wss://billspltapp.onrender.com',
};

const configured = {
  api: String(process.env.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN || '').trim(),
  web: String(process.env.NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN || '').trim(),
  ws: String(process.env.NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN || '').trim(),
};

for (const key of Object.keys(production)) {
  if (configured[key] !== production[key]) {
    throw new Error(`Release endpoint probe requires reviewed ${key} origin: ${production[key]}`);
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function withRetries(label, operation) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 1500);
    }
  }
  throw new Error(`${label} failed after 3 attempts: ${lastError?.message || lastError}`);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
await withRetries('public web endpoint', async () => {
  const response = await fetchWithTimeout(production.web, { redirect: 'follow' });
  if (!response.ok) throw new Error(`expected HTTP 2xx, received ${response.status}`);
});

async function verifyCors(origin) {
  await withRetries(`CORS preflight for ${origin}`, async () => {
    const response = await fetchWithTimeout(`${production.api}/api/user/groups`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    if (response.status !== 204) throw new Error(`expected HTTP 204, received ${response.status}`);
    const allowedOrigin = response.headers.get('access-control-allow-origin');
    if (allowedOrigin !== origin) throw new Error(`allow-origin was ${allowedOrigin || 'missing'}`);
    const allowedMethods = response.headers.get('access-control-allow-methods') || '';
    if (!allowedMethods.split(',').map((value) => value.trim().toUpperCase()).includes('GET')) {
      throw new Error(`GET is absent from allow-methods: ${allowedMethods || 'missing'}`);
    }
    const allowedHeaders = (response.headers.get('access-control-allow-headers') || '')
      .split(',').map((value) => value.trim().toLowerCase());
    for (const requiredHeader of ['authorization', 'content-type']) {
      if (!allowedHeaders.includes(requiredHeader)) {
        throw new Error(`${requiredHeader} is absent from allow-headers`);
      }
    }
  });
}

await verifyCors('capacitor://localhost');
await verifyCors('https://localhost');
await withRetries('authenticated API boundary', async () => {
  const response = await fetchWithTimeout(`${production.api}/api/user/groups`, {
    headers: { Origin: 'capacitor://localhost' },
  });
  if (response.status !== 401) throw new Error(`expected HTTP 401, received ${response.status}`);
  if (response.headers.get('access-control-allow-origin') !== 'capacitor://localhost') {
    throw new Error('authenticated API response is missing the iOS Capacitor CORS origin');
  }
});

await withRetries('production WebSocket handshake', () => new Promise((resolve, reject) => {
  const socket = new WebSocket(production.ws, { origin: 'capacitor://localhost' });
  let settled = false;
  let timer;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.removeAllListeners();
    socket.terminate();
    if (error) reject(error);
    else resolve();
  };
  timer = setTimeout(() => finish(new Error('WebSocket handshake timed out')), 30_000);
  socket.once('open', () => finish());
  socket.once('error', (error) => finish(error));
}));

console.log(JSON.stringify({
  releaseEndpoints: 'PASS',
  corsOrigins: ['capacitor://localhost', 'https://localhost'],
  authBoundary: 401,
  websocket: 'open',
}, null, 2));
