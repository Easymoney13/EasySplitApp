const { normalizeAmount, normalizeDiscount, isTotalOrTaxLine, reconcileReceipt } = require('./receiptMath');
const { assessOcrReadability, inferDocumentLanguage, normalizeOcrName } = require('./ocrQuality');

// Production-proven fast multimodal models. Keep the first three independent:
// they are started together so verification does not add serial latency.
const DEFAULT_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite',
];
const REQUEST_TIMEOUT_MS = 25_000;
// Keep the fast quorum path, but do not mistake a slow provider response for
// an unreadable receipt. Most scans still return as soon as two reads agree.
const PIPELINE_TIMEOUT_MS = 10_000;
const FALLBACK_TIMEOUT_MS = 7_500;
const VERIFICATION_GRACE_MS = 2_000;
const FAST_CONSENSUS_MODEL_COUNT = 3;
const FALLBACK_MODEL_COUNT = 2;

const RECEIPT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    storeName: { type: 'STRING', description: 'Name of the store or restaurant exactly as printed' },
    restaurant: {
      type: 'OBJECT',
      description: 'Business identity fields printed in the receipt header. Leave unreadable fields empty.',
      properties: {
        printedName: { type: 'STRING', description: 'Business name exactly as printed' },
        businessId: { type: 'STRING', description: 'Printed company, tax, dealer, or business registration number' },
        address: { type: 'STRING', description: 'Printed business address' },
        phone: { type: 'STRING', description: 'Printed business phone number' },
      },
    },
    date: { type: 'STRING', description: 'Date of transaction (YYYY-MM-DD)' },
    currency: { type: 'STRING', enum: ['NIS', 'USD', 'GBP', 'EUR'], description: 'Currency code' },
    documentLanguage: { type: 'STRING', enum: ['hebrew', 'english', 'mixed', 'unknown'], description: 'Script visibly printed on the purchased item rows' },
    subtotal: { type: 'NUMBER', description: 'Subtotal amount if explicitly printed' },
    tax: { type: 'NUMBER', description: 'Tax amount if explicitly printed' },
    service: { type: 'NUMBER', description: 'Service fee if explicitly printed' },
    discount: { type: 'NUMBER', description: 'Discount amount if explicitly printed' },
    receiptTotal: { type: 'NUMBER', description: 'Final amount due if readable' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Item description exactly as printed in natural reading order without quantity or price' },
          quantity: { type: 'NUMBER', description: 'Purchased quantity; default to 1 only when no quantity is printed' },
          unitPrice: { type: 'NUMBER', description: 'Price for one unit when shown or inferable from quantity and line total' },
          lineTotal: { type: 'NUMBER', description: 'Total charged for this full item row; this is the value used for splitting' },
          category: { type: 'STRING', enum: ['Food', 'Beverages', 'Dessert', 'Groceries', 'Travel', 'Shopping', 'Service', 'Other'], description: 'Item category' },
        },
        required: ['name', 'lineTotal'],
      },
    },
  },
  required: ['storeName', 'items'],
};

function parseJsonCandidate(text) {
  if (!text || typeof text !== 'string') return null;
  let cleanText = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleanText.indexOf('{');
  const end = cleanText.lastIndexOf('}');
  if (start !== -1 && end > start) cleanText = cleanText.slice(start, end + 1);
  try {
    return JSON.parse(cleanText);
  } catch (_) {
    try {
      return JSON.parse(cleanText.replace(/,\s*([\]}])/g, '$1').replace(/[\u0000-\u001F]+/g, ' '));
    } catch (_) {
      return null;
    }
  }
}

