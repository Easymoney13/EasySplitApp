export const LOCAL_PROFILE_KEY = 'billsplit_local_profile';
export const LOCAL_PHONE_KEY = 'billsplit_phone';
export const ACCOUNT_SCOPE_KEY = 'billsplit_account_scope';
export const GUEST_PROFILE_BACKUP_KEY = 'billsplit_guest_profile_backup';

function parseProfile(raw, fallbackPhone = '') {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.displayName) return null;
    return {
      displayName: String(parsed.displayName),
      avatarColor: String(parsed.avatarColor || '#4DE1A1'),
      avatarUrl: typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl : undefined,
      phoneNumber: typeof parsed.phoneNumber === 'string'
        ? parsed.phoneNumber
        : (fallbackPhone || undefined),
    };
  } catch (_) {
    return null;
  }
}

export function readGuestProfile(localStorage, sessionStorage) {
  let localProfile = null;
  try {
    localProfile = parseProfile(
      localStorage?.getItem(LOCAL_PROFILE_KEY),
      localStorage?.getItem(LOCAL_PHONE_KEY) || '',
    );
  } catch (_) {}
  if (localProfile) return localProfile;

  // A session backup is valid only while the browser remains explicitly in
  // guest scope. It must never bridge an authenticated account boundary.
  try {
    if (localStorage?.getItem(ACCOUNT_SCOPE_KEY) !== 'guest') return null;
    return parseProfile(sessionStorage?.getItem(GUEST_PROFILE_BACKUP_KEY));
  } catch (_) {
    return null;
  }
}

export function persistGuestProfile(localStorage, sessionStorage, profile) {
  const serialized = JSON.stringify(profile);
  try {
    localStorage?.setItem(LOCAL_PROFILE_KEY, serialized);
    if (profile?.phoneNumber) localStorage?.setItem(LOCAL_PHONE_KEY, profile.phoneNumber);
  } catch (_) {}
  try {
    sessionStorage?.setItem(GUEST_PROFILE_BACKUP_KEY, serialized);
  } catch (_) {}
}

export function clearGuestProfileBackup(sessionStorage) {
  try {
    sessionStorage?.removeItem(GUEST_PROFILE_BACKUP_KEY);
  } catch (_) {}
}
