import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');

test('Capacitor production config stays bundled and keeps the existing Android back handler enabled', async () => {
  const config = await read('capacitor.config.ts');
  const runtime = await read('mobile/runtime/mobileRuntime.ts');
  assert.ok(!/server\s*:\s*\{[^}]*url\s*:/s.test(config));
  assert.ok(!config.includes('disableBackButtonHandler: true'));
  assert.match(runtime, /App\.addListener\(['"]backButton['"]/);
  assert.match(config, /insetsHandling:\s*'css'/);
  assert.match(config, /webDir:\s*'mobile-dist'/);
});

test('mobile shell consumes Capacitor safe-area variables without changing web CSS', async () => {
  const css = await read('mobile/mobile.css');
  const main = await read('mobile/main.tsx');
  assert.match(css, /--safe-area-inset-bottom/);
  assert.match(main, /easysplit-mobile/);
});

test('Vite mobile build validates remote origins and converts shared local CommonJS', async () => {
  const config = await read('vite.mobile.config.ts');
  assert.match(config, /validateMobileEnv\(env\)/);
  assert.match(config, /fs:\s*\{\s*allow:\s*\[repoRoot\]/s);
  assert.match(config, /commonjsOptions/);
  assert.match(config, /\/lib\//);
});

test('mobile runtime uses a neutral shared recovery event', async () => {
  const runtime = await read('mobile/runtime/mobileRuntime.ts');
  const eventModule = await read('lib/mobileEvents.ts');
  assert.match(runtime, /from '\.\.\/\.\.\/lib\/mobileEvents'/);
  assert.match(eventModule, /easysplit:runtime-recover/);
});
