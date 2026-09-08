const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const receiptMath = require('../lib/receiptMath');
const debtMath = require('../lib/debtMinimizer');

const root = path.join(__dirname, '..');
const compiledModules = new Map();

function compiled(file, exposeInner = false) {
  const key = `${file}:${exposeInner}`;
  if (!compiledModules.has(key)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
      + (exposeInner ? '\nexport { SessionWorkspaceInner as TestSubject };\n' : '');
    compiledModules.set(key, ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText);
  }
  return compiledModules.get(key);
}

function requestModule(fetch, timers = { setTimeout, clearTimeout }) {
  const module = { exports: {} };
  vm.runInNewContext(compiled('lib/sessionRequest.js'), {
    module, exports: module.exports, fetch, AbortController, Error, ...timers,
  }, { filename: 'lib/sessionRequest.js' });
  return module.exports;
}

// Execute the real components and their handlers. Hooks, navigation, storage,
// transport and native integrations are isolated; receipt calculations are real.
function componentHarness(file, options = {}) {
  const hooks = [];
  let cursor = 0;
  let effects = [];
  const listeners = new Map();
  const intervals = new Map();
  const timers = new Map();
  const log = [];
  let nextTimer = 1;
  const timerFns = {
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const profile = { displayName: 'Test Person', phoneNumber: '0501234567', ...options.profile };
  const ctx = {
    t: (key, _params, fallback) => fallback || key,
    currency: 'NIS', formatPrice: (amount) => `ILS ${amount.toFixed(2)}`,
    formatDual: (amount) => ({ primary: `ILS ${amount.toFixed(2)}` }),
    isRtl: false, profile, authLoading: false, theme: 'light', setTheme() {},
  };
  const router = { push() {}, replace() {} };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Component: class {}, Fragment: 'fragment', Suspense: 'suspense',
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: initial };
      return hooks[i];
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const previous = hooks[i];
      if (!previous || !deps || deps.length !== previous.deps?.length
          || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
        effects.push(() => {
          previous?.cleanup?.();
          hooks[i] = { deps, cleanup: fn() };
        });
      }
    },
    useMemo(fn) { cursor++; return fn(); },
  };
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (i) => [...values.keys()][i] ?? null,
    get length() { return values.size; },
  };
  const events = {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
  };
  const credentials = new Map();
  const fetch = options.fetch || (async () => { throw new Error('Unexpected fetch'); });
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, AbortController, URLSearchParams, Error,
    crypto: require('node:crypto').webcrypto, Date, Math,
    console: { error: (...args) => log.push(args.map(String).join(' ')), warn() {}, log() {} },
    window: {
      ...events, location: { search: '', hash: '#invite=test', reload() {} },
      localStorage: storage,
      confirm: options.confirm || (() => true),
    },
    document: { ...events, visibilityState: 'visible' },
    localStorage: storage, fetch, ...timerFns,
    setInterval(fn, delay) { const id = nextTimer++; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    alert: (message) => log.push(`ALERT:${message}`),
    require(name) {
      if (name === 'react') return React;
      if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => key === '__esModule' ? false : String(key) });
      if (name === 'next/navigation') return { useParams: () => ({ id: 'session_123' }), useRouter: () => router };
      if (name === 'canvas-confetti') return () => {};
      if (name.endsWith('LanguageContext')) return { useLanguage: () => ctx };
      if (name.endsWith('roomPolling')) return { createRoomPollPolicy: () => ({ begin: () => true, finish() {} }) };
      if (name.endsWith('cookies')) return { getCookie: () => null, setCookie() {} };
      if (name.endsWith('bitDeepLink')) return { cleanIsraeliPhone: (s) => s, isValidIsraeliPhone: () => true, triggerBitPayment() {} };
      if (name.endsWith('roomTokens')) return {
        roomHeaders: () => ({}),
        getRoomToken: (kind, id) => credentials.get(`${kind}:${id}`)?.token || '',
        getRoomMemberId: (kind, id) => credentials.get(`${kind}:${id}`)?.memberId || '',
        getOrCreateRoomClientId: () => 'client_1',
        saveRoomCredentials: (kind, id, memberId, token) => credentials.set(`${kind}:${id}`, { memberId, token }),
        getSessionInviteToken: () => '', saveSessionInviteToken() {},
        clearRoomCredentials() {}, clearSessionInviteToken() {},
      };
      if (name.endsWith('receiptMath')) return receiptMath;
      if (name.endsWith('debtMinimizer')) return debtMath;
      if (name.endsWith('sessionRequest')) return requestModule(fetch, timerFns);
      if (name.endsWith('accountClient')) return { fetchPaginatedAccountData: async () => [] };
      if (name.endsWith('platformTransport')) return { apiUrl: (s) => s, realtimeUrl: () => '' };
      if (name.endsWith('mobileEvents')) return { MOBILE_RECOVERY_EVENT: 'mobile-recovery' };
      if (name.endsWith('localLifecycle')) return { purgeDeletedSessionFromStorage() {} };
      if (name.endsWith('nativeActions')) return { openPayBoxPayment() {} };
      if (name.endsWith('haptics')) return { triggerHaptic() {} };
      if (name.endsWith('SkeletonLoader')) return { ReceiptSkeleton: 'ReceiptSkeleton' };
      if (name.endsWith('QRCodeModal')) return { QRCodeModal: 'QRCodeModal' };
      if (name.endsWith('AttachToGroupModal')) return { AttachToGroupModal: 'AttachToGroupModal' };
      if (name.endsWith('AnimatedRollingNumber')) return { AnimatedRollingNumber: 'AnimatedRollingNumber' };
      throw new Error(`Unmocked component dependency: ${name}`);
    },
  };
  vm.runInNewContext(compiled(file, options.session), context, { filename: file });
  const subject = options.session ? module.exports.TestSubject : module.exports.ManualBillModal;
  return {
    profile, log, intervals, timers,
    render(props) { cursor = 0; return subject(props); },
    flushEffects() { const pending = effects; effects = []; pending.forEach((fn) => fn()); },
    emit(name) { for (const callback of listeners.get(name) || []) callback(); },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

function flatten(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flatten).filter(Boolean).join(' ');
  return flatten(node.props?.children);
}