function normalizeReceipt(parsed, sourceText) {
  const rawItems = parsed?.items || parsed?.lineItems || parsed?.receiptItems || [];
  if (!Array.isArray(rawItems)) return null;
  const items = rawItems.flatMap((item, index) => {
    const quantity = normalizeAmount(item?.quantity);
    const unitPrice = normalizeAmount(item?.unitPrice ?? item?.unit_price);
    const explicitLineTotal = normalizeAmount(
      item?.lineTotal ?? item?.line_total ?? item?.totalPrice ?? item?.total_price
    );
    const legacyPrice = normalizeAmount(item?.price);
    const calculatedLineTotal = quantity && unitPrice
      ? Math.round(quantity * unitPrice * 100) / 100
      : null;
    const price = explicitLineTotal ?? calculatedLineTotal ?? legacyPrice ?? unitPrice;
    const name = typeof item?.name === 'string' ? normalizeOcrName(item.name) : '';
    if (!name || price === null || price <= 0 || price > 50_000) return [];
    if (isTotalOrTaxLine(name)) return [];
    const quantitySuffix = quantity && quantity > 1 ? ` (${quantity}x)` : '';
    return [{
      id: `ocr_item_${index}`,
      name: `${name}${quantitySuffix}`,
      price,
      quantity: quantity || 1,
      unitPrice: unitPrice ?? (quantity && quantity > 0 ? Math.round((price / quantity) * 100) / 100 : price),
      lineTotal: price,
      category: typeof item.category === 'string' ? item.category : 'Other',
      claimedBy: [],
    }];
  });
  if (items.length === 0) return null;

  const documentLanguage = inferDocumentLanguage(parsed, sourceText);
  const hasHebrew = documentLanguage === 'hebrew' || documentLanguage === 'mixed';
  const normalized = {
    storeName: typeof parsed.storeName === 'string' ? normalizeOcrName(parsed.storeName) : 'Scanned Receipt',
    restaurant: {
      printedName: typeof parsed.restaurant?.printedName === 'string'
        ? normalizeOcrName(parsed.restaurant.printedName)
        : (typeof parsed.storeName === 'string' ? normalizeOcrName(parsed.storeName) : ''),
      businessId: typeof parsed.restaurant?.businessId === 'string' ? parsed.restaurant.businessId.trim() : '',
      address: typeof parsed.restaurant?.address === 'string' ? normalizeOcrName(parsed.restaurant.address) : '',
      phone: typeof parsed.restaurant?.phone === 'string' ? parsed.restaurant.phone.trim() : '',
      source: 'ocr',
    },
    date: typeof parsed.date === 'string' ? parsed.date : new Date().toISOString().split('T')[0],
    currency: hasHebrew ? 'NIS' : (typeof parsed.currency === 'string' ? parsed.currency : 'NIS'),
    documentLanguage,
    receiptTotal: normalizeAmount(parsed.receiptTotal ?? parsed.total),
    subtotal: normalizeAmount(parsed.subtotal),
    tax: normalizeAmount(parsed.tax),
    service: normalizeAmount(parsed.service),
    discount: normalizeDiscount(parsed.discount),
    items,
  };
  const quality = assessOcrReadability(normalized, { expectedLanguage: documentLanguage, sourceText });
  if (!quality.readable) return null;
  return { ...normalized, ocrQuality: quality };
}

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS, externalSignal = null) {
  const controller = new AbortController();
  const abortFromExternalSignal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternalSignal);
  }
}

