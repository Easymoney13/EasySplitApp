const ACCOUNT_SCOPE_KEY = 'billsplit_account_scope';
const GUEST_MIGRATION_KEY = 'billsplit_guest_account_migration';
const GUEST_MIGRATION_TTL_MS = 5 * 60 * 1000;

const ACCOUNT_SCOPED_STORAGE_KEYS = new Set([
  'billsplit_active_session',
  'billsplit_closed_groups',
  'billsplit_deleted_group_ids',
  'billsplit_deleted_history_ids',
  'billsplit_history',
  'billsplit_local_profile',
  'billsplit_phone',
  'billsplit_user_groups',
]);

const ACCOUNT_SCOPED_STORAGE_PREFIXES = [
  'billsplit_group_member_',
  'billsplit_group_token_',
  'billsplit_closed_groups_',
  'billsplit_history_',
  'billsplit_member_',
  'billsplit_session_invite_',
  'billsplit_session_token_',
  'billsplit_user_groups_',
];

function normalizeAccountScope(uid) {
  const cleanUid = typeof uid === 'string' ? uid.trim() : '';
  return cleanUid ? `user:${cleanUid}` : 'guest';
}

function isAccountScopedStorageKey(key) {
  return ACCOUNT_SCOPED_STORAGE_KEYS.has(key)
    || ACCOUNT_SCOPED_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function storageKeys(storage) {
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (typeof key === 'string') keys.push(key);
  }
  return keys;
}

function clearAccountScopedStorage(storage, { clearScope = true } = {}) {
  if (!storage) return [];
  const removed = [];
  for (const key of storageKeys(storage)) {
    if (!isAccountScopedStorageKey(key)) continue;
    storage.removeItem(key);
    removed.push(key);
  }
  if (clearScope) storage.removeItem(ACCOUNT_SCOPE_KEY);
  return removed;
}

function transitionAccountScope(storage, uid) {
  const nextScope = normalizeAccountScope(uid);
  const previousScope = storage?.getItem(ACCOUNT_SCOPE_KEY) || '';
  // On the first authenticated rollout, legacy cache ownership is unknowable.
  // Clear it once rather than assigning another account's capabilities/data to
  // the newly signed-in UID. Guest-only legacy state remains usable.
  const changed = previousScope
    ? previousScope !== nextScope
    : nextScope !== 'guest';
  const removed = changed
    ? clearAccountScopedStorage(storage, { clearScope: false })
    : [];
  storage?.setItem(ACCOUNT_SCOPE_KEY, nextScope);
  return { changed, previousScope, nextScope, removed };
}

function prepareGuestAccountMigration(storage, handoffStorage, now = Date.now()) {
  if (!storage || !handoffStorage || storage.getItem(ACCOUNT_SCOPE_KEY) !== 'guest') return false;
  const entries = {};
  for (const key of storageKeys(storage)) {
    if (!isAccountScopedStorageKey(key)) continue;
    const value = storage.getItem(key);
    if (value !== null) entries[key] = value;
  }
  if (!Object.keys(entries).some((key) => (
    key.startsWith('billsplit_session_token_') || key.startsWith('billsplit_group_token_')
  ))) return false;
  try {
    handoffStorage.setItem(GUEST_MIGRATION_KEY, JSON.stringify({
      version: 1,
      sourceScope: 'guest',
      createdAt: now,
      expiresAt: now + GUEST_MIGRATION_TTL_MS,
      entries,
    }));
    return true;
  } catch (_) {
    handoffStorage.removeItem(GUEST_MIGRATION_KEY);
    return false;
  }
}

function consumeGuestAccountMigration(storage, handoffStorage, previousScope, uid, now = Date.now()) {
  if (!storage || !handoffStorage || previousScope !== 'guest' || !normalizeAccountScope(uid).startsWith('user:')) return [];
  const raw = handoffStorage.getItem(GUEST_MIGRATION_KEY);
  handoffStorage.removeItem(GUEST_MIGRATION_KEY);
  if (!raw) return [];
  try {
    const handoff = JSON.parse(raw);
    if (handoff?.version !== 1
      || handoff.sourceScope !== 'guest'
      || Number(handoff.createdAt || 0) > now
      || Number(handoff.expiresAt || 0) < now
      || !handoff.entries
      || typeof handoff.entries !== 'object') return [];
    const restored = [];
    for (const [key, value] of Object.entries(handoff.entries)) {
      if (!isAccountScopedStorageKey(key) || typeof value !== 'string') continue;
      storage.setItem(key, value);
      restored.push(key);
    }
    return restored;
  } catch (_) {
    return [];
  }
}

function clearGuestAccountMigration(handoffStorage) {
  handoffStorage?.removeItem(GUEST_MIGRATION_KEY);
}

module.exports = {
  ACCOUNT_SCOPE_KEY,
  GUEST_MIGRATION_KEY,
  clearAccountScopedStorage,
  clearGuestAccountMigration,
  consumeGuestAccountMigration,
  isAccountScopedStorageKey,
  normalizeAccountScope,
  prepareGuestAccountMigration,
  transitionAccountScope,
};
