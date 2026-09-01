const test = require('node:test');
const assert = require('node:assert/strict');
const { anonymizeAccountInRecord } = require('../lib/accountDeletion');

test('account deletion anonymizes identity while preserving split references', () => {
  const source = {
    id: 'session-1',
    hostName: 'Alice',
    hostPhone: '0501234567',
    members: [
      { id: 'firebase-uid', userId: 'firebase-uid', uid: 'firebase-uid', name: 'Alice', phone: '0501234567', email: 'alice@example.com', avatarUrl: 'https://example.invalid/alice.png', isHost: true, accessTokenHash: 'secret', accessTokenHashes: ['old-secret'], clientIdentityHash: 'device-hash', clientTokenSalt: 'device-salt' },
      { id: 'member_guest', name: 'Bob', phone: '0500000000', isHost: false },
    ],
    memberIds: ['firebase-uid'],
    payerId: 'firebase-uid',
    items: [{ id: 'item-1', claimedBy: ['firebase-uid', 'member_guest'] }],
  };

  const { changed, record } = anonymizeAccountInRecord(source, 'firebase-uid');
  assert.equal(changed, true);
  assert.equal(record.members[0].name, 'Deleted user');
  assert.equal(record.members[0].userId, undefined);
  assert.equal(record.members[0].phone, undefined);
  assert.equal(record.members[0].accessTokenHash, undefined);
  assert.equal(record.members[0].accessTokenHashes, undefined);
  assert.equal(record.members[0].uid, undefined);
  assert.equal(record.members[0].email, undefined);
  assert.equal(record.members[0].avatarUrl, undefined);
  assert.equal(record.members[0].clientIdentityHash, undefined);
  assert.equal(record.members[0].clientTokenSalt, undefined);
  assert.match(record.members[0].id, /^member_deleted_/);
  assert.equal(record.members[0].isHost, false);
  assert.equal(record.members[1].isHost, true);
  assert.equal(record.hostName, 'Deleted user');
  assert.equal(record.hostPhone, '');
  assert.deepEqual(record.memberIds, []);
  assert.equal(record.payerId, record.members[0].id);
  assert.deepEqual(record.items[0].claimedBy, [record.members[0].id, 'member_guest']);
  assert.equal(JSON.stringify(record).includes('firebase-uid'), false);
});

test('account deletion leaves unrelated records unchanged', () => {
  const source = { members: [{ id: 'member_guest', name: 'Bob' }], items: [] };
  const result = anonymizeAccountInRecord(source, 'firebase-uid');
  assert.equal(result.changed, false);
  assert.equal(result.record, source);
});
