const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-account-'));
const dbPath = path.join(tempDir, 'db.json');
process.env.BILLSPLIT_DB_PATH = dbPath;
process.env.NODE_ENV = 'test';

fs.writeFileSync(dbPath, JSON.stringify({
  users: {
    usr_legacy_victim: {
      id: 'usr_legacy_victim',
      username: 'Victim Name',
      phone: '0500000000',
      bills: [{ id: 'private-bill' }],
      groups: ['private-group'],
      settings: { customGeminiKey: 'private-key' },
    },
    attacker: {
      id: 'victim-uid',
      username: 'Attacker',
      bills: [],
      groups: [],
      settings: {},
    },
    'victim-uid': {
      id: 'victim-uid',
      username: 'Real Victim',
      bills: [{ id: 'keep-me' }],
      groups: [],
      settings: {},
    },
  },
  sessions: {},
  history: [],
  groups: {},
}));

const db = require('../lib/db');
const { validateUserSyncBody } = require('../lib/validation');
const { createRoomMember, joinRoom, publicRoom, syncRoomMember } = require('../lib/roomAuth');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('an authenticated user cannot claim a legacy profile by display name', async () => {
  const created = await db.findOrCreateUser('new-firebase-uid', 'Victim Name', '', {});
  const legacy = await db.getUserByUid('usr_legacy_victim');

  assert.equal(created.id, 'new-firebase-uid');
  assert.deepEqual(created.bills, []);
  assert.deepEqual(created.groups, []);
  assert.equal(legacy.id, 'usr_legacy_victim');
  assert.deepEqual(legacy.bills, [{ id: 'private-bill' }]);
});

test('a stored id field cannot redirect a trusted user write to another UID', async () => {
  const attacker = await db.findOrCreateUser('attacker', 'Updated Attacker', '', {});
  const victim = await db.getUserByUid('victim-uid');

  assert.equal(attacker.id, 'attacker');
  assert.equal(victim.username, 'Real Victim');
  assert.deepEqual(victim.bills, [{ id: 'keep-me' }]);
});

test('client-controlled account settings cannot persist unrelated user fields', async () => {
  const user = await db.findOrCreateUser('settings-attacker', 'Settings Attacker', '', {
    language: 'he',
    currency: 'usd',
    theme: 'dark',
    ocrEngine: 'gemini',
    groups: ['private-group'],
    bills: [{ id: 'forged-history' }],
    isAdmin: true,
    nested: { role: 'owner' },
  });

  assert.deepEqual(user.settings, {
    language: 'he',
    currency: 'USD',
    theme: 'dark',
    customGeminiKey: '',
    ocrEngine: 'gemini',
  });
  assert.equal(user.settings.isAdmin, undefined);
  assert.equal(user.settings.groups, undefined);
  assert.equal(user.settings.bills, undefined);
});

test('profile sync accepts only a sanitized phone field alongside approved account fields', () => {
  const clean = validateUserSyncBody({
    username: '  Alice  ',
    phone: '050-123 4567<script>',
    email: 'forged@example.com',
    isAdmin: true,
    settings: { language: 'he' },
  });

  assert.equal(clean.username, 'Alice');
  assert.equal(clean.phone, '0501234567');
  assert.equal(clean.email, undefined);
  assert.equal(clean.isAdmin, undefined);
  assert.deepEqual(clean.settings, { language: 'he' });
});

test('room membership keeps the participant phone current for payment routing', () => {
  const host = createRoomMember({ name: 'Host', phone: '050-111 2233', isHost: true });
  assert.equal(host.member.phone, '0501112233');
  const room = { members: [host.member], items: [] };
  const joined = joinRoom(room, { accessToken: host.accessToken, name: 'Host', phone: '0509998877' });

  assert.equal(joined.member.phone, '0509998877');
  assert.equal(room.members.length, 1);
});

test('public room state strips all payment phone PII', () => {
  const host = createRoomMember({ name: 'Host', phone: '0501112233', isHost: true });
  const guest = createRoomMember({ name: 'Guest', phone: '0509998877' });
  const room = {
    members: [host.member, guest.member],
    payerId: host.member.id,
    hostPhone: host.member.phone,
    minimizedTransactions: [{ fromId: guest.member.id, toId: host.member.id, toPhone: host.member.phone, amount: 20 }],
  };

  const publicState = publicRoom(room);
  assert.equal(publicState.paymentPhone, undefined);
  assert.equal(publicState.hostPhone, undefined);
  assert.equal(publicState.members.every((member) => member.phone === undefined), true);
  assert.equal(publicState.minimizedTransactions[0].toPhone, undefined);
});

test('linked session member synchronization refreshes the payment phone', () => {
  const target = createRoomMember({ name: 'Member', phone: '0501111111' }).member;
  const source = createRoomMember({ name: 'Member', phone: '+972 50-999-8877' }).member;

  syncRoomMember(target, source);
  assert.equal(target.phone, '0509998877');
  assert.equal(target.accessTokenHash, source.accessTokenHash);
});

test('profile sync rejects malformed non-empty phone numbers', () => {
  assert.throws(
    () => validateUserSyncBody({ username: 'Alice', phone: '12345', settings: {} }),
    /valid Israeli mobile number/,
  );
});
