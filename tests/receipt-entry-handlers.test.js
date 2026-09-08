const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { nativeCameraErrorMessage } = require('../lib/nativeCameraFeedback');
const { ReceiptCloudConsentDeclinedError, isReceiptCloudConsentDeclined } = require('../lib/receiptPrivacyConsent');

const home = 'src/app/page.tsx';
const group = 'src/app/group/[id]/page.tsx';
const camera = 'src/components/CameraViewfinder.tsx';
const draft = {
  receipt: { items: [{ name: 'Meal', price: 118 }] }, imageQuality: { warnings: [] },
  previewImages: ['preview'], scanId: 'new-scan', recoveryToken: 'new-recovery', usedLocalFallback: false,
};

function findNode(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (node) => findNode(node, predicate));
}

// Extract function declarations using the parser, then execute the production
// bodies with isolated platform/state boundaries. No copied handler logic.
function handlers(file, names, context = {}) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = names.map((name) => {
    const node = findNode(source, (candidate) => ts.isVariableDeclaration(candidate) && candidate.name.getText(source) === name);
    assert.ok(node, `Missing production handler ${name}`);
    return `const ${node.getText(source)};`;
  });
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, ...context,
    useCallback: (callback) => callback,
    console: { error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(`${declarations.join('\n')}\nmodule.exports = { ${names.join(', ')} };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, sandbox, { filename: file });
  return { ...module.exports, source, evaluate(expression) { return vm.runInContext(expression, sandbox); } };
}

function entryHarness(file, options = {}) {
  const state = {
    showCamera: true, pendingReceiptDraft: { previous: true }, pendingScanId: 'old-scan',
    pendingRecoveryToken: 'old-recovery', editingBill: { id: 'old-bill' },
    showManualModal: false, showCreateBillModal: false, isUploading: false,
  };
  const changes = [];
  const alerts = [];
  const scans = [];
  let cameraCalls = 0;
  const fileInputRef = { current: { value: 'selected-file' } };
  const cameraInputRef = { current: { value: 'selected-photo', click() {} } };
  const setters = Object.fromEntries(Object.keys(state).map((key) => [
    `set${key[0].toUpperCase()}${key.slice(1)}`,
    (value) => { state[key] = value; changes.push([key, value]); },
  ]));
  const actual = handlers(file, ['openManualReceipt', 'handleScanCamera', 'handlePhotoUpload'], {
    ...setters, fileInputRef, cameraInputRef,
    profile: { displayName: 'Diner' }, language: options.language || 'en', isRtl: options.language === 'he',
    t: (_key, _params, fallback) => fallback,
    nativeCameraErrorMessage, isReceiptCloudConsentDeclined,
    receiptScanUserMessage: () => 'Please try another receipt image',
    alert: (message) => alerts.push(message),
    createReceiptDraft: async (...args) => { scans.push(args); return options.scan ? options.scan(...args) : draft; },
    Capacitor: { isNativePlatform: () => options.native !== false },
    CameraResultType: { Base64: 'base64' }, CameraSource: { Camera: 'CAMERA' },
    CapCamera: { getPhoto: async () => {
      cameraCalls++;
      if (options.cameraError) throw options.cameraError;
      return { base64String: 'photo', format: 'jpeg' };
    } },
    navigator: { mediaDevices: { getUserMedia() {} }, userAgent: 'Desktop' }, window: {},
  });
  return { ...actual, state, changes, alerts, scans, fileInputRef, cameraInputRef, get cameraCalls() { return cameraCalls; } };
}

async function invoke(harness, method) {
  if (method === 'handlePhotoUpload') return harness[method]({ target: { files: [{ name: 'receipt.jpg' }] } });
  return harness[method]();
}

for (const file of [home, group]) {
  for (const method of ['handlePhotoUpload', 'handleScanCamera']) {
    test(`${file} ${method}: choosing manual entry clears the previous receipt and credentials`, async () => {
      const h = entryHarness(file, { scan: async () => { throw new ReceiptCloudConsentDeclinedError(true); } });
      await invoke(h, method);
      assert.equal(h.state.pendingReceiptDraft, null);
      assert.equal(h.state.pendingScanId, '');
      assert.equal(h.state.pendingRecoveryToken, '');
      assert.equal(h.state.showCamera, false);
      assert.equal(h.state[file === home ? 'showManualModal' : 'showCreateBillModal'], true);
      if (file === group) assert.equal(h.state.editingBill, null);
      assert.equal(h.state.isUploading, false);
      assert.deepEqual(h.alerts, []);
      if (method === 'handlePhotoUpload') {
        assert.equal(h.fileInputRef.current.value, '');
        if (file === home) assert.equal(h.cameraInputRef.current.value, '');
      }
    });

    test(`${file} ${method}: cancelling cloud consent is silent and does not create a draft`, async () => {
      const h = entryHarness(file, { scan: async () => { throw new ReceiptCloudConsentDeclinedError(false); } });
      const previousDraft = h.state.pendingReceiptDraft;
      await invoke(h, method);
      assert.equal(h.state.pendingReceiptDraft, previousDraft);
      assert.equal(h.state.pendingScanId, 'old-scan');
      assert.equal(h.state.pendingRecoveryToken, 'old-recovery');
      assert.equal(h.state.showManualModal, false);
      assert.equal(h.state.showCreateBillModal, false);
      assert.equal(h.state.isUploading, false);
      assert.deepEqual(h.alerts, []);
    });

    test(`${file} ${method}: successful scanning still opens receipt confirmation with new credentials`, async () => {
      const h = entryHarness(file);
      await invoke(h, method);
      assert.equal(h.scans.length, 1);
      assert.equal(h.scans[0][1], 'Diner');
      assert.equal(h.state.pendingReceiptDraft.items, draft.receipt.items);
      assert.equal(h.state.pendingReceiptDraft._previewImages, draft.previewImages);
      assert.equal(h.state.pendingScanId, draft.scanId);
      assert.equal(h.state.pendingRecoveryToken, draft.recoveryToken);
      assert.equal(h.state[file === home ? 'showManualModal' : 'showCreateBillModal'], true);
      assert.equal(h.state.isUploading, false);
      assert.deepEqual(h.alerts, []);
    });
  }

  test(`${file}: native permission rejection displays localized recovery options`, async () => {
    for (const language of ['en', 'he']) {
      const h = entryHarness(file, { language, cameraError: new Error('User denied access to camera') });
      await h.handleScanCamera();
      assert.equal(h.cameraCalls, 1);
      assert.equal(h.scans.length, 0);
      assert.equal(h.alerts.length, 1);
      assert.match(h.alerts[0], language === 'he' ? /הגדרות.*גלריה.*ידנית/ : /Settings.*gallery.*manually/);
      assert.equal(h.state.isUploading, false);
    }
  });

  test(`${file}: native camera cancellation is silent and does not start receipt processing`, async () => {
    for (const message of ['User cancelled photos app', 'User cancelled camera app']) {
      const h = entryHarness(file, { cameraError: new Error(message) });
      await h.handleScanCamera();
      assert.equal(h.cameraCalls, 1);
      assert.equal(h.scans.length, 0);
      assert.deepEqual(h.alerts, []);
      assert.equal(h.state.showManualModal, false);
      assert.equal(h.state.showCreateBillModal, false);
    }
  });
}

function cameraHarness(options = {}) {
  const state = { isScanning: false, capturedImage: 'data:image/jpeg;base64,photo' };
  const calls = { manual: 0, cancel: 0, completed: [], alerts: [] };
  const stream = { id: 'existing-camera-stream' };
  const videoRef = { current: null };
  const actual = handlers(camera, ['attachVideo', 'processImageForOCR'], {
    videoRef, streamRef: { current: stream }, capturedImage: state.capturedImage,
    setCapturedImage: (value) => { state.capturedImage = value; },
    setIsScanning: (value) => { state.isScanning = value; },
    createReceiptDraft: options.scan || (async () => draft), hostName: 'Diner',
    isReceiptCloudConsentDeclined, receiptScanUserMessage: () => 'Please try another receipt image',
    t: (_key, _params, fallback) => fallback,
    onScanComplete: (value) => calls.completed.push(value),
    onManualEntry: options.noManual ? undefined : () => calls.manual++,
    onCancel: () => calls.cancel++, alert: (message) => calls.alerts.push(message),
    toggleFacingMode() {},
  });
  return { ...actual, state, calls, stream, videoRef };
}

test('web camera consent decisions preserve manual, cancellation, and success behavior', async () => {
  for (const manual of [true, false]) {
    const h = cameraHarness({ scan: async () => { throw new ReceiptCloudConsentDeclinedError(manual); } });
    await h.processImageForOCR('photo');
    assert.equal(h.calls.manual, manual ? 1 : 0);
    assert.equal(h.calls.cancel, 0);
    assert.deepEqual(h.calls.completed, []);
    assert.deepEqual(h.calls.alerts, []);
    assert.equal(h.state.isScanning, false);
  }
  const noManual = cameraHarness({ noManual: true, scan: async () => { throw new ReceiptCloudConsentDeclinedError(true); } });
  await noManual.processImageForOCR('photo');
  assert.equal(noManual.calls.cancel, 1);
  const success = cameraHarness();
  await success.processImageForOCR('photo');
  assert.equal(success.calls.completed.length, 1);
  assert.equal(success.calls.completed[0].receipt.items, draft.receipt.items);
  assert.equal(success.calls.completed[0].scanId, draft.scanId);
  assert.equal(success.calls.completed[0].recoveryToken, draft.recoveryToken);
  assert.equal(success.calls.completed[0].confirmationRequired, true);
  assert.equal(success.state.isScanning, false);
});

test('cancelled cloud scan followed by Retake reattaches the existing camera stream to the actual video ref', async () => {
  let decline;
  const h = cameraHarness({ scan: () => new Promise((_, reject) => { decline = reject; }) });
  const videoNode = findNode(h.source, (node) => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(h.source) === 'video');
  const ref = videoNode.attributes.properties.find((node) => ts.isJsxAttribute(node) && node.name.getText(h.source) === 'ref');
  const attach = h.evaluate(ref.initializer.expression.getText(h.source));
  assert.equal(typeof attach, 'function', 'The rendered video needs a mount callback');
  const firstVideo = { srcObject: null };
  attach(firstVideo);
  assert.equal(firstVideo.srcObject, h.stream);
  const pendingScan = h.processImageForOCR('photo');
  assert.equal(h.state.isScanning, true);
  attach(null); // The scanning overlay replaces the video DOM node.
  decline(new ReceiptCloudConsentDeclinedError(false));
  await pendingScan;
  assert.equal(h.state.isScanning, false);
  assert.deepEqual(h.calls.alerts, []);
  const retakeNode = findNode(h.source, (node) => ts.isJsxOpeningElement(node) && node.tagName.getText(h.source) === 'button'
    && node.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(h.source) === 'aria-label'
      && attribute.initializer.getText(h.source).includes('Retake Photo')));
  const retakeClick = retakeNode.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(h.source) === 'onClick');
  h.evaluate(retakeClick.initializer.expression.getText(h.source))();
  assert.equal(h.state.capturedImage, null);
  const remountedVideo = { srcObject: null };
  attach(remountedVideo);
  assert.equal(remountedVideo.srcObject, h.stream);
  assert.equal(h.videoRef.current, remountedVideo);
});

test('closing the camera before permission resolves stops its late stream without changing unmounted state', async () => {
  let grantPermission;
  let stopped = 0;
  const stateUpdates = [];
  const streamRef = { current: null };
  const track = { stop() { stopped++; }, getCapabilities: () => ({ torch: false }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const h = handlers(camera, ['attachVideo', 'startCamera'], {
    streamRef, videoRef: { current: null }, cameraRequestRef: { current: 0 }, facingMode: 'environment',
    navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grantPermission = resolve; }) } },
    setTorchSupported: (value) => stateUpdates.push(value), setFlashOn: (value) => stateUpdates.push(value),
    setCameraPermissionGranted: (value) => stateUpdates.push(value), setCameraError: (value) => stateUpdates.push(value),
  });
  const effect = findNode(h.source, (node) => ts.isCallExpression(node) && node.expression.getText(h.source) === 'useEffect'
    && node.arguments[1]?.getText(h.source).includes('startCamera'));
  assert.ok(effect, 'The mounted camera effect must own cleanup');
  const cleanup = h.evaluate(effect.arguments[0].getText(h.source))();
  cleanup();
  grantPermission(stream);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, 1);
  assert.equal(streamRef.current, null);
  assert.deepEqual(stateUpdates, []);
});
