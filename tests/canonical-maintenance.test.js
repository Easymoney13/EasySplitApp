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
