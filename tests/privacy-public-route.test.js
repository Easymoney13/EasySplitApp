const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

function compile(relativePath, requireMock, globals = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText, { exports, require: requireMock, ...globals });
  return exports;
}

// Render the actual global provider in its hydrated, incomplete-profile state.
// Effects are excluded so the fixture cannot initiate real authentication or I/O.
function providerHarness(usePathname, signedIn = false) {
  let stateIndex = 0;
  const hooks = {
    ...React,
    useEffect: () => {},
    useState: (initial) => {
      const index = stateIndex++;
      const value = index === 3 ? true // Local state initialized.
        : index === 4 ? false // Firebase hydration finished.
          : index === 7 ? (signedIn ? { uid: 'new-account', providerData: [{ providerId: 'google.com' }] } : null)
            : typeof initial === 'function' ? initial() : initial;
      return [value, () => {}];
    },
  };
  const module = compile('src/components/LanguageContext.tsx', (name) => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return require(name);
    if (name === 'next/navigation') return { usePathname };
    if (name === '@capacitor/core') return { Capacitor: { getPlatform: () => 'ios' } };
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
    if (name === '../../lib/i18n') return { en: {}, he: {} };
    if (name === '../../lib/bitDeepLink') return { isValidIsraeliPhone: () => false };
    return {};
  });
  return () => {
    stateIndex = 0;
    return module.LanguageProvider({ children: React.createElement('article', { id: 'public-policy' }, 'Privacy policy') });
  };
}

function elements(element) {
  if (!element || typeof element !== 'object') return [];
  const children = Array.isArray(element.props?.children) ? element.props.children : [element.props?.children];
  return [element, ...children.flatMap((child) => Array.isArray(child) ? child.flatMap(elements) : elements(child))];
}

function assertPolicyUnblocked(element) {
  const tree = elements(element);
  assert.ok(tree.some((node) => node.props?.id === 'public-policy'));
  assert.equal(tree.filter((node) => node.props?.role === 'dialog').length, 0);
}

for (const signedIn of [false, true]) {
  test(`web /privacy remains unblocked for an incomplete ${signedIn ? 'signed-in' : 'guest'} profile, while home still requires completion`, () => {
    let pathname = '/privacy';
    const render = providerHarness(() => pathname, signedIn);
    assertPolicyUnblocked(render());
    pathname = '/';
    assert.equal(elements(render()).filter((node) => node.props?.role === 'dialog').length, 1);
  });
}

for (const signedIn of [false, true]) {
test(`native direct privacy entry and route changes update the ${signedIn ? 'signed-in' : 'guest'} onboarding exemption`, async () => {
  const core = await import('../mobile/router-core.mjs');
  const browser = new EventTarget();
  browser.location = { pathname: '/index.html', search: '?esRoute=%2Fprivacy' };
  browser.history = {
    state: { esDepth: 0 },
    pushState(state, title, url) {
      this.state = state;
      const parsed = new URL(url, 'https://easysplit.invalid');
      browser.location.search = parsed.search;
    },
  };
  let storedPath;
  const cleanups = [];
  const shim = compile('mobile/shims/next-navigation.ts', (name) => {
    if (name === '../router-core.mjs') return core;
    if (name === 'react') return {
      useMemo: (factory) => factory(),
      useState: (initial) => {
        if (storedPath === undefined) storedPath = initial();
        return [storedPath, (value) => { storedPath = value; }];
      },
      useEffect: (callback) => { cleanups.push(callback()); },
    };
    throw new Error(`Unexpected shim import ${name}`);
  }, { window: browser, Event });
  const render = providerHarness(shim.usePathname, signedIn);
  assertPolicyUnblocked(render());

  shim.useRouter().push('/');
  assert.equal(elements(render()).filter((node) => node.props?.role === 'dialog').length, 1);
  shim.useRouter().push('/privacy');
  assertPolicyUnblocked(render());

  browser.location.search = '?esRoute=%2F';
  browser.dispatchEvent(new Event('popstate'));
  assert.equal(elements(render()).filter((node) => node.props?.role === 'dialog').length, 1);
  browser.location.search = '?esRoute=%2Fprivacy';
  browser.dispatchEvent(new Event('popstate'));
  assertPolicyUnblocked(render());
  cleanups.forEach((cleanup) => cleanup?.());
});
}
