const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseReceiptImage, parseReceiptTextWithGemini, DEFAULT_MODELS } = require('../lib/gemini');
const { createAsyncGate } = require('../lib/ocrControl');

const receipt = {
  storeName: 'קפה בדיקה', date: '2026-09-08', currency: 'NIS', documentLanguage: 'hebrew',
  receiptTotal: 36, items: [{ name: 'קפה', lineTotal: 12 }, { name: 'עוגה', lineTotal: 24 }],
};
const providerBody = JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify(receipt) }] } }],
});
const shortBudgets = { pipelineTimeoutMs: 1_500, fallbackTimeoutMs: 1_500 };

// These tests use real fetch/Response streams over loopback. Only the provider
// destination is redirected; no cloud request or real API credential is used.
async function withProvider(t, handler, check) {
  const originalFetch = global.fetch;
  const configuredModel = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_MODEL;
  const requests = [];
  const pending = [];
  const responses = [];
  let closing = false;
  const server = http.createServer((request, response) => {
    request.resume();
    const closed = new Promise((resolve) => response.once('close', resolve));
    responses.push({ response, closed });
    handler(request, response, responses.length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  global.fetch = (endpoint, options) => {
    if (closing) return Promise.reject(new Error('Local provider fixture closed'));
    requests.push({ endpoint, signal: options.signal });
    return originalFetch(`${origin}${new URL(endpoint).pathname}`, options);
  };
  const scan = (options = shortBudgets) => {
    const promise = parseReceiptImage('/9j/', 'image/jpeg', 'local-fixture-key', options);
    pending.push(promise);
    return promise;
  };
  try {
    await check({ scan, requests, responses });
  } finally {
    // On a regression, destroy hanging sockets and keep redirection installed
    // until any resulting fallback work also settles.
    closing = true;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled(pending);
    global.fetch = originalFetch;
    if (configuredModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = configuredModel;
  }
}

async function bounded(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function stallBody(response, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.write('{');
}

function assertAgreement(result, attempts = 3) {
  assert.equal(result.receiptTotal, receipt.receiptTotal);
  assert.deepEqual(result.items.map(({ name, price }) => ({ name, price })), [
    { name: 'קפה', price: 12 }, { name: 'עוגה', price: 24 },
  ]);
  assert.equal(result.ocr.modelAttempts, attempts);
  assert.equal(result.ocr.verificationStatus, 'cross_model_agreement');
  assert.equal(result.ocr.nameVerificationStatus, 'exact-cross-model-agreement');
}

test('OCR quorum aborts an already-started third response body', { timeout: 8_000 }, async (t) => {
  const firstResponses = [];
  await withProvider(t, (_request, response, count) => {
    if (count < 3) firstResponses.push(response);
    else {
      stallBody(response);
      // Ensure the stalled body has started before the two agreeing reads end.
      setImmediate(() => firstResponses.forEach((first) => first.end(providerBody)));
    }
  }, async ({ scan, requests, responses }) => {
    const result = await bounded(scan({ pipelineTimeoutMs: 6_000 }), 2_000,
      'Two agreeing reads must not wait for the stalled third body');
    assertAgreement(result);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].signal.aborted, true, 'Quorum must abort actual provider work');
    await bounded(responses[2].closed, 1_000, 'The stalled upstream connection must close');
  });
});

test('OCR body deadlines bound both rounds and preserve provider-unavailable errors', { timeout: 8_000 }, async (t) => {
  await withProvider(t, (_request, response) => stallBody(response), async ({ scan, requests, responses }) => {
    await assert.rejects(bounded(scan(), 4_500, 'Stalled JSON outlived both model-round budgets'),
      (error) => error.statusCode === 503 && error.errorCode === 'OCR_PROVIDER_UNAVAILABLE');
    assert.equal(requests.length, 5);
    assert.ok(requests.every(({ signal }) => signal.aborted));
    await bounded(Promise.all(responses.map(({ closed }) => closed)), 1_000,
      'Timed-out response streams must close');
  });
});

test('OCR verification grace cancels stalled peers and keeps a readable Hebrew draft for review', { timeout: 5_000 }, async (t) => {
  await withProvider(t, (_request, response, count) => {
    if (count === 1) response.end(providerBody);
    else stallBody(response);
  }, async ({ scan, requests, responses }) => {
    const result = await bounded(scan({ pipelineTimeoutMs: 6_000, verificationGraceMs: 250 }), 2_000,
      'A readable draft must not remain blocked after verification grace expires');
    assert.equal(result.receiptTotal, 36);
    assert.equal(result.ocr.verificationStatus, 'verification_failed');
    assert.equal(result.ocr.nameVerificationStatus, 'review-required');
    assert.equal(requests.length, 3, 'A readable draft must not trigger additional fallback models');
    assert.ok(requests.slice(1).every(({ signal }) => signal.aborted));
    await bounded(Promise.all(responses.slice(1).map(({ closed }) => closed)), 1_000,
      'Cancelled verifier bodies must close');
  });
});

test('OCR header deadlines still abort actual requests and reach the fallback round', { timeout: 8_000 }, async (t) => {
  await withProvider(t, () => {}, async ({ scan, requests, responses }) => {
    await assert.rejects(bounded(scan(), 4_500, 'Headers outlived both model-round budgets'),
      (error) => error.errorCode === 'OCR_PROVIDER_UNAVAILABLE');
    assert.equal(requests.length, 5);
    assert.ok(requests.every(({ signal }) => signal.aborted));
    await bounded(Promise.all(responses.map(({ closed }) => closed)), 1_000,
      'Header-timeout requests must close');
  });
});

test('OCR falls back after stalled primary bodies without weakening Hebrew agreement', { timeout: 6_000 }, async (t) => {
  await withProvider(t, (_request, response, count) => {
    if (count <= 3) stallBody(response);
    else response.end(providerBody);
  }, async ({ scan, requests, responses }) => {
    assertAgreement(await bounded(scan(), 3_000, 'The fallback did not recover the scan'), 5);
    assert.ok(requests.slice(0, 3).every(({ signal }) => signal.aborted));
    assert.match(requests[3].endpoint, /gemini-2\.5-flash:generateContent/);
    assert.match(requests[4].endpoint, /gemini-flash-latest:generateContent/);
    await bounded(Promise.all(responses.slice(0, 3).map(({ closed }) => closed)), 1_000,
      'Primary streams must not survive fallback success');
  });
});

test('OCR cancels unread error bodies and retains the successful fallback behavior', { timeout: 5_000 }, async (t) => {
  await withProvider(t, (_request, response, count) => {
    if (count <= 3) stallBody(response, 503);
    else response.end(providerBody);
  }, async ({ scan, requests, responses }) => {
    assertAgreement(await bounded(scan(), 2_000, 'Error bodies prevented fallback'), 5);
    assert.ok(requests.slice(0, 3).every(({ signal }) => signal.aborted), 'Unread error streams must be cancelled');
    await bounded(Promise.all(responses.slice(0, 3).map(({ closed }) => closed)), 1_000,
      'Error response streams must not leak');
  });
});

test('three occupied OCR slots release after quorum and admit a queued fourth scan', { timeout: 8_000 }, async (t) => {
  const gate = createAsyncGate({ maxConcurrent: 3, maxQueue: 8, waitTimeoutMs: 3_000 });
  let firstBatchReady;
  const ready = new Promise((resolve) => { firstBatchReady = resolve; });
  const goodResponses = [];
  const stalled = [];
  let releaseGood = false;
  await withProvider(t, (request, response, count) => {
    if (request.url.includes(`${DEFAULT_MODELS[2]}:generateContent`)) {
      stallBody(response);
      stalled.push(response);
    } else if (releaseGood) response.end(providerBody);
    else goodResponses.push(response);
    if (count === 9) firstBatchReady();
  }, async ({ scan, requests, responses }) => {
    const run = async () => {
      const release = await gate.acquire();
      try { return await scan({ pipelineTimeoutMs: 6_000 }); }
      finally { release(); }
    };
    const scans = Array.from({ length: 3 }, run);
    await bounded(ready, 2_000, 'Initial three scans did not start all nine model requests');
    scans.push(run());
    assert.deepEqual(gate.state(), { active: 3, queued: 1 });
    releaseGood = true;
    goodResponses.forEach((response) => response.end(providerBody));
    const results = await bounded(Promise.all(scans), 2_000,
      'Three quorum scans held every processing slot and blocked the fourth');
    results.forEach((result) => assertAgreement(result));
    assert.deepEqual(gate.state(), { active: 0, queued: 0 });
    assert.equal(requests.length, 12);
    assert.equal(requests.filter(({ signal }) => signal.aborted).length, 4);
    await bounded(Promise.all(responses.filter(({ response }) => stalled.includes(response)).map(({ closed }) => closed)),
      1_000, 'No unused provider stream may remain after the slots are released');
  });
});

test('text receipt parsing still consumes a complete JSON response', { timeout: 5_000 }, async (t) => {
  await withProvider(t, (_request, response) => response.end(providerBody), async () => {
    const result = await parseReceiptTextWithGemini('קפה 12\nעוגה 24\nסה"כ 36', 'local-fixture-key');
    assert.equal(result.receiptTotal, 36);
    assert.equal(result.items.length, 2);
  });
});

test('complete but unusable model output remains an unreadable receipt, not an outage', { timeout: 5_000 }, async (t) => {
  await withProvider(t, (_request, response) => response.end(JSON.stringify({ candidates: [] })), async ({ scan, requests }) => {
    assert.equal(await bounded(scan(), 2_000, 'Unusable output did not finish'), null);
    assert.equal(requests.length, 5);
  });
});