function walk(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (!Array.isArray(node) && predicate(node)) return node;
  for (const child of Array.isArray(node) ? node : node.props?.children || []) {
    const found = walk(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function byId(tree, id) { return walk(tree, (node) => node.props['data-testid'] === id); }
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(harness, props) {
  let tree;
  for (let i = 0; i < 3; i++) {
    tree = harness.render(props);
    harness.flushEffects();
    await tick();
  }
  return harness.render(props);
}

function modalReceipt(price, extra = {}) {
  const receipt = {
    storeName: 'Test receipt', currency: 'NIS',
    items: [{ id: 'meal', name: 'Meal', price }],
    receiptTotal: 118, tax: 18, service: 0, discount: 0, ...extra,
  };
  receipt.reconciliation = receiptMath.reconcileReceipt(receipt);
  return receipt;
}

test('receipt confirmation does not add included VAT a second time', async () => {
  const h = componentHarness('src/components/ManualBillModal.tsx');
  const tree = await settle(h, { isOpen: true, initialData: modalReceipt(118), onClose() {}, onLaunchSession() {} });
  assert.ok(flatten(tree).includes('Total Bill ILS 118.00'), flatten(tree));
  assert.equal(flatten(tree).includes('ILS 136.00'), false);
});

test('receipt confirmation retains tax added to an independently printed subtotal', async () => {
  const h = componentHarness('src/components/ManualBillModal.tsx');
  const tree = await settle(h, { isOpen: true, initialData: modalReceipt(100, { subtotal: 100 }), onClose() {}, onLaunchSession() {} });
  assert.ok(flatten(tree).includes('Total Bill ILS 118.00'), flatten(tree));
});

test('editing an OCR item recalculates confirmation rather than retaining stale reconciliation', async () => {
  const h = componentHarness('src/components/ManualBillModal.tsx');
  let submitted;
  const props = { isOpen: true, initialData: modalReceipt(118), onClose() {}, onLaunchSession(data) { submitted = data; } };
  let tree = await settle(h, props);
  const row = walk(tree, (node) => node.type === 'div' && typeof node.props.onClick === 'function' && flatten(node).includes('Meal'));
  assert.ok(row, 'the existing receipt item is editable');
  row.props.onClick();
  tree = h.render(props);
  const price = walk(tree, (node) => node.type === 'input' && node.props.type === 'number');
  price.props.onChange({ target: { value: '130' } });
  tree = h.render(props);
  assert.ok(flatten(tree).includes('Total Bill ILS 130.00'), flatten(tree));
  await walk(tree, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(submitted.items[0].price, 130);
  assert.equal(submitted.items[0].lineTotal, 130);
});

function activeSession(extra = {}) {
  return {
    id: 'session_123', status: 'active', storeName: 'Test', currency: 'NIS',
    members: [{ id: 'member_1', name: 'Test Person', isHost: true, settled: false }],
    items: [{ id: 'meal', name: 'Meal', price: 118, claimedBy: ['member_1'] }],
    ...extra,
  };
}

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => '' }, json: async () => data };
}

function successResponse(url, session = activeSession(), memberId = 'member_1') {
  return response(200, url.endsWith('/join')
    ? { session, memberId, accessToken: 'test-token' }
    : { session });
}

function sessionHarness(options) {
  return componentHarness('src/app/session/[id]/page.tsx', { ...options, session: true });
}

test('an initial network error exposes retry and a successful retry enters the room', async () => {
  const calls = [];
  const h = sessionHarness({ fetch: async (url) => {
    calls.push(url);
    if (calls.length === 1) throw new TypeError('Failed to fetch');
    return successResponse(url);
  } });
  let tree = await settle(h);
  assert.equal(!!walk(tree, (node) => node.type === 'ReceiptSkeleton'), false);
  assert.ok(flatten(tree).includes('Could not open session'), flatten(tree));
  const retry = byId(tree, 'session-load-retry');
  assert.ok(retry, 'network errors provide an actionable retry');
  retry.props.onClick();
  tree = await settle(h);
  assert.ok(flatten(tree).includes('Meal'), flatten(tree));
  assert.equal(byId(tree, 'session-load-retry'), undefined);
  assert.equal(calls.filter((url) => url.endsWith('/join')).length, 1);
  assert.equal(h.intervals.size, 1);
  h.unmount();
});

test('a refused invite leaves the skeleton and displays an actionable error', async () => {
  let calls = 0;
  const h = sessionHarness({ fetch: async (url) => {
    calls++;
    return url.endsWith('/join') ? response(403, { error: 'Session invite expired' }) : successResponse(url);
  } });
  const tree = await settle(h);
  assert.equal(!!walk(tree, (node) => node.type === 'ReceiptSkeleton'), false);
  assert.ok(flatten(tree).includes('Ask the host for a current link or code'), flatten(tree));
  assert.ok(byId(tree, 'session-load-retry'));
  assert.equal(h.intervals.size, 0);
  h.emit('online');
  h.emit('mobile-recovery');
  await settle(h);
  assert.equal(calls, 2, 'network recovery must not loop on a refused invitation');
  h.unmount();
});

test('a stalled first response leaves loading after its deadline and can be retried', async () => {
  let calls = 0;
  let signal;
  const h = sessionHarness({ fetch: async (url, options) => {
    calls++;
    if (calls !== 1) return successResponse(url);
    signal = options.signal;
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  } });
  await settle(h);
  const deadline = [...h.timers.values()].find((timer) => timer.delay === 15_000);
  assert.ok(deadline, 'initialization has a deadline until the body finishes');
  deadline.fn();
  let tree = await settle(h);
  assert.equal(signal.aborted, true);
  assert.equal(!!walk(tree, (node) => node.type === 'ReceiptSkeleton'), false);
  assert.ok(byId(tree, 'session-load-retry'));
  // Multiple recovery notifications arriving together must start one attempt.
  for (const event of ['online', 'mobile-recovery', 'focus', 'visibilitychange']) h.emit(event);
  tree = await settle(h);
  assert.ok(flatten(tree).includes('Meal'), flatten(tree));
  assert.equal(calls, 3);
  h.unmount();
});

test('a missing session retains its distinct not-found state', async () => {
  let calls = 0;
  const h = sessionHarness({ fetch: async () => { calls++; return response(404, { error: 'Not found' }); } });
  const tree = await settle(h);
  assert.ok(flatten(tree).includes('Session not found'), flatten(tree));
  assert.equal(byId(tree, 'session-load-retry'), undefined);
  assert.equal(!!walk(tree, (node) => node.type === 'ReceiptSkeleton'), false);
  assert.equal(calls, 1);
  h.unmount();
});

for (const recoveryEvent of ['online', 'mobile-recovery', 'focus', 'visibilitychange']) {
  test(`${recoveryEvent} recovers initialization after an initial network failure`, async () => {
    let calls = 0;
    const h = sessionHarness({ fetch: async (url) => {
      calls++;
      if (calls === 1) throw new TypeError('Offline');
      return successResponse(url);
    } });
    await settle(h);
    h.emit(recoveryEvent);
    const tree = await settle(h);
    assert.ok(flatten(tree).includes('Meal'), flatten(tree));
    assert.equal(byId(tree, 'session-load-retry'), undefined);
    assert.equal(calls, 3);
    h.unmount();
  });
}

test('overlapping initialization effects share one pending join request', async () => {
  let releaseJoin;
  let joins = 0;
  const joinReady = new Promise((resolve) => { releaseJoin = resolve; });
  const h = sessionHarness({ fetch: async (url) => {
    if (url.endsWith('/join')) { joins++; await joinReady; }
    return successResponse(url);
  } });
  h.render(); h.flushEffects(); await tick();
  assert.equal(joins, 1);
  // A profile/auth update reruns the real initialization effect while joining.
  h.profile.displayName = 'Updated Test Person';
  h.render(); h.flushEffects(); await tick();
  assert.equal(joins, 1);
  releaseJoin();
  const tree = await settle(h);
  assert.ok(flatten(tree).includes('Meal'), flatten(tree));
  assert.equal(joins, 1);
  assert.equal(h.intervals.size, 1);
  h.unmount();
});

test('session request deadline includes reading a stalled JSON body', async () => {
  let signal;
  const { requestSessionJson } = requestModule(async (_url, options) => {
    signal = options.signal;
    return {
      ok: true, status: 200,
      json: () => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason || new Error('Aborted')), { once: true });
      }),
    };
  });
  await assert.rejects(requestSessionJson('/test', {}, { timeoutMs: 10 }));
  assert.equal(signal.aborted, true, 'a body timeout cancels the transport, not just UI loading');
});

