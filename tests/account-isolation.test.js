const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACCOUNT_SCOPE_KEY,
  GUEST_MIGRATION_KEY,
  clearAccountScopedStorage,
  clearGuestAccountMigration,
  consumeGuestAccountMigration,
  prepareGuestAccountMigration,
  transitionAccountScope,
} = require('../lib/accountIsolation');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('account switching removes room capabilities and financial caches', () => {
  const storage = createStorage({
    [ACCOUNT_SCOPE_KEY]: 'user:alice',
    billsplit_session_token_sess_1: 'session-secret',
    billsplit_session_invite_sess_1: 'signed-invite-secret',
    billsplit_group_token_grp_1: 'group-secret',
    billsplit_member_sess_1: 'alice',
    billsplit_group_member_grp_1: 'alice',
    billsplit_history: '[{"id":"private-history"}]',
    billsplit_closed_groups: '[{"id":"private-closed-group"}]',
    billsplit_history_alice: '[{"id":"private-history"}]',
    billsplit_user_groups: '[{"id":"private-group"}]',
    billsplit_user_groups_alice: '[{"id":"private-group"}]',
    billsplit_deleted_history_ids: '["hidden-history"]',
    billsplit_deleted_group_ids: '["hidden-group"]',
    billsplit_active_session: '{"id":"sess_1"}',
    billsplit_local_profile: '{"displayName":"Alice"}',
    billsplit_phone: '0500000000',
    billsplit_lang: 'he',
    billsplit_currency: 'NIS',
    billsplit_theme: 'dark',
  });

  const result = transitionAccountScope(storage, 'bob');
  assert.equal(result.changed, true);
  assert.equal(storage.getItem(ACCOUNT_SCOPE_KEY), 'user:bob');
  for (const key of [
    'billsplit_session_token_sess_1', 'billsplit_session_invite_sess_1', 'billsplit_group_token_grp_1',
    'billsplit_member_sess_1', 'billsplit_group_member_grp_1',
    'billsplit_history', 'billsplit_history_alice', 'billsplit_closed_groups',
    'billsplit_user_groups', 'billsplit_user_groups_alice',
    'billsplit_deleted_history_ids', 'billsplit_deleted_group_ids',
    'billsplit_active_session', 'billsplit_local_profile', 'billsplit_phone',
  ]) assert.equal(storage.getItem(key), null, key);
  assert.equal(storage.getItem('billsplit_lang'), 'he');
  assert.equal(storage.getItem('billsplit_currency'), 'NIS');
  assert.equal(storage.getItem('billsplit_theme'), 'dark');
});

test('same-account and same-guest transitions preserve legitimate local state', () => {
  const accountStorage = createStorage({
    [ACCOUNT_SCOPE_KEY]: 'user:alice',
    billsplit_group_token_grp_1: 'group-secret',
  });
  const guestStorage = createStorage({
    [ACCOUNT_SCOPE_KEY]: 'guest',
    billsplit_session_token_sess_guest: 'guest-secret',
  });
  assert.equal(transitionAccountScope(accountStorage, 'alice').changed, false);
  assert.equal(accountStorage.getItem('billsplit_group_token_grp_1'), 'group-secret');
  assert.equal(transitionAccountScope(guestStorage, '').changed, false);
  assert.equal(guestStorage.getItem('billsplit_session_token_sess_guest'), 'guest-secret');
});

test('logout cleanup removes account state and scope while retaining preferences', () => {
  const storage = createStorage({
    [ACCOUNT_SCOPE_KEY]: 'user:alice',
    billsplit_group_token_grp_1: 'group-secret',
    billsplit_history: '[{"id":"history"}]',
    billsplit_user_groups: '[{"id":"group"}]',
    billsplit_lang: 'en',
  });
  clearAccountScopedStorage(storage);
  assert.equal(storage.getItem(ACCOUNT_SCOPE_KEY), null);
  assert.equal(storage.getItem('billsplit_group_token_grp_1'), null);
  assert.equal(storage.getItem('billsplit_history'), null);
  assert.equal(storage.getItem('billsplit_user_groups'), null);
  assert.equal(storage.getItem('billsplit_lang'), 'en');
});

test('final logout cleanup removes state written while sign-out was pending', () => {
  const storage = createStorage({
    [ACCOUNT_SCOPE_KEY]: 'user:alice',
    billsplit_history: '[{"id":"initial-history"}]',
  });
  clearAccountScopedStorage(storage);
  storage.setItem('billsplit_history', '[{"id":"late-history"}]');
  storage.setItem('billsplit_group_token_grp_1', 'late-room-secret');
  clearAccountScopedStorage(storage);
  assert.equal(storage.getItem('billsplit_history'), null);
  assert.equal(storage.getItem('billsplit_group_token_grp_1'), null);
});