async function requestModel(modelName, apiKey, base64Images, mimeType, options = {}) {
  const images = Array.isArray(base64Images) ? base64Images : [base64Images];
  const passLabel = options.pass === 'tiebreaker'
    ? 'This is a numeric tiebreaker read. Independently re-read every quantity, unit price, line total, subtotal, and final total from the pixels. Pay special attention to faint or clipped leading digits. Do not copy or infer a value from arithmetic.'
    : (options.pass === 'verification'
      ? 'This is a cross-model verification read. Ignore any earlier answer and read only the pixels.'
      : 'This is the primary extraction read.');
  const prompt = `You are a high-precision restaurant, cafe, bar, and retail receipt parser. Analyze the receipt image and return clean structured JSON.

Read the physical image top-to-bottom and preserve two-dimensional row alignment.
The receipt may be in Hebrew (right-to-left), English, or bilingual text. Correctly pair the item name (usually on the right for Hebrew) with its quantity and price on the visual line.

Rules:
- Extract every purchased item from every section of the receipt, including rows after divider lines.
- For each row, return the item name, quantity, unit price, and the full line total. lineTotal must be the complete amount charged for that row and is the value EasySplit will split.
- Preserve item names as printed. When Hebrew is visible, return real Hebrew Unicode in logical reading order; never transliterate it, reverse the words, or return mojibake such as repeated ×/Ã/ glyphs.
- Categorize each item into: 'Food', 'Beverages', 'Dessert', 'Groceries', 'Travel', 'Shopping', 'Service', or 'Other'.
- Never include receipt header info (restaurant name, company/tax ID, address, phone number, print date/time, order number, table number, waiter name, number of diners/סועדים) as purchased items.
- Preserve restaurant identity separately in restaurant.printedName, restaurant.businessId, restaurant.address, and restaurant.phone whenever those fields are visibly printed. Never guess an unreadable identity field.
- Never include subtotal, total, VAT/tax, service, tip, discount, payment, cash, credit-card, change, table, waiter, or receipt-number lines as purchased items.
- Read receiptTotal, subtotal, tax, service, and discount only when they are explicitly visible. VAT may already be included in Israeli item prices.
- Do not invent an unreadable item or price and do not adjust prices merely to make the arithmetic match.
- Return numbers as decimal values without currency symbols.
${passLabel}`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const timeoutMs = Math.max(1, options.timeoutMs || REQUEST_TIMEOUT_MS);

  try {
    const isGemini3 = /^gemini-3(?:\.|-)/i.test(modelName);
    const generationConfig = {
      responseMimeType: 'application/json',
      responseSchema: RECEIPT_RESPONSE_SCHEMA,
      maxOutputTokens: 4_096,
      ...(isGemini3 ? { thinkingConfig: { thinkingLevel: 'low' } } : { temperature: 0.1 }),
    };
    const payload = JSON.stringify({
      contents: [{ parts: [
        { text: prompt },
        ...images.flatMap((data, index) => (
          images.length > 1
            ? [
                { text: `Receipt image part ${index + 1} of ${images.length}:` },
                { inlineData: { mimeType: mimeType || 'image/jpeg', data } },
              ]
            : [{ inlineData: { mimeType: mimeType || 'image/jpeg', data } }]
        )),
      ] }],
      generationConfig,
    });

    let response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }, timeoutMs, options.signal);

    if (!response.ok) {
      if (response.status === 429) {
        console.warn(`Model ${modelName} rate limit 429, failing over to next model in pool`);
      }
      return { receipt: null, outcome: 'provider-error', httpStatus: response.status };
    }
    const responseData = await response.json();
    const text = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
    const receipt = normalizeReceipt(parseJsonCandidate(text), text);
    return {
      receipt,
      outcome: receipt ? 'success' : 'invalid-output',
      httpStatus: response.status || 200,
    };
  } catch (err) {
    if (!options.signal?.aborted) console.warn(`Receipt OCR request error: ${err.message}`);
    return {
      receipt: null,
      outcome: err?.name === 'AbortError' ? 'timeout' : 'provider-error',
      httpStatus: 0,
    };
  }
}

function receiptQualityScore(receipt) {
  if (!receipt?.items?.length) return -Infinity;
  const reconciliation = reconcileReceipt(receipt);
  let score = 0;
  if (reconciliation.receiptTotal !== null) score += 10;
  if (reconciliation.status === 'matched') score += 60;
  if (reconciliation.status === 'matched_adjusted') score += 55;
  if (reconciliation.status === 'ambiguous_adjustments') score += 5;
  if (reconciliation.status === 'mismatch' && reconciliation.receiptTotal) {
    score -= Math.min(40, (reconciliation.difference / reconciliation.receiptTotal) * 100);
  }
  return score;
}

