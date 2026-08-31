const DIAGNOSTIC_SNIPPET = (stage, details = '') =>
  `(() => {
    const entry = { stage: '${stage}', at: Date.now()${details} };
    const previous = globalThis.__EASYSPLIT_GATE4_AUTH_DIAGNOSTICS__;
    globalThis.__EASYSPLIT_GATE4_AUTH_DIAGNOSTICS__ = {
      ...entry,
      history: [...(previous?.history || []), entry].slice(-20),
    };
  })();`;

function replaceOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor);
  if (first < 0) throw new Error(`Gate 4 auth instrumentation anchor is missing: ${label}`);
  if (source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`Gate 4 auth instrumentation anchor is ambiguous: ${label}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + anchor.length)}`;
}

export function instrumentGate4AuthSource(source, id) {
  const normalized = id.replaceAll('\\', '/').split('?')[0];
  if (normalized.endsWith('/lib/firebase.ts')) {
    let transformed = replaceOnce(
      source,
      'const auth = getAuth(app);',
      `const auth = getAuth(app);\n${DIAGNOSTIC_SNIPPET('AUTH_CREATED')}`,
      'Firebase auth creation',
    );
    transformed = replaceOnce(
      transformed,
      '  if (!authPersistencePromise) {\n    authPersistencePromise = setPersistence(auth, browserLocalPersistence).catch((error) => {',
      `  if (!authPersistencePromise) {\n    ${DIAGNOSTIC_SNIPPET('PERSISTENCE_STARTED')}\n    authPersistencePromise = setPersistence(auth, browserLocalPersistence).catch((error) => {`,
      'persistence start',
    );
    transformed = replaceOnce(
      transformed,
      "      console.warn('Durable Firebase auth persistence is unavailable:', error);\n    });\n  }",
      `      console.warn('Durable Firebase auth persistence is unavailable:', error);\n    });\n    void authPersistencePromise.then(() => {\n      ${DIAGNOSTIC_SNIPPET('PERSISTENCE_COMPLETED')}\n    });\n  }`,
      'persistence completion',
    );
    return { code: transformed, map: null };
  }

  if (normalized.endsWith('/src/components/LanguageContext.tsx')) {
    let transformed = replaceOnce(
      source,
      "        const { auth, ensureAuthPersistence } = await import('../../lib/firebase');",
      `        const { auth, ensureAuthPersistence } = await import('../../lib/firebase');\n        ${DIAGNOSTIC_SNIPPET('MODULE_IMPORTED')}`,
      'LanguageContext Firebase import',
    );
    transformed = replaceOnce(
      transformed,
      "        const { onAuthStateChanged } = await import('firebase/auth');\n\n        onAuthStateChanged(auth, async (user) => {",
      `        const { onAuthStateChanged } = await import('firebase/auth');\n        ${DIAGNOSTIC_SNIPPET('LISTENER_REGISTERED')}\n\n        onAuthStateChanged(auth, async (user) => {\n          ${DIAGNOSTIC_SNIPPET('CALLBACK_FIRED', ", user: user?.uid ? 'authenticated' : 'guest'")}`,
      'auth listener registration',
    );
    transformed = replaceOnce(
      transformed,
      "        console.error('Failed to initialize Firebase Auth listener:', e);",
      `${DIAGNOSTIC_SNIPPET('AUTH_ERROR', ", error: e instanceof Error ? e.message : String(e)")}\n        console.error('Failed to initialize Firebase Auth listener:', e);`,
      'auth initialization failure',
    );
    return { code: transformed, map: null };
  }

  return null;
}

export function gate4AuthInstrumentationPlugin() {
  return {
    name: 'easysplit-gate4-auth-diagnostics',
    enforce: 'pre',
    transform: instrumentGate4AuthSource,
  };
}
