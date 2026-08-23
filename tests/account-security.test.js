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