function normalizeLineIdentity(item) {
  return String(item?.name || '')
    .toLowerCase()
    .replace(/\(\s*\d+(?:\.\d+)?x\s*\)$/i, '')
    .replace(/[^a-z0-9\u0590-\u05ff]+/g, '')
    .trim();
}

function haveSameLineIdentities(first, second) {
  const firstItems = Array.isArray(first?.items) ? first.items : [];
  const secondItems = Array.isArray(second?.items) ? second.items : [];
  if (firstItems.length !== secondItems.length || firstItems.length === 0) return false;
  return firstItems.every((item, index) => (
    normalizeLineIdentity(item) === normalizeLineIdentity(secondItems[index])
  ));
}

function haveSameReceiptValues(first, second) {
  if (!haveSameLineIdentities(first, second)) return false;
  const textFields = ['storeName', 'date', 'currency'];
  if (!textFields.every((field) => String(first?.[field] || '').trim().toLowerCase() === String(second?.[field] || '').trim().toLowerCase())) return false;
  const amountFields = ['receiptTotal', 'subtotal', 'tax', 'service'];
  if (!amountFields.every((field) => normalizeAmount(first?.[field]) === normalizeAmount(second?.[field]))) return false;
  if (normalizeDiscount(first?.discount) !== normalizeDiscount(second?.discount)) return false;
  return first.items.every((item, index) => (
    normalizeAmount(item?.price) === normalizeAmount(second.items[index]?.price)
    && (normalizeAmount(item?.quantity) || 1) === (normalizeAmount(second.items[index]?.quantity) || 1)
    && normalizeAmount(item?.unitPrice) === normalizeAmount(second.items[index]?.unitPrice)
  ));
}

