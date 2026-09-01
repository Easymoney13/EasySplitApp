import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMobileEnv } from './mobile/env-core.mjs';
import { gate4FixtureScript } from './mobile/gate4/fixture.mjs';
import { gate4AuthInstrumentationPlugin } from './mobile/gate4/auth-instrumentation.mjs';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

const PUBLIC_ENV_KEYS = [
  'NEXT_PUBLIC_EASYSPLIT_API_ORIGIN',
  'NEXT_PUBLIC_EASYSPLIT_WEB_ORIGIN',
  'NEXT_PUBLIC_EASYSPLIT_WS_ORIGIN',
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
  'NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID',
] as const;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  validateMobileEnv(env);
  const gate4NativeE2E = env.EASYSPLIT_GATE4_E2E === 'true';
  const gate4RunId = env.VITE_GATE4_RUN_ID || '';
  if (gate4NativeE2E && !gate4RunId) {
    throw new Error('VITE_GATE4_RUN_ID is required for a Gate 4 instrumented build');
  }
  const gate4Fixture = gate4NativeE2E ? gate4FixtureScript() : '';

  const define = Object.fromEntries(
    PUBLIC_ENV_KEYS.map((key) => [`process.env.${key}`, JSON.stringify(env[key] || '')]),
  );

  return {
    root: resolve(repoRoot, 'mobile'),
    publicDir: resolve(repoRoot, 'public'),
    envDir: repoRoot,
    base: './',
    plugins: [
      react(),
      ...(gate4NativeE2E ? [gate4AuthInstrumentationPlugin()] : []),
      ...(gate4NativeE2E ? [{
        name: 'easysplit-gate4-native-e2e',
        transformIndexHtml: {
          order: 'pre' as const,
          handler: () => [
            {
              tag: 'script',
              children: gate4Fixture,
              injectTo: 'head-pre' as const,
            },
            {
              tag: 'script',
              attrs: { type: 'module', src: '/gate4/nativeCoreFlow.ts' },
              injectTo: 'body' as const,
            },
          ],
        },
      }] : []),
    ],
    resolve: {
      alias: {
        'next/navigation': resolve(repoRoot, 'mobile/shims/next-navigation.ts'),
      },
    },
    server: {
      // Mobile sources intentionally import the existing application from the repo root.
      fs: { allow: [repoRoot] },
    },
    define,
    build: {
      outDir: resolve(repoRoot, 'mobile-dist'),
      emptyOutDir: true,
      target: ['ios16.4', 'chrome111'],
      // Keep source maps for instrumented Gate 4 diagnostics only. Clean/store
      // builds must not ship repository source maps inside the native bundle.
      sourcemap: gate4NativeE2E,
      // The shared EasySplit client imports a small set of repository-owned CommonJS
      // modules. Include lib/ explicitly so Rollup converts them consistently.
      commonjsOptions: {
        include: [/node_modules/, /lib/],
      },
    },
  };
});
