const test = require('node:test');
const assert = require('node:assert/strict');
const { refactorDatabase } = require('../lib/canonicalEngine');
const { canonicalMode } = require('../scripts/canonicalize-database');

function fixture(beforeTransaction = () => {}) {
  const data = {
    sessions: { s: { members: [{ id: 'm', userId: 'u', name: 'Same Name', phone: '' }], restaurant: { printedName: 'Cafe Northem' } } },
    groups: { g: { members: [{ id: 'm', phone: '+972501234567' }], bills: [{ id: 'b', storeName: 'Cafe Northem', items: [{ claimedBy: [] }] }] } },
    users: { u: { username: 'Same Name', phone: '0501234567' }, wrong: { username: 'Same Name', phone: '0507654321' } },
    restaurants: { r: { printedName: 'Cafe Northern' } },
  };
  let writes = 0;
  const snapshot = (id, value) => ({ id, exists: !!value, data: () => structuredClone(value) });
  const firestore = {
    collection(name) { return {
      get: async () => ({ forEach: fn => Object.entries(data[name]).forEach(([id, value]) => fn(snapshot(id, value))) }),
      doc: id => ({ name, id }),
    }; },
    async runTransaction(fn) {
      beforeTransaction(data);
      return fn({
        get: async ref => snapshot(ref.id, data[ref.name][ref.id]),
        update(ref, patch) { writes++; Object.assign(data[ref.name][ref.id], structuredClone(patch)); },
      });
    },
  };
  return { data, firestore, writes: () => writes };
}

test('maintenance defaults to a preview and CLI requires explicit apply', async () => {
  const f = fixture();
  const before = structuredClone(f.data);
  assert.equal((await refactorDatabase(f.firestore)).dryRun, true);
  assert.equal(f.writes(), 0);
  assert.deepEqual(f.data, before);
  assert.deepEqual(canonicalMode([]), { dryRun: true });
  assert.deepEqual(canonicalMode(['--apply']), { dryRun: false });
  assert.throws(() => canonicalMode(['--apply', '--dry-run']));
});

test('maintenance preserves concurrent joins and item claims and reads current UID phone', async () => {
  const f = fixture(data => {
    if (!data.sessions.s.members.some(m => m.id === 'new')) data.sessions.s.members.push({ id: 'new', name: 'Same Name', phone: '' });
    data.groups.g.bills[0].items[0].claimedBy = ['new'];
    data.users.u.phone = '0509999999';
  });
  await refactorDatabase(f.firestore, { dryRun: false });
  assert.equal(f.data.sessions.s.members.length, 2);
  assert.equal(f.data.sessions.s.members[0].phone, '0509999999');
  assert.equal(f.data.sessions.s.members[1].phone, '');
  assert.deepEqual(f.data.groups.g.bills[0].items[0].claimedBy, ['new']);
  assert.equal(f.data.sessions.s.restaurant.printedName, 'Cafe Northem');
  assert.equal(f.data.groups.g.bills[0].storeName, 'Cafe Northem');
});

test('maintenance does not resurrect deleted rooms or apply without transactions', async () => {
  const f = fixture(data => { delete data.sessions.s; data.groups.g.status = 'deleting'; });
  await refactorDatabase(f.firestore, { dryRun: false });
  assert.equal(f.writes(), 0);
  await assert.rejects(refactorDatabase({ collection() { assert.fail(); } }, { dryRun: false }), /transactions/);
});

test('maintenance preserves a concurrent payment and is idempotent after phone normalization', async () => {
  const f = fixture(data => {
    data.sessions.s.status = 'settled';
    data.sessions.s.payerId = 'm';
    data.sessions.s.tipPercentage = 17;
    data.sessions.s.members[0].settled = true;
    data.groups.g.bills[0].status = 'settled';
    data.groups.g.bills[0].paidAt = 123456789;
  });
  await refactorDatabase(f.firestore, { dryRun: false });
  assert.equal(f.data.sessions.s.status, 'settled');
  assert.equal(f.data.sessions.s.payerId, 'm');
  assert.equal(f.data.sessions.s.tipPercentage, 17);
  assert.equal(f.data.sessions.s.members[0].settled, true);
  assert.equal(f.data.groups.g.bills[0].status, 'settled');
  assert.equal(f.data.groups.g.bills[0].paidAt, 123456789);
  const afterFirstRun = structuredClone(f.data);
  const writesAfterFirstRun = f.writes();
  await refactorDatabase(f.firestore, { dryRun: false });
  assert.deepEqual(f.data, afterFirstRun);
  assert.equal(f.writes(), writesAfterFirstRun);
});

test('an unmatched explicit UID never borrows a same-name account phone', async () => {
  const f = fixture();
  f.data.sessions.s.members[0].userId = 'not-a-registered-account';
  await refactorDatabase(f.firestore, { dryRun: false });
  assert.equal(f.data.sessions.s.members[0].phone, '');
  assert.equal(f.data.sessions.s.members[0].userId, 'not-a-registered-account');
});
