// This version changes when the disclosed recipients, data, or purposes change.
const RECEIPT_CLOUD_CONSENT_VERSION = '2026-09-08';
const RECEIPT_CLOUD_CONSENT_KEY = 'billsplit_receipt_cloud_consent';

function isValidReceiptCloudConsent(value, version = RECEIPT_CLOUD_CONSENT_VERSION) {
  return Boolean(value && value.accepted === true && value.version === version
    && typeof value.acceptedAt === 'string' && Number.isFinite(Date.parse(value.acceptedAt)));
}

class ReceiptCloudConsentDeclinedError extends Error {
  constructor(manualEntry = false) {
    super('Receipt cloud processing was not authorized');
    this.name = 'ReceiptCloudConsentDeclinedError';
    this.code = 'RECEIPT_CLOUD_CONSENT_DECLINED';
    this.manualEntry = manualEntry;
  }
}

function isReceiptCloudConsentDeclined(error) {
  return error?.code === 'RECEIPT_CLOUD_CONSENT_DECLINED';
}

/** Consent belongs to this browser/app installation, not to a server-side account. */
function createReceiptConsentManager({
  getStorage = () => (typeof window === 'undefined' ? null : window.localStorage),
  version = RECEIPT_CLOUD_CONSENT_VERSION,
  now = () => new Date().toISOString(),
} = {}) {
  let prompt = null;
  let pending = null;
  let memoryConsent = null;
  let revision = 0;
  let storageWriteFailed = false;
  let revoked = false;

  function current() {
    if (revoked) return null;
    let value;
    try {
      const storage = getStorage();
      value = storage && !storageWriteFailed ? JSON.parse(storage.getItem(RECEIPT_CLOUD_CONSENT_KEY) || 'null') : memoryConsent;
    } catch (_) {
      value = memoryConsent;
    }
    return isValidReceiptCloudConsent(value, version) ? value : null;
  }

  function revoke() {
    revision += 1;
    revoked = true;
    memoryConsent = null;
    try { getStorage()?.removeItem(RECEIPT_CLOUD_CONSENT_KEY); } catch (_) { /* memory cleared */ }
  }

  function registerPrompt(nextPrompt) {
    prompt = nextPrompt;
    return () => { if (prompt === nextPrompt) prompt = null; };
  }

  async function requireConsent() {
    const saved = current();
    if (saved) return saved;
    if (pending) return pending;
    if (!prompt) throw new ReceiptCloudConsentDeclinedError();
    const startedRevision = revision;
    const ask = prompt;
    pending = (async () => {
      const decision = await ask();
      if (decision !== 'accept' || startedRevision !== revision) {
        throw new ReceiptCloudConsentDeclinedError(decision === 'manual');
      }
      const consent = { accepted: true, version, acceptedAt: now() };
      revoked = false;
      memoryConsent = consent;
      try {
        getStorage()?.setItem(RECEIPT_CLOUD_CONSENT_KEY, JSON.stringify(consent));
        storageWriteFailed = false;
      } catch (_) {
        storageWriteFailed = true; // Explicit consent remains valid for this page only.
      }
      return consent;
    })();
    try { return await pending; } finally { pending = null; }
  }

  function assertCurrent(consent) {
    const saved = current();
    if (!saved || !consent || saved.version !== consent.version || saved.acceptedAt !== consent.acceptedAt) {
      throw new ReceiptCloudConsentDeclinedError();
    }
  }

  return { current, requireConsent, registerPrompt, revoke, assertCurrent };
}

const receiptConsent = createReceiptConsentManager();

module.exports = {
  RECEIPT_CLOUD_CONSENT_VERSION,
  RECEIPT_CLOUD_CONSENT_KEY,
  isValidReceiptCloudConsent,
  ReceiptCloudConsentDeclinedError,
  isReceiptCloudConsentDeclined,
  createReceiptConsentManager,
  receiptConsent,
};
