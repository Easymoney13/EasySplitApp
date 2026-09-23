const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const accountIsolation = require('../lib/accountIsolation');

// Run the real provider deletion handler with effects disabled. Only transport,
// Firebase and browser integrations are replaced; storage cleanup is real.
function deletionHarness(responses) {
  const state = [];
  let cursor = 0;
  let signOuts = 0;
  let consentRevocations = 0;
  const calls = [];
  const user = { uid: 'deleted-user', providerData: [{ providerId: 'google.com' }] };
  const profile = { displayName: 'Delete me', phoneNumber: '0501234567', avatarColor: '#4DE1A1' };
  const values = new Map([
    ['billsplit_local_profile', JSON.stringify(profile)],
    ['billsplit_phone', profile.phoneNumber],
    ['billsplit_account_scope', 'user:deleted-user'],
    ['billsplit_session_token_room', 'private-room-token'],
  ]);
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  const hooks = {
    ...React,
    useEffect: () => {},
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = index === 3 ? true : index === 4 ? false
        : index === 7 ? user : index === 11 ? profile
          : typeof initial === 'function' ? initial() : initial;
      return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/components/LanguageContext.tsx'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  const location = { href: '/settings' };
  vm.runInNewContext(compiled, {
    exports, window: { location }, localStorage: storage, sessionStorage: storage,
    console: { error() {} },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error('Unexpected request');
      return { ok: response.status === 200, status: response.status, json: async () => response.body };
    },
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return require(name);
      if (name === 'next/navigation') return { usePathname: () => '/', useRouter: () => ({}) };
      if (name === '@capacitor/core') return { Capacitor: { getPlatform: () => 'web' } };
      if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (name.endsWith('/bitDeepLink')) return { isValidIsraeliPhone: () => true };
      if (name.endsWith('/platformTransport')) return { apiUrl: url => url };
      if (name.endsWith('/accountIsolation')) return accountIsolation;
      if (name.endsWith('/creatorIntent')) return { clearCreatorIntent() {} };
      if (name.endsWith('/cookies')) return { removeCookie() {} };
      if (name.endsWith('/nativeGoogleAuth')) return { isNativeGoogleAuthPlatform: () => false };
      if (name.endsWith('/receiptPrivacyConsent')) return { receiptConsent: { revoke: () => { consentRevocations += 1; } } };
      if (name === '../../lib/firebase') return { auth: {} };
      if (name === 'firebase/auth') return { signOut: async () => { signOuts += 1; } };
      return {};
    },
  });
  return {
    render() { cursor = 0; return exports.LanguageProvider({ children: null }).props.value; },
    storage, calls, location,
    get signOuts() { return signOuts; },
    get consentRevocations() { return consentRevocations; },
  };
}

test('retrying a lost deletion response accepts server-proven completion and clears local account state', async () => {
  const app = deletionHarness([
    new TypeError('Connection reset after the server committed deletion'),
    { status: 200, body: { success: true, deleted: false, anonymizedRecords: 0, deletedVisits: 0 } },
  ]);
  assert.equal(await app.render().deleteAccount(), false);
  assert.equal(app.render().firebaseUser.uid, 'deleted-user');
  assert.equal(app.signOuts, 0);
  assert.equal(await app.render().deleteAccount(), true);
  assert.equal(app.render().firebaseUser, null);
  assert.equal(app.render().profile.displayName, '');
  assert.equal(app.storage.length, 0);
  assert.equal(app.signOuts, 1);
  assert.equal(app.consentRevocations, 1);
  assert.equal(app.location.href, '/');
  assert.equal(app.calls.length, 2);
  assert.ok(app.calls.every(call => call.url === '/api/user/account' && call.options.method === 'DELETE'));
});

test('an arbitrary unauthorized deletion response is never treated as successful deletion', async () => {
  const app = deletionHarness([{ status: 401, body: { error: 'Unauthorized: Invalid or expired token' } }]);
  assert.equal(await app.render().deleteAccount(), false);
  assert.equal(app.render().firebaseUser.uid, 'deleted-user');
  assert.equal(app.render().profile.displayName, 'Delete me');
  assert.equal(app.storage.getItem('billsplit_phone'), '0501234567');
  assert.equal(app.signOuts, 0);
  assert.equal(app.consentRevocations, 0);
  assert.equal(app.location.href, '/settings');
});