function majorityAmount(values) {
  const normalized = values.map((value) => normalizeAmount(value));
  const counts = new Map();
  for (const value of normalized) {
    if (value === null) continue;
    const key = Math.round(value * 100);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const winner = [...counts.entries()].find(([, count]) => count >= 2);
  return winner ? winner[0] / 100 : null;
}

function buildValueConsensus(primary, verification, tiebreaker) {
  if (!primary || !verification || !tiebreaker) {
    return { receipt: primary, resolvedItemPrices: 0, unresolvedItemPrices: primary?.items?.length || 0, changedValues: 0 };
  }
  if (!haveSameLineIdentities(primary, verification) || !haveSameLineIdentities(primary, tiebreaker)) {
    return { receipt: primary, resolvedItemPrices: 0, unresolvedItemPrices: primary?.items?.length || 0, changedValues: 0 };
  }

  let changedValues = 0;
  let resolvedItemPrices = 0;
  let unresolvedItemPrices = 0;
  const receipt = {
    ...primary,
    items: primary.items.map((item, index) => {
      const verifiedItem = verification.items[index];
      const tiebreakerItem = tiebreaker.items[index];
      const price = majorityAmount([item.price, verifiedItem.price, tiebreakerItem.price]);
      if (price === null) {
        unresolvedItemPrices += 1;
        return item;
      }
      resolvedItemPrices += 1;
      if (normalizeAmount(item.price) !== price) changedValues += 1;
      const quantity = majorityAmount([item.quantity, verifiedItem.quantity, tiebreakerItem.quantity]);
      const unitPrice = majorityAmount([item.unitPrice, verifiedItem.unitPrice, tiebreakerItem.unitPrice]);
      return {
        ...item,
        price,
        lineTotal: price,
        quantity: quantity ?? item.quantity,
        unitPrice: unitPrice ?? item.unitPrice,
      };
    }),
  };

  for (const field of ['receiptTotal', 'subtotal', 'tax', 'service', 'discount']) {
    const value = majorityAmount([primary[field], verification[field], tiebreaker[field]]);
    if (value === null) continue;
    if (normalizeAmount(primary[field]) !== value) changedValues += 1;
    receipt[field] = value;
  }

  return { receipt, resolvedItemPrices, unresolvedItemPrices, changedValues };
}

function selectBetterReceipt(first, second) {
  if (!first) return second;
  if (!second) return first;
  return first;
}

function receiptOcrEvidence(receipt, evidence) {
  const requiresHebrewReview = requiresStrictLanguageAgreement(receipt);
  const namesAgree = [
    'cross_model_agreement',
    'value_disagreement',
    'value_consensus',
    'partial_value_consensus',
    'verified_primary',
    'exact-cross-model-agreement',
  ].includes(evidence?.verificationStatus);
  return {
    ...evidence,
    documentLanguage: receipt?.documentLanguage || 'unknown',
    readabilityScore: receipt?.ocrQuality?.score ?? 0,
    hebrewCharacterRatio: receipt?.ocrQuality?.hebrewCharacterRatio ?? 0,
    nameVerificationStatus: requiresHebrewReview
      ? (namesAgree ? 'exact-cross-model-agreement' : 'review-required')
      : 'not-required',
  };
}

function requiresStrictLanguageAgreement(receipt) {
  return receipt?.documentLanguage === 'hebrew' || receipt?.documentLanguage === 'mixed';
}

function findExactAgreement(reads) {
  for (let first = 0; first < reads.length; first += 1) {
    for (let second = first + 1; second < reads.length; second += 1) {
      if (haveSameReceiptValues(reads[first].receipt, reads[second].receipt)) {
        return [reads[first], reads[second]];
      }
    }
  }
  return null;
}

async function runConcurrentModelRound({
  modelNames,
  startIndex,
  apiKey,
  cleanImages,
  mimeType,
  timeoutMs,
  verificationGraceMs,
}) {
  const passes = ['primary', 'verification', 'tiebreaker'];
  const controller = new AbortController();
  const pendingReads = new Map(modelNames.map((modelName, offset) => {
    const index = startIndex + offset;
    const promise = (async () => {
      const result = await requestModel(modelName, apiKey, cleanImages, mimeType, {
        pass: passes[index] || 'verification',
        timeoutMs,
        signal: controller.signal,
      });
      return { index, modelName, ...result };
    })();
    return [promise, index];
  }));
  const completedReads = [];
  const successfulReads = [];
  let successDeadline = 0;

  while (pendingReads.size > 0) {
    const races = [...pendingReads.keys()].map((promise) => (
      promise.then((read) => ({ promise, read }))
    ));
    let graceTimer = null;
    if (successDeadline) {
      const remainingGraceMs = successDeadline - Date.now();
      if (remainingGraceMs <= 0) break;
      races.push(new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve({ graceExpired: true }), remainingGraceMs);
      }));
    }

    const completed = await Promise.race(races);
    if (graceTimer) clearTimeout(graceTimer);
    if (completed.graceExpired) break;
    pendingReads.delete(completed.promise);
    completedReads.push(completed.read);
    if (!completed.read.receipt) continue;
    successfulReads.push(completed.read);
    if (!successDeadline) successDeadline = Date.now() + verificationGraceMs;
    if (findExactAgreement(successfulReads)) break;
  }

  if (pendingReads.size > 0) {
    controller.abort();
    await Promise.allSettled([...pendingReads.keys()]);
  }
  return { completedReads, successfulReads };
}

function createOcrProviderUnavailableError() {
  const error = new Error('All receipt OCR providers failed or timed out');
  error.name = 'OcrProviderUnavailableError';
  error.statusCode = 503;
  error.errorCode = 'OCR_PROVIDER_UNAVAILABLE';
  error.publicMessage = 'Receipt scanning is temporarily unavailable. Please try again or enter the bill manually.';
  return error;
}

