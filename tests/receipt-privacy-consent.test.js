const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const {
  createReceiptConsentManager,
  isReceiptCloudConsentDeclined,
  isValidReceiptCloudConsent,
  RECEIPT_CLOUD_CONSENT_KEY,
  RECEIPT_CLOUD_CONSENT_VERSION,
} = require('../lib/receiptPrivacyConsent');

function storage() {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key) || null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}

function setupManager(options = {}) {
  const saved = storage();
  const manager = createReceiptConsentManager({ getStorage: () => saved, ...options });
  return { manager, saved };
}

function scanHarness(manager, { prepare, fetchResponse } = {}) {
  const calls = { prepare: 0, fetch: [], fallback: 0 };
  const source = fs.readFileSync(path.join(__dirname, '../lib/receiptScanClient.ts'), 'utf8');
  const exports = {};
  const context = {
    exports,
    require: (moduleName) => {
      if (moduleName === './receiptPrivacyConsent') return {
        ...require('../lib/receiptPrivacyConsent'), receiptConsent: manager,
      };
      if (moduleName === './imageUtils') return { prepareReceiptImages: async () => {
        calls.prepare += 1;
        await prepare?.();
        return { images: ['private-receipt-image'], fallbackImages: ['local-image'], mimeType: 'image/jpeg', quality: {} };
      } };
      if (moduleName === './ocrScanner') return { scanBillImagesInBrowser: async () => {
        calls.fallback += 1; return { items: [{ name: 'Local item', price: 10 }] };
      } };
      if (moduleName === './platformTransport') return { apiUrl: (value) => value };
      throw new Error(`Unexpected import: ${moduleName}`);
    },
    fetch: async (url, options) => {
      calls.fetch.push({ url, body: JSON.parse(options.body) });
      return fetchResponse || { ok: true, status: 200, json: async () => ({ success: true, receipt: { items: [{ name: 'Item', price: 10 }] } }) };
    },
    AbortController, setTimeout, clearTimeout,
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { createReceiptDraft: exports.createReceiptDraft, calls };
}

test('a declined consent starts no preparation, image upload, or fallback OCR', async () => {
  const { manager } = setupManager();
  manager.registerPrompt(async () => 'manual');
  const { createReceiptDraft, calls } = scanHarness(manager);
  await assert.rejects(createReceiptDraft('photo'), (error) => isReceiptCloudConsentDeclined(error) && error.manualEntry === true);
  assert.deepEqual(calls, { prepare: 0, fetch: [], fallback: 0 });
  assert.equal(manager.current(), null);
});

test('pending consent sends nothing, explicit acceptance enables a versioned upload', async () => {
  const { manager } = setupManager();
  let decide;
  manager.registerPrompt(() => new Promise((resolve) => { decide = resolve; }));
  const { createReceiptDraft, calls } = scanHarness(manager);
  const result = createReceiptDraft('photo');
  await Promise.resolve();
  assert.deepEqual(calls, { prepare: 0, fetch: [], fallback: 0 });
  decide('accept');
  await result;
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, '/api/receipt/parse');
  assert.ok(isValidReceiptCloudConsent(calls.fetch[0].body.cloudReceiptConsent));
});

test('unchanged permission survives a reload; a changed disclosure asks again', async () => {
  const { manager, saved } = setupManager();
  let asks = 0;
  manager.registerPrompt(async () => { asks += 1; return 'accept'; });
  await manager.requireConsent();
  await manager.requireConsent();
  assert.equal(asks, 1);
  const reloaded = createReceiptConsentManager({ getStorage: () => saved });
  assert.ok(await reloaded.requireConsent());
  const updated = createReceiptConsentManager({ getStorage: () => saved, version: 'next-disclosure' });
  updated.registerPrompt(async () => { asks += 1; return 'cancel'; });
  await assert.rejects(updated.requireConsent(), isReceiptCloudConsentDeclined);
  assert.equal(asks, 2);
});

test('withdrawal removes permission, denies a queued upload and requires a new choice', async () => {
  const { manager, saved } = setupManager();
  manager.registerPrompt(async () => 'accept');
  const prior = await manager.requireConsent();
  manager.revoke();
  assert.equal(saved.getItem(RECEIPT_CLOUD_CONSENT_KEY), null);
  assert.throws(() => manager.assertCurrent(prior), isReceiptCloudConsentDeclined);
  manager.registerPrompt(async () => 'manual');
  await assert.rejects(manager.requireConsent(), isReceiptCloudConsentDeclined);
});

test('revocation during image preparation prevents upload and fallback', async () => {
  const { manager } = setupManager();
  manager.registerPrompt(async () => 'accept');
  const { createReceiptDraft, calls } = scanHarness(manager, { prepare: () => manager.revoke() });
  await assert.rejects(createReceiptDraft('photo'), isReceiptCloudConsentDeclined);
  assert.equal(calls.prepare, 1);
  assert.deepEqual(calls.fetch, []);
  assert.equal(calls.fallback, 0);
});

