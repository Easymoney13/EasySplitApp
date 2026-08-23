const security = require('./security');

class ValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = statusCode;
  }
}

function requireObject(value, label = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label, maxLength = 100) {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string`);
  const clean = security.sanitizeString(value, maxLength);
  if (!clean) throw new ValidationError(`${label} is required`);
  return clean;
}

function optionalString(value, maxLength = 100) {
  return typeof value === 'string' ? security.sanitizeString(value, maxLength) : '';
}

function requirePrice(value, label = 'price') {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 50000) {
    throw new ValidationError(`${label} must be between 0.01 and 50,000`);
  }
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function optionalPercentage(value, label = 'percentage') {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new ValidationError(`${label} must be between 0 and 100`);
  }
  return Math.round(parsed * 100) / 100;
}

const USER_SETTING_VALUES = {
  language: new Set(['en', 'he']),
  currency: new Set(['NIS', 'ILS', 'USD', 'EUR', 'GBP']),
  theme: new Set(['light', 'dark']),
  ocrEngine: new Set(['tesseract', 'gemini']),
};

function sanitizeUserSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = {};
  for (const [field, allowed] of Object.entries(USER_SETTING_VALUES)) {
    if (!Object.prototype.hasOwnProperty.call(value, field) || typeof value[field] !== 'string') continue;
    const normalized = field === 'currency'
      ? optionalString(value[field], 10).toUpperCase()
      : optionalString(value[field], 20).toLowerCase();
    if (allowed.has(normalized)) clean[field] = normalized;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'customGeminiKey') && typeof value.customGeminiKey === 'string') {
    clean.customGeminiKey = optionalString(value.customGeminiKey, 200);
  }
  return clean;
}

function validateUserSyncBody(rawBody) {
  const body = requireObject(rawBody, 'request body');
  return {
    username: optionalString(body.username, 80),
    settings: sanitizeUserSettings(body.settings),
  };
}

function validateItems(items, { allowEmpty = false, maxItems = 250 } = {}) {
  if (!Array.isArray(items)) throw new ValidationError('items must be an array');
  if (!allowEmpty && items.length === 0) throw new ValidationError('At least one item is required');
  if (items.length > maxItems) throw new ValidationError(`A bill cannot contain more than ${maxItems} items`);

  return items.map((rawItem, index) => {
    const item = requireObject(rawItem, `items[${index}]`);
    const claimedBy = Array.isArray(item.claimedBy)
      ? [...new Set(item.claimedBy.filter((id) => typeof id === 'string').map((id) => optionalString(id, 100)).filter(Boolean))].slice(0, 100)
      : [];
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    return {
      id: optionalString(item.id, 100),
      name: requireString(item.name || 'Receipt Item', `items[${index}].name`, 80),
      price: requirePrice(item.price, `items[${index}].price`),
      quantity: Number.isFinite(quantity) && quantity > 0 && quantity <= 1_000
        ? Math.round(quantity * 1000) / 1000
        : 1,
      unitPrice: Number.isFinite(unitPrice) && unitPrice > 0 && unitPrice <= 50_000
        ? Math.round(unitPrice * 100) / 100
        : undefined,
      lineTotal: requirePrice(item.lineTotal ?? item.price, `items[${index}].lineTotal`),
      category: optionalString(item.category || 'Other', 30) || 'Other',
      claimedBy,
    };
  });
}

function validateSessionAction(action, rawPayload) {
  const allowed = new Set([
    'TOGGLE_CLAIM',
    'SPLIT_EVERYONE',
    'ADD_ITEM',
    'EDIT_ITEM',
    'DELETE_ITEM',
    'TOGGLE_SETTLED',
    'SET_TIP',
    'SETTLE_ALL',
    'SET_PAYER',
  ]);
  if (!allowed.has(action)) throw new ValidationError('Unknown session action');
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};

  if (['TOGGLE_CLAIM', 'EDIT_ITEM', 'DELETE_ITEM'].includes(action)) {
    payload.itemId = requireString(payload.itemId, 'itemId', 100);
  }
  if (action === 'ADD_ITEM') payload.itemId = optionalString(payload.itemId, 100);
  if (action === 'TOGGLE_CLAIM' || action === 'TOGGLE_SETTLED') {
    payload.memberId = requireString(payload.memberId, 'memberId', 100);
  }
  if (action === 'ADD_ITEM' || action === 'EDIT_ITEM') {
    payload.name = requireString(payload.name, 'name', 80);
    payload.price = requirePrice(payload.price);
    payload.category = optionalString(payload.category || 'Other', 30) || 'Other';
  }
  if (action === 'SET_TIP') payload.tipPercentage = optionalPercentage(payload.tipPercentage, 'tipPercentage');
  if (action === 'TOGGLE_CLAIM' && payload.claimed !== undefined) payload.claimed = Boolean(payload.claimed);
  if (action === 'TOGGLE_SETTLED' && payload.settled !== undefined) payload.settled = Boolean(payload.settled);
  if (action === 'SET_PAYER') payload.payerId = optionalString(payload.payerId, 100) || 'each';
  return payload;
}

function validateReceiptBody(rawBody) {
  const body = requireObject(rawBody, 'request body');
  const rawImageParts = Array.isArray(body.imageBase64Parts)
    ? body.imageBase64Parts
    : (typeof body.imageBase64 === 'string' ? [body.imageBase64] : []);
  const imageBase64Parts = rawImageParts.filter((value) => typeof value === 'string' && value.length > 0);
  const hasImage = imageBase64Parts.length > 0;
  const hasParsedBill = body.parsedBill && typeof body.parsedBill === 'object';
  const hasRawText = typeof body.rawText === 'string' && body.rawText.length > 0;

  if (!hasImage && !hasParsedBill && !hasRawText) {
    throw new ValidationError('A receipt image, manual bill, or raw OCR text is required');
  }
  if (imageBase64Parts.length > 6) throw new ValidationError('A receipt cannot contain more than 6 image sections');
  const totalImageLength = imageBase64Parts.reduce((sum, value) => sum + value.length, 0);
  if (hasImage && totalImageLength > 10_000_000) throw new ValidationError('Receipt image is too large');
  const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
  const mimeType = optionalString(body.mimeType || 'image/jpeg', 30).toLowerCase();
  if (hasImage && !allowedMimeTypes.has(mimeType)) throw new ValidationError('Unsupported receipt image type');
  const dataUriPattern = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,/i;
  for (const value of imageBase64Parts) {
    const dataUriMatch = value.match(dataUriPattern);
    const partMimeType = dataUriMatch?.[1]?.toLowerCase() || mimeType;
    const payload = dataUriMatch ? value.slice(dataUriMatch[0].length) : value;
    if (!payload || !/^[a-z0-9+/]+={0,2}$/i.test(payload)) {
      throw new ValidationError('Receipt image data is not valid base64');
    }
    const signature = Buffer.from(payload.slice(0, 64), 'base64');
    const isJpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
    const isPng = signature.length >= 8 && signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isWebp = signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP';
    const isHeif = signature.subarray(4, 8).toString('ascii') === 'ftyp';
    const signatureMatches = (partMimeType === 'image/jpeg' && isJpeg)
      || (partMimeType === 'image/png' && isPng)
      || (partMimeType === 'image/webp' && isWebp)
      || (['image/heic', 'image/heif'].includes(partMimeType) && isHeif);
    if (!signatureMatches) throw new ValidationError('Receipt image signature does not match its type');
  }
  if (hasRawText && body.rawText.length > 100_000) throw new ValidationError('Raw OCR text is too large');

  return {
    imageBase64: hasImage ? imageBase64Parts[0] : '',
    imageBase64Parts: hasImage ? imageBase64Parts : [],
    mimeType,
    hostName: optionalString(body.hostName || 'Host', 30) || 'Host',
    parsedBill: hasParsedBill ? body.parsedBill : null,
    customGeminiKey: optionalString(body.customGeminiKey, 200),
    rawText: hasRawText ? body.rawText : '',
    scanId: optionalString(body.scanId, 100),
    recoveryToken: optionalString(body.recoveryToken, 200),
    confirmedByUser: body.confirmedByUser === true,
    imageQuality: body.imageQuality && typeof body.imageQuality === 'object'
      ? {
          width: Number(body.imageQuality.width) || 0,
          height: Number(body.imageQuality.height) || 0,
          meanBrightness: Number(body.imageQuality.meanBrightness) || 0,
          edgeScore: Number(body.imageQuality.edgeScore) || 0,
          warnings: Array.isArray(body.imageQuality.warnings)
            ? body.imageQuality.warnings.filter((value) => typeof value === 'string').slice(0, 10).map((value) => optionalString(value, 40))
            : [],
        }
      : null,
  };
}

module.exports = {
  ValidationError,
  requireObject,
  requireString,
  optionalString,
  requirePrice,
  optionalPercentage,
  sanitizeUserSettings,
  validateUserSyncBody,
  validateItems,
  validateSessionAction,
  validateReceiptBody,
};