async function parseReceiptImage(base64Image, mimeType = 'image/jpeg', customApiKey = '', options = {}) {
  const apiKey = customApiKey || process.env.GEMINI_API_KEY || '';
  const rawImages = Array.isArray(base64Image) ? base64Image : [base64Image];
  const cleanImages = rawImages
    .filter((value) => typeof value === 'string')
    .map((value) => value.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, ''))
    .filter(Boolean)
    .slice(0, 6);
  if (!apiKey || cleanImages.length === 0) return null;
  const configuredModel = process.env.GEMINI_MODEL;
  const models = [...new Set([configuredModel, ...DEFAULT_MODELS].filter(Boolean))];
  const primaryModels = models.slice(0, FAST_CONSENSUS_MODEL_COUNT);
  const fallbackModels = models.slice(
    FAST_CONSENSUS_MODEL_COUNT,
    FAST_CONSENSUS_MODEL_COUNT + FALLBACK_MODEL_COUNT,
  );
  const pipelineStartedAt = Date.now();
  const pipelineTimeoutMs = Math.max(1_500, Math.min(15_000, options.pipelineTimeoutMs || PIPELINE_TIMEOUT_MS));
  const fallbackTimeoutMs = Math.max(1_500, Math.min(12_000, options.fallbackTimeoutMs || FALLBACK_TIMEOUT_MS));
  const verificationGraceMs = Math.max(250, Math.min(5_000, options.verificationGraceMs || VERIFICATION_GRACE_MS));
  const primaryRound = await runConcurrentModelRound({
    modelNames: primaryModels,
    startIndex: 0,
    apiKey,
    cleanImages,
    mimeType,
    timeoutMs: pipelineTimeoutMs,
    verificationGraceMs,
  });
  let attemptedModels = [...primaryModels];
  let completedReads = [...primaryRound.completedReads];
  let successfulReads = [...primaryRound.successfulReads];

  // The former 4.2-second implementation never reached the rest of its model
  // pool. If the fast quorum produced no usable receipt, make one bounded
  // fallback round before deciding whether the image itself is unreadable.
  if (successfulReads.length === 0 && fallbackModels.length > 0) {
    const fallbackRound = await runConcurrentModelRound({
      modelNames: fallbackModels,
      startIndex: primaryModels.length,
      apiKey,
      cleanImages,
      mimeType,
      timeoutMs: fallbackTimeoutMs,
      verificationGraceMs,
    });
    attemptedModels = [...attemptedModels, ...fallbackModels];
    completedReads = [...completedReads, ...fallbackRound.completedReads];
    successfulReads = [...fallbackRound.successfulReads];
  }

  if (successfulReads.length === 0) {
    const providerReturnedInvalidReceipt = completedReads.some((read) => read.outcome === 'invalid-output');
    if (!providerReturnedInvalidReceipt) throw createOcrProviderUnavailableError();
    return null;
  }
  const reads = successfulReads.sort((first, second) => first.index - second.index);

  let selectedRead = reads[0];
  let verificationStatus = reads.length === 1 ? 'verification_failed' : 'row_disagreement';
  let consensusEvidence = {};
  const exactAgreement = findExactAgreement(reads);

  if (exactAgreement) {
    [selectedRead] = exactAgreement;
    const correctedPrimaryValues = reads.length === 3
      && !exactAgreement.includes(reads[0])
      && reads.every((read) => haveSameLineIdentities(reads[0].receipt, read.receipt));
    if (correctedPrimaryValues) {
      const consensus = buildValueConsensus(reads[0].receipt, reads[1].receipt, reads[2].receipt);
      selectedRead = { ...selectedRead, receipt: consensus.receipt };
      consensusEvidence = {
        resolvedItemPrices: consensus.resolvedItemPrices,
        unresolvedItemPrices: consensus.unresolvedItemPrices,
        consensusChangedValues: consensus.changedValues,
      };
      verificationStatus = consensus.unresolvedItemPrices === 0
        ? 'value_consensus'
        : 'partial_value_consensus';
    } else {
      verificationStatus = 'cross_model_agreement';
    }
  } else if (reads.length === 3 && reads.every((read) => haveSameLineIdentities(reads[0].receipt, read.receipt))) {
    const consensus = buildValueConsensus(reads[0].receipt, reads[1].receipt, reads[2].receipt);
    selectedRead = { ...reads[0], receipt: consensus.receipt };
    consensusEvidence = {
      resolvedItemPrices: consensus.resolvedItemPrices,
      unresolvedItemPrices: consensus.unresolvedItemPrices,
      consensusChangedValues: consensus.changedValues,
    };
    verificationStatus = consensus.resolvedItemPrices > 0
      ? (consensus.unresolvedItemPrices === 0 ? 'value_consensus' : 'partial_value_consensus')
      : 'value_disagreement';
  } else if (reads.length >= 2 && haveSameLineIdentities(reads[0].receipt, reads[1].receipt)) {
    verificationStatus = 'value_disagreement';
  }

  const selectedReceipt = selectedRead.receipt;
  const evidenceReads = [selectedRead, ...reads.filter((read) => read !== selectedRead)];
  return {
    ...selectedReceipt,
    ocr: receiptOcrEvidence(selectedReceipt, {
      source: 'gemini-vision',
      modelName: evidenceReads[0]?.modelName || '',
      verificationModelName: evidenceReads[1]?.modelName || '',
      tiebreakerModelName: evidenceReads[2]?.modelName || '',
      modelAttempts: attemptedModels.length,
      successfulModelReads: reads.length,
      providerDurationMs: Date.now() - pipelineStartedAt,
      verificationStatus,
      ...consensusEvidence,
    }),
  };
}