test('session request preserves HTTP status for refused invites', async () => {
  const { requestSessionJson } = requestModule(async () => response(403, { error: 'Session invite expired' }));
  await assert.rejects(requestSessionJson('/test'), (error) => error.status === 403);
});

test('host confirmation resolves the deleted member, preserving its target ID', async () => {
  const deleted = { id: 'deleted_2', name: 'Deleted member', deletedAccount: true, settled: false };
  const session = activeSession({ members: [...activeSession().members, deleted] });
  const actions = [];
  const confirmations = [];
  const h = sessionHarness({
    confirm: (message) => { confirmations.push(message); return true; },
    fetch: async (url, options) => {
      if (url === '/api/session/action') {
        actions.push(JSON.parse(options.body));
        return response(200, { session: { ...session, members: [session.members[0], { ...deleted, deletionResolution: { status: 'unconfirmed' } }] } });
      }
      return successResponse(url, session);
    },
  });
  let tree = await settle(h);
  const resolve = byId(tree, 'resolve-deleted-member-deleted_2');
  assert.ok(resolve, 'host sees a resolution action for an unfinished deleted member');
  await resolve.props.onClick();
  tree = await settle(h);
  assert.equal(confirmations.length, 1);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'RESOLVE_DELETED_MEMBER');
  assert.equal(actions[0].payload.memberId, 'deleted_2');
  assert.equal(byId(tree, 'resolve-deleted-member-deleted_2'), undefined);
  assert.ok(/unconfirmed/i.test(flatten(tree)), flatten(tree));
  h.unmount();
});

