const ACCOUNT_SCOPE_KEY = 'billsplit_account_scope';

const ACCOUNT_SCOPED_STORAGE_KEYS = new Set([
  'billsplit_active_session',
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
  'billsplit_history_',
  'billsplit_member_',
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

module.exports = {
  ACCOUNT_SCOPE_KEY,
  clearAccountScopedStorage,
  isAccountScopedStorageKey,
  normalizeAccountScope,
  transitionAccountScope,
};
