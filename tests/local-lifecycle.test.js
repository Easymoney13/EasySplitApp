const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectCachedRoomIds,
  purgeDeletedGroupFromStorage,
  purgeDeletedRoomsFromStatus,
  purgeDeletedSessionFromStorage,
} = require('../lib/localLifecycle');

function storageFixture(initial) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('deleted sessions cannot resurrect from any local history cache', () => {
  const storage = storageFixture({
    billsplit_history: '[{"id":"deleted"},{"id":"kept"}]',
    billsplit_history_alice: '[{"id":"deleted"}]',
    billsplit_active_session: '{"id":"deleted"}',
    billsplit_session_token_deleted: 'deleted-room-secret',
    billsplit_member_deleted: 'member-deleted',
    billsplit_session_invite_deleted: 'deleted-invite',
    billsplit_session_token_12345: 'deleted-room-secret',
    billsplit_member_12345: 'member-deleted',
  });
  purgeDeletedSessionFromStorage(storage, 'deleted');
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_history')), [{ id: 'kept' }]);
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_history_alice')), []);
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_deleted_history_ids')), ['deleted']);
  assert.equal(storage.getItem('billsplit_active_session'), null);
  assert.equal(storage.getItem('billsplit_session_token_deleted'), null);
  assert.equal(storage.getItem('billsplit_session_invite_deleted'), null);
  assert.equal(storage.getItem('billsplit_session_token_12345'), null);
  assert.equal(storage.getItem('billsplit_member_12345'), null);
});

test('deleted groups cannot resurrect from account, legacy, or cookie-shadow caches', () => {
  const storage = storageFixture({
    billsplit_user_groups: '[{"id":"deleted","bills":[{"sessionId":"linked"}]},{"id":"kept"}]',
    billsplit_user_groups_alice: '[{"id":"deleted"}]',
    billsplit_closed_groups: '[{"id":"deleted"},{"id":"closed-kept"}]',
    billsplit_history: '[{"id":"linked","groupId":"deleted"},{"id":"standalone"}]',
    billsplit_group_token_deleted: 'deleted-group-secret',
    billsplit_group_member_deleted: 'group-member',
    billsplit_session_token_linked: 'linked-secret',
    billsplit_member_linked: 'linked-member',
  });
  purgeDeletedGroupFromStorage(storage, 'deleted');
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_user_groups')), [{ id: 'kept' }]);
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_user_groups_alice')), []);
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_closed_groups')), [{ id: 'closed-kept' }]);
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_history')), [{ id: 'standalone' }]);
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_deleted_group_ids')), ['deleted']);
  assert.equal(storage.getItem('billsplit_group_token_deleted'), null);
  assert.equal(storage.getItem('billsplit_group_member_deleted'), null);
  assert.equal(storage.getItem('billsplit_session_token_linked'), null);
  assert.equal(storage.getItem('billsplit_member_linked'), null);
});

test('missed offline lifecycle changes converge from one opaque room-status response', () => {
  const storage = storageFixture({
    billsplit_history_guest: JSON.stringify([
      { id: 'sess_deleted_cache_12345' },
      { id: 'sess_kept_cache_12345', groupId: 'grp_deleted_cache_12345' },
      { id: 'sess_reopened_cache_12345' },
      { id: 'sess_partial_cache_12345' },
    ]),
    billsplit_user_groups_guest: JSON.stringify([
      { id: 'grp_deleted_cache_12345' },
      { id: 'grp_closed_cache_12345', name: 'Offline Dinner' },
    ]),
    billsplit_active_session: JSON.stringify({ id: 'sess_active_deleted_12345' }),
  });
  const cached = collectCachedRoomIds(storage);
  assert.deepEqual(new Set(cached.sessionIds), new Set([
    'sess_deleted_cache_12345',
    'sess_kept_cache_12345',
    'sess_reopened_cache_12345',
    'sess_partial_cache_12345',
    'sess_active_deleted_12345',
  ]));
  assert.deepEqual(new Set(cached.groupIds), new Set(['grp_deleted_cache_12345', 'grp_closed_cache_12345']));

  const purged = purgeDeletedRoomsFromStatus(storage, {
    sessions: {
      sess_deleted_cache_12345: 'deleted',
      sess_kept_cache_12345: 'settled',
      sess_reopened_cache_12345: 'active',
      sess_partial_cache_12345: 'active',
      sess_active_deleted_12345: 'deleted',
    },
    sessionHistoryStates: {
      sess_reopened_cache_12345: 'absent',
      sess_partial_cache_12345: 'present',
    },
    groups: { grp_deleted_cache_12345: 'deleted', grp_closed_cache_12345: 'closed' },
    groupSummaries: {
      grp_closed_cache_12345: { id: 'grp_closed_cache_12345', name: 'Offline Dinner', status: 'closed' },
    },
  });
  assert.deepEqual(purged.deletedSessions, ['sess_deleted_cache_12345', 'sess_active_deleted_12345']);
  assert.deepEqual(purged.deletedGroups, ['grp_deleted_cache_12345']);
  assert.deepEqual(purged.settledSessions, ['sess_kept_cache_12345']);
  assert.deepEqual(purged.reopenedSessions, ['sess_reopened_cache_12345']);
  assert.deepEqual(purged.closedGroups.map((group) => group.id), ['grp_closed_cache_12345']);
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_history_guest')), [{ id: 'sess_partial_cache_12345' }]);
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_user_groups_guest')), []);
  assert.deepEqual(JSON.parse(storage.getItem('billsplit_closed_groups_guest')), [{
    id: 'grp_closed_cache_12345',
    name: 'Offline Dinner',
    status: 'closed',
  }]);
  assert.equal(storage.getItem('billsplit_active_session'), null);
});