test('an auth reset while the dialog is open invalidates its pending answer', async () => {
  const { manager } = setupManager();
  let decide;
  manager.registerPrompt(() => new Promise((resolve) => { decide = resolve; }));
  const promise = manager.requireConsent();
  manager.revoke();
  decide('accept');
  await assert.rejects(promise, isReceiptCloudConsentDeclined);
  assert.equal(manager.current(), null);
});

test('simultaneous scans share a single consent question', async () => {
  const { manager } = setupManager();
  let decide;
  let asks = 0;
  manager.registerPrompt(() => { asks += 1; return new Promise((resolve) => { decide = resolve; }); });
  const first = manager.requireConsent();
  const second = manager.requireConsent();
  decide('accept');
  assert.deepEqual(await first, await second);
  assert.equal(asks, 1);
});

test('storage failure does not grant permission, but explicit permission works for this page', async () => {
  const manager = createReceiptConsentManager({ getStorage: () => { throw new Error('Storage blocked'); } });
  await assert.rejects(manager.requireConsent(), isReceiptCloudConsentDeclined);
  manager.registerPrompt(async () => 'accept');
  const consent = await manager.requireConsent();
  manager.assertCurrent(consent);
  manager.revoke();
  assert.equal(manager.current(), null);
  assert.throws(() => manager.assertCurrent(consent), isReceiptCloudConsentDeclined);
});

test('withdrawal is effective even when storage removal fails', async () => {
  const { manager, saved } = setupManager();
  manager.registerPrompt(async () => 'accept');
  await manager.requireConsent();
  saved.removeItem = () => { throw new Error('Read only'); };
  manager.revoke();
  assert.equal(manager.current(), null);
});

test('a server consent rejection never starts fallback OCR', async () => {
  const { manager } = setupManager();
  manager.registerPrompt(async () => 'accept');
  const { createReceiptDraft, calls } = scanHarness(manager, {
    fetchResponse: { ok: false, status: 428, json: async () => ({ error: 'Consent required' }) },
  });
  await assert.rejects(createReceiptDraft('photo'), (error) => error.code === 'RECEIPT_CLOUD_CONSENT_REQUIRED');
  assert.equal(calls.fallback, 0);
  assert.equal(manager.current(), null);
});

test('only explicit current-version consent records pass the shared server contract', () => {
  const valid = { accepted: true, version: RECEIPT_CLOUD_CONSENT_VERSION, acceptedAt: '2026-09-08T12:00:00.000Z' };
  assert.ok(isValidReceiptCloudConsent(valid));
  for (const invalid of [null, {}, true, { ...valid, accepted: 'true' }, { ...valid, acceptedAt: '' }, { ...valid, version: 'old' }]) {
    assert.equal(isValidReceiptCloudConsent(invalid), false);
  }
});

test('the open consent dialog consumes native Back before the underlying page and cancels its pending choice', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/ReceiptPrivacy.tsx'), 'utf8');
  const effects = [];
  const listeners = new Map();
  let stateIndex = 0;
  let prompt;
  const exports = {};
  const react = {
    ...require('react'),
    useState: () => [stateIndex++ === 0, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: (callback) => { effects.push(callback()); },
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText, {
    exports,
    require: (name) => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return require(name);
      if (name === 'next/navigation') return {};
      if (name === 'lucide-react') return { ShieldCheck: () => null, X: () => null };
      if (name === '../../lib/receiptPrivacyConsent') return { receiptConsent: {
        registerPrompt: (callback) => { prompt = callback; return () => {}; },
      } };
      if (name === '../../lib/mobileEvents') return { MOBILE_BACK_REQUEST_EVENT: 'native-back' };
      if (name === './LanguageContext') return { useLanguage: () => ({ language: 'en' }) };
      if (name === './PrivacyPolicyContent') return { PrivacyPolicyContent: () => null };
      throw new Error(`Unexpected import ${name}`);
    },
    window: {
      addEventListener: (name, callback, capture) => { listeners.set(name, { callback, capture }); },
      removeEventListener: (name) => listeners.delete(name),
    },
    document: { activeElement: null, addEventListener: () => {}, removeEventListener: () => {} },
  });
  exports.ReceiptPrivacyProvider({ children: null });
  const choice = prompt();
  const nativeBack = listeners.get('native-back');
  assert.equal(nativeBack.capture, true);
  const event = new Event('native-back', { cancelable: true });
  let stopped = false;
  event.stopImmediatePropagation = () => { stopped = true; };
  nativeBack.callback(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(stopped, true);
  assert.equal(await choice, 'cancel');
  for (const cleanup of effects) cleanup?.();
  assert.equal(listeners.has('native-back'), false);
});
