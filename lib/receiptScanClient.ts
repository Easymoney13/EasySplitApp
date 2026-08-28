import { prepareReceiptImages, type ReceiptImageQuality } from './imageUtils';
import { scanBillImagesInBrowser } from './ocrScanner';
import { apiUrl } from './platformTransport';

export interface ReceiptDraftResult {
  receipt: any;
  scanId: string;
  recoveryToken: string;
  imageQuality: ReceiptImageQuality;
  previewImages: string[];
  usedLocalFallback: boolean;
}

export function receiptScanUserMessage(
  translate: (key: string, params?: Record<string, any>, fallback?: string) => string,
): string {
  return translate(
    'couldNotParse',
    undefined,
    'Could not read this receipt reliably. Please retake a clear, well-lit photo or enter the items manually.',
  );
}

function createScanId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `scan_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function createRecoveryToken(): string {
  const first = createScanId();
  const second = createScanId();
  return `recovery_${first}_${second}`;
}

async function readJsonSafely(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}

/**
 * Parse a receipt into a draft only. A caller must show the existing bill
 * editor and obtain an explicit user confirmation before creating a session.
 */
export async function createReceiptDraft(
  fileOrBase64: File | string,
  hostName = 'Host',
): Promise<ReceiptDraftResult> {
  const prepared = await prepareReceiptImages(fileOrBase64);
  const scanId = createScanId();
  const recoveryToken = createRecoveryToken();
  const controller = new AbortController();
  const encodedBytes = prepared.images.reduce((sum, image) => sum + image.length, 0);
  const uploadBudgetMs = Math.ceil(encodedBytes / (200 * 1024)) * 1_000;
  const requestBudgetMs = Math.min(45_000, Math.max(20_000, uploadBudgetMs + 15_000));
  const timeout = setTimeout(() => controller.abort(), requestBudgetMs);
  let serverError = '';

  try {
    const response = await fetch(apiUrl('/api/receipt/parse'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        imageBase64Parts: prepared.images,
        mimeType: prepared.mimeType,
        imageQuality: prepared.quality,
        hostName,
        scanId,
        recoveryToken,
      }),
    });
    const data = await readJsonSafely(response);
    if (response.ok && data.success && data.receipt?.items?.length) {
      return {
        receipt: data.receipt,
        scanId,
        recoveryToken,
        imageQuality: prepared.quality,
        previewImages: prepared.images,
        usedLocalFallback: false,
      };
    }
    if (response.status === 429 || response.status === 401) {
      throw new Error(data.error || 'Scan limit reached or authentication required');
    }
    serverError = data.error || 'Could not read the receipt image';
  } catch (error) {
    if (error instanceof Error && (error.message.includes('limit') || error.message.includes('sign in') || error.message.includes('Authentication'))) {
      throw error;
    }
    serverError = error instanceof Error && error.name === 'AbortError'
      ? 'Receipt scan timed out'
      : 'Receipt scan is temporarily unavailable';
  } finally {
    clearTimeout(timeout);
  }

  // A local OCR result is a draft only. It never becomes an active bill until
  // the user reviews every row in the existing manual bill editor.
  const localDraft = await scanBillImagesInBrowser(prepared.fallbackImages, 18_000);
  if (localDraft?.items?.length) {
    return {
      receipt: {
        ...localDraft,
        reconciliation: { status: 'unverified_fallback', needsReview: true },
        assessment: { level: 'high', requiresUserConfirmation: true, reasons: ['local-ocr-fallback'] },
        ocr: {
          ...(localDraft.ocr || {}),
          source: 'client-tesseract',
          verificationStatus: 'manual-review-required',
        },
      },
      scanId,
      recoveryToken,
      imageQuality: prepared.quality,
      previewImages: prepared.images,
      usedLocalFallback: true,
    };
  }

  throw new Error(serverError);
}

export function receiptConfirmationPayload(receipt: any) {
  if (!receipt || typeof receipt !== 'object') return {};
  return {
    date: typeof receipt.date === 'string' ? receipt.date : '',
    receiptTotal: receipt.receiptTotal ?? null,
    subtotal: receipt.subtotal ?? null,
    tax: receipt.tax ?? null,
    service: receipt.service ?? null,
    discount: receipt.discount ?? null,
    ocr: receipt.ocr || null,
    assessment: receipt.assessment || null,
    imageQuality: receipt.imageQuality || null,
    inputDigest: typeof receipt.inputDigest === 'string' ? receipt.inputDigest : '',
  };
}