test('cancelling deleted-member resolution sends no action', async () => {
  let actions = 0;
  const session = activeSession({ members: [...activeSession().members,
    { id: 'deleted_2', name: 'Deleted member', deletedAccount: true, settled: false }] });
  const h = sessionHarness({ confirm: () => false, fetch: async (url) => {
    if (url === '/api/session/action') actions++;
    return successResponse(url, session);
  } });
  let tree = await settle(h);
  const resolve = byId(tree, 'resolve-deleted-member-deleted_2');
  assert.ok(resolve);
  await resolve.props.onClick();
  tree = await settle(h);
  assert.equal(actions, 0);
  assert.ok(byId(tree, 'resolve-deleted-member-deleted_2'));
  h.unmount();
});

test('regular participants cannot resolve deleted members from the UI', async () => {
  const session = activeSession({ members: [
    { id: 'host', name: 'Host', isHost: true },
    { id: 'member_1', name: 'Test Person', isHost: false },
    { id: 'deleted_2', name: 'Deleted member', deletedAccount: true, settled: false },
  ] });
  const h = sessionHarness({ fetch: async (url) => successResponse(url, session) });
  const tree = await settle(h);
  assert.equal(byId(tree, 'resolve-deleted-member-deleted_2'), undefined);
  h.unmount();
});

test('a session closed with an unconfirmed share does not claim all payment was settled', async () => {
  const session = activeSession({ status: 'settled', members: [
    { id: 'member_1', name: 'Test Person', isHost: true, settled: true },
    { id: 'deleted_2', name: 'Deleted member', deletedAccount: true, settled: false,
      deletionResolution: { status: 'unconfirmed' } },
  ] });
  const h = sessionHarness({ fetch: async (url) => successResponse(url, session) });
  const tree = await settle(h);
  assert.ok(flatten(tree).includes('Some shares have no payment confirmation; their debts have been retained'), flatten(tree));
  assert.ok(flatten(tree).includes('Closed as unconfirmed — debt retained'), flatten(tree));
  assert.equal(flatten(tree).includes('This session is settled and is now read-only'), false);
  assert.equal(byId(tree, 'resolve-deleted-member-deleted_2'), undefined);
  h.unmount();
});
