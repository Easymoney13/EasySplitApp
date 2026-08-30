import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUEST_PROFILE_BACKUP_KEY,
  clearGuestProfileBackup,
  persistGuestProfile,
  readGuestProfile,
} from '../lib/guestProfile.mjs';

function createStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const profile = {
  displayName: 'Android Smoke',
  avatarColor: '#4DE1A1',
  phoneNumber: '0501234567',
};

test('guest profile survives transient loss of WebView local profile state', () => {
  const local = createStorage({ billsplit_account_scope: 'guest' });
  const session = createStorage();
  persistGuestProfile(local, session, profile);

  local.removeItem('billsplit_local_profile');
  local.removeItem('billsplit_phone');

  assert.deepEqual(readGuestProfile(local, session), {
    ...profile,
    avatarUrl: undefined,
  });
});

test('guest profile backup cannot cross into an authenticated account', () => {
  const local = createStorage({ billsplit_account_scope: 'user:alice' });
  const session = createStorage({
    [GUEST_PROFILE_BACKUP_KEY]: JSON.stringify(profile),
  });

  assert.equal(readGuestProfile(local, session), null);
});

test('local guest profile remains authoritative and supports the legacy phone key', () => {
  const local = createStorage({
    billsplit_account_scope: 'guest',
    billsplit_local_profile: JSON.stringify({ displayName: 'Local Guest', avatarColor: '#123456' }),
    billsplit_phone: '0507654321',
  });
  const session = createStorage({
    [GUEST_PROFILE_BACKUP_KEY]: JSON.stringify(profile),
  });

  assert.deepEqual(readGuestProfile(local, session), {
    displayName: 'Local Guest',
    avatarColor: '#123456',
    avatarUrl: undefined,
    phoneNumber: '0507654321',
  });
});

test('logout/account transition removes the transient guest backup', () => {
  const session = createStorage({
    [GUEST_PROFILE_BACKUP_KEY]: JSON.stringify(profile),
  });
  clearGuestProfileBackup(session);
  assert.equal(session.getItem(GUEST_PROFILE_BACKUP_KEY), null);
});