async function parseReceiptTextWithGemini(rawText, customApiKey = '') {
  const apiKey = customApiKey || process.env.GEMINI_API_KEY || '';
  if (!apiKey || typeof rawText !== 'string' || !rawText.trim()) return null;

  const prompt = `You are a receipt parsing assistant. You are given the raw OCR text output of a scanned receipt in English or Hebrew.
Your task is to reconstruct the receipt into structured JSON.
Examine the entire raw text from top to bottom. Reconstruct all items, their prices, and categories.

CRITICAL GUIDELINES:
- Extract ALL purchased line items. Do not stop parsing items when you encounter separator lines (e.g. "---", "___", "***", dots, or borders).
- Keep item names faithful to the OCR input and remove only quantity prefixes or stray glyphs.
- Preserve Hebrew as real Hebrew Unicode in logical reading order. Never transliterate, reverse words, or return mojibake glyph sequences.
- Detect the transaction currency (NIS/USD/GBP/EUR). If Hebrew characters are present, default to NIS.
- Do not invent items or prices. If a line is unreadable or has no price, skip it.
- Do not treat subtotal, tax, discount, change, or cashier names as purchased items.
- Extract totals (subtotal, tax, service, discount, receiptTotal) when available.`;

  const configuredModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(configuredModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { text: `Raw OCR Text:\n${rawText}` }
        ] }],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0,
          response_schema: RECEIPT_RESPONSE_SCHEMA,
        },
      }),
    });
    if (!response.ok) return null;
    const responseData = await response.json();
    const text = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
    return normalizeReceipt(parseJsonCandidate(text), text);
  } catch (err) {
    console.error('Error parsing receipt text with Gemini:', err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  DEFAULT_MODELS,
  normalizeReceipt,
  parseJsonCandidate,
  receiptQualityScore,
  haveSameLineIdentities,
  haveSameReceiptValues,
  buildValueConsensus,
  selectBetterReceipt,
  parseReceiptImage,
  parseReceiptTextWithGemini,
};
