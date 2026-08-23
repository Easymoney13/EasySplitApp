function normalizeAmount(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function normalizeDiscount(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round((Math.abs(parsed) + Number.EPSILON) * 100) / 100;
}

function reconcileReceipt(receipt) {
  const itemTotal = Math.round(
    (Array.isArray(receipt?.items) ? receipt.items : [])
      .reduce((sum, item) => sum + (normalizeAmount(item?.price) || 0), 0) * 100
  ) / 100;
  const receiptTotal = normalizeAmount(receipt?.receiptTotal ?? receipt?.total);
  const subtotal = normalizeAmount(receipt?.subtotal);
  const tax = normalizeAmount(receipt?.tax) || 0;
  const service = normalizeAmount(receipt?.service) || 0;
  const discount = normalizeDiscount(receipt?.discount) || 0;
  // VAT is included in displayed menu prices in many countries (including
  // Israel), while other receipts add tax after the subtotal. Arithmetic alone
  // cannot prove which interpretation is correct: a missing item can easily be
  // mistaken for tax or service. Therefore adjustments are trusted only when a
  // printed subtotal independently anchors the sum of the item rows.
  const candidateTotals = [
    { mode: 'items', value: itemTotal },
    { mode: 'items_plus_service', value: itemTotal + service },
    { mode: 'items_plus_tax', value: itemTotal + tax },
    { mode: 'items_plus_tax_service', value: itemTotal + tax + service },
    { mode: 'items_minus_discount', value: itemTotal - discount },
    { mode: 'items_plus_service_minus_discount', value: itemTotal + service - discount },
    { mode: 'items_plus_tax_minus_discount', value: itemTotal + tax - discount },
    { mode: 'items_plus_tax_service_minus_discount', value: itemTotal + tax + service - discount },
  ].map((candidate) => ({
    ...candidate,
    value: Math.round(candidate.value * 100) / 100,
  }));
  const selectedCandidate = receiptTotal === null
    ? candidateTotals[candidateTotals.length - 1]
    : candidateTotals.reduce((best, candidate) => (
      Math.abs(candidate.value - receiptTotal) < Math.abs(best.value - receiptTotal) ? candidate : best
    ));
  const calculatedTotal = selectedCandidate.value;
  const totalDifference = receiptTotal === null
    ? null
    : Math.round(Math.abs(calculatedTotal - receiptTotal) * 100) / 100;
  const subtotalDifference = subtotal === null
    ? null
    : Math.round(Math.abs(itemTotal - subtotal) * 100) / 100;
  // Receipt arithmetic is currency arithmetic. A percentage tolerance would
  // accept larger and larger missing amounts on expensive bills, so allow
  // only a small fixed rounding delta.
  const totalTolerance = receiptTotal === null ? 0 : 0.05;
  const subtotalTolerance = subtotal === null ? 0 : 0.05;
  const totalMatches = totalDifference === null || totalDifference <= totalTolerance;
  const subtotalMatches = subtotalDifference === null || subtotalDifference <= subtotalTolerance;
  const itemsOnlyCandidate = candidateTotals[0];
  const itemsOnlyDifference = receiptTotal === null
    ? null
    : Math.round(Math.abs(itemsOnlyCandidate.value - receiptTotal) * 100) / 100;
  const itemsOnlyMatches = itemsOnlyDifference !== null && itemsOnlyDifference <= totalTolerance;
  const hasAdjustments = tax > 0 || service > 0 || discount > 0;
  const adjustmentsAreAnchored = hasAdjustments && subtotal !== null && subtotalMatches;

  let status = 'mismatch';
  if (receiptTotal === null) {
    status = 'missing_total';
  } else if (itemsOnlyMatches && subtotalMatches) {
    status = 'matched';
  } else if (totalMatches && adjustmentsAreAnchored) {
    status = 'matched_adjusted';
  } else if (totalMatches && hasAdjustments) {
    status = 'ambiguous_adjustments';
  }
  const needsReview = !['matched', 'matched_adjusted'].includes(status);

  return {
    status,
    itemTotal,
    calculatedTotal,
    receiptTotal,
    subtotal,
    tax,
    service,
    discount,
    calculationMode: selectedCandidate.mode,
    difference: totalDifference,
    itemsOnlyDifference,
    subtotalDifference,
    adjustmentsAreAnchored,
    needsReview,
  };
}

function getReceiptPayableTotal(receipt) {
  const reconciliation = receipt?.reconciliation || reconcileReceipt(receipt);
  if (reconciliation.status === 'matched_adjusted' && reconciliation.receiptTotal !== null) {
    return reconciliation.receiptTotal;
  }
  return reconciliation.itemTotal;
}

function isTotalOrTaxLine(name) {
  if (typeof name !== 'string') return false;
  const clean = name
    .toLowerCase()
    .replace(/["“״”`׳]/g, '')
    .replace(/[\-–—:;=_\/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const rate = '\\d+(?:[.,]\\d+)?\\s*%?';
  const englishLabel = '(?:total|subtotal|grand total|balance due|amount due|total due|final total|bill total|check total|net total|tax|vat|sales tax|discount(?: coupon| member| club| loyalty| promotion)?|(?:member|club|loyalty|coupon|promo(?:tional)?) discount|coupon|credit|service(?: charge| fee)?|tip(?: amount)?|gratuity|cash|cash paid|change due|amount paid|tendered|visa|mastercard|amex|credit card|debit card)';
  const hebrewLabel = '(?:לתשלום|סהכ|סה כ|סחכ|סך הכל|סכהכל|סחיכ|סהיק|סהכ חשבון|סה כ חשבון|סהכ פריטים|סה כ פריטים|סיכום|סיכום פריטים|יתרה|סכ הכל חשבון|סך הכל חשבון|סך חשבון|סכום כולל|סך הכול|סך הכול לתשלום|סכום לתשלום|סך לתשלום|חשבון לתשלום|חשבון סופי|סהכ בשח|סה כ בשח|סהכ מחיר|סה כ מחיר|סהכ סופי|סה כ סופי|סהכ לתשלום|סה כ לתשלום|מעמ|שירות|דמי שירות|טיפ|תשר|הנחה|הנחת (?:מועדון|חבר|קופון|מבצע)|זיכוי|שובר|קופון(?: הנחה)?|מבצע|מזומן|כרטיס אשראי|אשראי|עודף|סכום ששולם|חשבון מס|חשבונית מס)';
  const english = new RegExp(`^(?:${englishLabel}(?:\\s+${rate})?|${rate}\\s+${englishLabel})$`);
  const hebrew = new RegExp(`^(?:${hebrewLabel}(?:\\s+${rate})?|${rate}\\s+${hebrewLabel})$`);
  return english.test(clean) || hebrew.test(clean);
}

module.exports = { normalizeAmount, normalizeDiscount, reconcileReceipt, getReceiptPayableTotal, isTotalOrTaxLine };
