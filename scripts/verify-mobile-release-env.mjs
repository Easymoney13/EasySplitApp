const required = [
  ['NEXT_PUBLIC_EASYSPLIT_API_ORIGIN', 'https:', 'https://billspltapp.onrender.com'],
  ['NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN', 'https:', 'https://billspltapp.onrender.com'],
  ['NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN', 'wss:', 'wss://billspltapp.onrender.com'],
];

function verifyOrigin(key, protocol, expectedOrigin) {
  const raw = String(process.env[key] || '').trim();
  if (!raw) throw new Error(`${key} is required for a store release`);
  const url = new URL(raw);
  if (url.protocol !== protocol) throw new Error(`${key} must use ${protocol.replace(':', '')}`);
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error(`${key} must be an origin only`);
  }
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.invalid')) {
    throw new Error(`${key} must point at a real production host`);
  }
  if (url.origin !== expectedOrigin) {
    throw new Error(`${key} must equal the reviewed EasySplit production origin: ${expectedOrigin}`);
  }
}

for (const [key, protocol, expectedOrigin] of required) verifyOrigin(key, protocol, expectedOrigin);
console.log('EasySplit store-release origins PASS');