test('moving between guest and authenticated scopes clears prior identity state', () => {
  const guestStorage = createStorage({
    [ACCOUNT_SCOPE_KEY]: 'guest',
    billsplit_session_token_sess_guest: 'guest-secret',
  });
  const accountStorage = createStorage({
    [ACCOUNT_SCOPE_KEY]: 'user:alice',
    billsplit_group_token_grp_1: 'alice-secret',
  });
  assert.equal(transitionAccountScope(guestStorage, 'alice').changed, true);
  assert.equal(guestStorage.getItem('billsplit_session_token_sess_guest'), null);
  assert.equal(transitionAccountScope(accountStorage, '').changed, true);
  assert.equal(accountStorage.getItem('billsplit_group_token_grp_1'), null);
});

test('first authenticated rollout clears ambiguous legacy account state', () => {
  const storage = createStorage({
    billsplit_session_token_sess_1: 'alice-session-secret',
    billsplit_member_sess_1: 'alice-member',
    billsplit_history: '[{"id":"alice-private-history"}]',
    billsplit_user_groups: '[{"id":"alice-private-group"}]',
    billsplit_local_profile: '{"displayName":"Alice"}',
  });
  const result = transitionAccountScope(storage, 'bob');
  assert.equal(result.previousScope, '');
  assert.equal(result.changed, true);
  assert.equal(storage.getItem(ACCOUNT_SCOPE_KEY), 'user:bob');
  assert.equal(storage.getItem('billsplit_session_token_sess_1'), null);
  assert.equal(storage.getItem('billsplit_member_sess_1'), null);
  assert.equal(storage.getItem('billsplit_history'), null);
  assert.equal(storage.getItem('billsplit_user_groups'), null);
  assert.equal(storage.getItem('billsplit_local_profile'), null);
});

test('first guest rollout preserves ambiguous legacy guest data', () => {
  const storage = createStorage({
    billsplit_session_token_sess_guest: 'guest-session-secret',
    billsplit_member_sess_guest: 'guest-member',
  });
  const result = transitionAccountScope(storage, '');
  assert.equal(result.previousScope, '');
  assert.equal(result.changed, false);
  assert.equal(storage.getItem(ACCOUNT_SCOPE_KEY), 'guest');
  assert.equal(storage.getItem('billsplit_session_token_sess_guest'), 'guest-session-secret');
});

test('an explicit guest-to-Google handoff preserves token-proven room identity once', () => {
  const local = createStorage({
    [ACCOUNT_SCOPE_KEY]: 'guest',
    billsplit_session_token_sess_guest: 'guest-session-secret',
    billsplit_member_sess_guest: 'member_guest',
    billsplit_active_session: '{"id":"sess_guest"}',
    billsplit_local_profile: '{"displayName":"Guest","phoneNumber":"0501111111"}',
  });
  const handoff = createStorage();
  assert.equal(prepareGuestAccountMigration(local, handoff, 1_000), true);
  assert.ok(handoff.getItem(GUEST_MIGRATION_KEY));

  const transition = transitionAccountScope(local, 'google-a');
  assert.equal(local.getItem('billsplit_session_token_sess_guest'), null);
  const restored = consumeGuestAccountMigration(local, handoff, transition.previousScope, 'google-a', 2_000);
  assert.ok(restored.includes('billsplit_session_token_sess_guest'));
  assert.equal(local.getItem('billsplit_session_token_sess_guest'), 'guest-session-secret');
  assert.equal(local.getItem(ACCOUNT_SCOPE_KEY), 'user:google-a');
  assert.equal(handoff.getItem(GUEST_MIGRATION_KEY), null);
  assert.deepEqual(consumeGuestAccountMigration(local, handoff, 'guest', 'google-a', 2_001), []);
});

test('guest handoffs expire and never apply to account-to-account switches', () => {
  const local = createStorage({
    [ACCOUNT_SCOPE_KEY]: 'guest',
    billsplit_group_token_grp_guest: 'guest-group-secret',
  });
  const expiredHandoff = createStorage();
  assert.equal(prepareGuestAccountMigration(local, expiredHandoff, 1_000), true);
  transitionAccountScope(local, 'google-a');
  assert.deepEqual(consumeGuestAccountMigration(local, expiredHandoff, 'guest', 'google-a', 1_000 + 5 * 60_000 + 1), []);
  assert.equal(local.getItem('billsplit_group_token_grp_guest'), null);

  const switchHandoff = createStorage({
    [GUEST_MIGRATION_KEY]: JSON.stringify({
      version: 1,
      sourceScope: 'guest',
      createdAt: 1_000,
      expiresAt: 10_000,
      entries: { billsplit_group_token_grp_guest: 'must-not-transfer' },
    }),
  });
  assert.deepEqual(consumeGuestAccountMigration(local, switchHandoff, 'user:google-a', 'google-b', 2_000), []);
  clearGuestAccountMigration(switchHandoff);
  assert.equal(switchHandoff.getItem(GUEST_MIGRATION_KEY), null);
});
