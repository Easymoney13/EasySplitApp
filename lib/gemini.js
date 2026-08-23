const { normalizeAmount, normalizeDiscount, isTotalOrTaxLine, reconcileReceipt } = require('./receiptMath');
const { assessOcrReadability, inferDocumentLanguage, normalizeOcrName } = require('./ocrQuality');

// Active high-performance multimodal models with automatic failover
const DEFAULT_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];
const REQUEST_TIMEOUT_MS = 25_000;
const PIPELINE_TIMEOUT_MS = 60_000;

const RECEIPT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    storeName: { type: 'STRING', description: 'Name of the store or restaurant exactly as printed' },
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

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestModel(modelName, apiKey, base64Images, mimeType, options = {}) {
  const images = Array.isArray(base64Images) ? base64Images : [base64Images];
  const passLabel = options.pass === 'verification'
    ? 'This is a cross-model verification read. Ignore any earlier answer and read only the pixels.'
    : 'This is the primary extraction read.';
  const prompt = `You are a high-precision restaurant, cafe, bar, and retail receipt parser. Analyze the receipt image and return clean structured JSON.

Read the physical image top-to-bottom and preserve two-dimensional row alignment.
The receipt may be in Hebrew (right-to-left), English, or bilingual text. Correctly pair the item name (usually on the right for Hebrew) with its quantity and price on the visual line.

Rules:
- Extract every purchased item from every section of the receipt, including rows after divider lines.
- For each row, return the item name, quantity, unit price, and the full line total. lineTotal must be the complete amount charged for that row and is the value EasySplit will split.
- Preserve item names as printed. When Hebrew is visible, return real Hebrew Unicode in logical reading order; never transliterate it, reverse the words, or return mojibake such as repeated ×/Ã/ glyphs.
- Categorize each item into: 'Food', 'Beverages', 'Dessert', 'Groceries', 'Travel', 'Shopping', 'Service', or 'Other'.
- Never include receipt header info (restaurant name, company/tax ID, address, phone number, print date/time, order number, table number, waiter name, number of diners/סועדים) as purchased items.
- Never include subtotal, total, VAT/tax, service, tip, discount, payment, cash, credit-card, change, table, waiter, or receipt-number lines as purchased items.
- Read receiptTotal, subtotal, tax, service, and discount only when they are explicitly visible. VAT may already be included in Israeli item prices.
- Do not invent an unreadable item or price and do not adjust prices merely to make the arithmetic match.
- Return numbers as decimal values without currency symbols.
${passLabel}`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const timeoutMs = Math.max(1, options.timeoutMs || REQUEST_TIMEOUT_MS);

  try {
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
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        responseSchema: RECEIPT_RESPONSE_SCHEMA,
      },
    });

    let response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }, timeoutMs);

    if (!response.ok) {
      if (response.status === 429) {
        console.warn(`Model ${modelName} rate limit 429, failing over to next model in pool`);
      }
      return null;
    }
    const responseData = await response.json();
    const text = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
    return normalizeReceipt(parseJsonCandidate(text), text);
  } catch (err) {
    console.warn(`Receipt OCR request error: ${err.message}`);
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

function selectBetterReceipt(first, second) {
  if (!first) return second;
  if (!second) return first;
  return first;
}

function receiptOcrEvidence(receipt, evidence) {
  const requiresHebrewReview = requiresStrictLanguageAgreement(receipt);
  const namesAgree = ['cross_model_agreement', 'value_disagreement', 'verified_primary', 'exact-cross-model-agreement'].includes(evidence?.verificationStatus);
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
  const deadline = Date.now() + Math.max(3_000, options.pipelineTimeoutMs || PIPELINE_TIMEOUT_MS);
  let modelAttempts = 0;

  for (const modelName of models) {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) break;
    try {
      modelAttempts += 1;
      const receipt = await requestModel(modelName, apiKey, cleanImages, mimeType, {
        pass: 'primary',
        timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
      });
      if (!receipt) continue;


      const verificationBudget = deadline - Date.now();
      if (verificationBudget < 2_000) {
        return {
          ...receipt,
          ocr: receiptOcrEvidence(receipt, { source: 'gemini-vision', modelName, modelAttempts, verificationStatus: 'deadline_reached' }),
        };
      }
      const verificationModelName = models.find((candidate) => candidate !== modelName);
      if (!verificationModelName) {
        return {
          ...receipt,
          ocr: receiptOcrEvidence(receipt, { source: 'gemini-vision', modelName, modelAttempts, verificationStatus: 'verification_unavailable' }),
        };
      }
      modelAttempts += 1;
      const verifiedReceipt = await requestModel(verificationModelName, apiKey, cleanImages, mimeType, {
        pass: 'verification',
        timeoutMs: Math.min(8_000, verificationBudget),
      });
      const sameLines = haveSameLineIdentities(receipt, verifiedReceipt);
      const sameValues = haveSameReceiptValues(receipt, verifiedReceipt);
      const verificationStatus = !verifiedReceipt
        ? 'verification_failed'
        : (sameLines
          ? (sameValues ? 'cross_model_agreement' : 'value_disagreement')
          : 'row_disagreement');
      return {
        ...receipt,
        ocr: receiptOcrEvidence(receipt, {
          source: 'gemini-vision',
          modelName,
          verificationModelName,
          modelAttempts,
          verificationStatus,
        }),
      };
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timed out' : 'failed';
      console.warn(`Receipt OCR ${reason} for ${modelName}`);
    }
  }
  return null;
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
  selectBetterReceipt,
  parseReceiptImage,
  parseReceiptTextWithGemini,
};
