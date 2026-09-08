import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../lib/firebase.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function initializeClient(env, native) {
  let config;
  let authMode;
  const app = {};
  class GoogleAuthProvider { setCustomParameters() {} }
  runInNewContext(compiled, {
    exports: {},
    process: { env },
    // Deliberately no atob or Buffer: client config needs no runtime decoder.
    require(name) {
      if (name === '@capacitor/core') return { Capacitor: { isNativePlatform: () => native } };
      if (name === 'firebase/app') return {
        getApps: () => [],
        getApp: () => app,
        initializeApp(value) { config = value; return app; },
      };
      if (name === 'firebase/auth') return {
        GoogleAuthProvider,
        browserLocalPersistence: 'browser-local',
        getAuth() { authMode = 'web'; return {}; },
        initializeAuth(_app, options) {
          assert.equal(options.persistence, 'browser-local');
          authMode = 'native';
          return {};
        },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { config, authMode };
}

test('Firebase keeps the deployed public key when build-time env is absent or empty on web and native', () => {
  for (const native of [false, true]) {
    for (const env of [{}, { NEXT_PUBLIC_FIREBASE_API_KEY: '' }]) {
      const { config, authMode } = initializeClient(env, native);
      assert.equal(createHash('sha256').update(config.apiKey).digest('hex'),
        'c8268956d522b67a807bcbd5174974c942f856445b6d3d84e7fa36ab85dbd90f');
      assert.equal(config.projectId, 'easysplit-24576');
      assert.equal(authMode, native ? 'native' : 'web');
    }
  }
});

test('explicit Firebase client configuration takes precedence over deployed defaults', () => {
  for (const native of [false, true]) {
    const { config } = initializeClient({
      NEXT_PUBLIC_FIREBASE_API_KEY: 'mock-public-client-key',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'mock-project',
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'mock-project.firebaseapp.com',
    }, native);
    assert.equal(config.apiKey, 'mock-public-client-key');
    assert.equal(config.projectId, 'mock-project');
    assert.equal(config.authDomain, 'mock-project.firebaseapp.com');
  }
});
