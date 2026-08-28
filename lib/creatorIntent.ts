export const CREATOR_INTENT_KEY = 'easysplit_pending_creator_intent';
export const CREATOR_INTENT_TTL_MS = 10 * 60 * 1000;

export type ReceiptSessionCreatorIntent = {
  type: 'receipt-session';
  createdAt: number;
  billData: {
    storeName: string;
    date?: string;
    currency: string;
    items: any[];
  };
  receiptDraft: any;
  scanId: string;
  recoveryToken: string;
};

export type GroupCreatorIntent = {
  type: 'group';
  createdAt: number;
  groupData: {
    name: string;
    currency: string;
  };
};

export type CreatorIntent = ReceiptSessionCreatorIntent | GroupCreatorIntent;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isCreatorIntent(value: any): value is CreatorIntent {
  if (!value || typeof value !== 'object' || !Number.isFinite(value.createdAt)) return false;
  if (value.type === 'receipt-session') {
    return Boolean(value.billData && typeof value.billData === 'object' && Array.isArray(value.billData.items));
  }
  return value.type === 'group' && Boolean(value.groupData && typeof value.groupData === 'object');
}

export function saveCreatorIntent(storage: StorageLike, intent: CreatorIntent): void {
  storage.setItem(CREATOR_INTENT_KEY, JSON.stringify(intent));
}

export function readCreatorIntent(
  storage: StorageLike,
  now = Date.now(),
): CreatorIntent | null {
  const raw = storage.getItem(CREATOR_INTENT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isCreatorIntent(parsed) || now - parsed.createdAt > CREATOR_INTENT_TTL_MS) {
      storage.removeItem(CREATOR_INTENT_KEY);
      return null;
    }
    return parsed;
  } catch (_) {
    storage.removeItem(CREATOR_INTENT_KEY);
    return null;
  }
}

export function clearCreatorIntent(storage: StorageLike): void {
  storage.removeItem(CREATOR_INTENT_KEY);
}
