const test = require('node:test');
const assert = require('node:assert/strict');
const { processSessionAction } = require('../lib/sessionActions');
const { anonymizeAccountInRecord } = require('../lib/accountDeletion');
const { calculateDebtMinimization } = require('../lib/debtMinimizer');

function session() {
  return anonymizeAccountInRecord({
    id: 's1', status: 'active', tipPercentage: 10, payerId: 'host',
    members: [
      { id: 'deleted', userId: 'deleted', name: 'Alice', active: true, settled: false },
      { id: 'host', userId: 'host', name: 'Host', isHost: true, active: true, settled: false },
      { id: 'guest', name: 'Guest', active: true, settled: false },
    ],
    items: [{ id: 'i1', price: 120, name: 'Meal', claimedBy: ['deleted', 'host', 'guest'] }],
  }, 'deleted').record;
}
const act = (state, action, payload, memberId = 'host') => processSessionAction(state, action, payload, { memberId }, () => 1000);

test('host explicit resolution preserves debt and payment state, and closes only after every survivor finishes', () => {
  const original = session();
  const target = original.members.find((member) => member.deletedAccount);
  const resolved = act(original, 'RESOLVE_DELETED_MEMBER', { memberId: target.id });
  assert.equal(resolved.status, 'active');
  const member = resolved.members.find((member) => member.id === target.id);
  assert.equal(member.settled, false); assert.equal(member.active, true);
  assert.deepEqual(member.deletionResolution, { status: 'unconfirmed', resolvedByMemberId: 'host', resolvedAt: 1000 });
  assert.deepEqual(resolved.items, original.items); assert.equal(resolved.tipPercentage, original.tipPercentage);
  assert.equal(resolved.payerId, original.payerId);
  const hostFinished = act(resolved, 'TOGGLE_SETTLED', { memberId: 'host', settled: true });
  assert.equal(hostFinished.status, 'active');
  assert.throws(() => act(hostFinished, 'SETTLE_ALL', {}), /Every participant/);
  const closed = act(hostFinished, 'TOGGLE_SETTLED', { memberId: 'guest', settled: true }, 'guest');
  assert.equal(closed.status, 'settled'); assert.deepEqual(closed.unconfirmedMemberIds, [target.id]);
  assert.equal(closed.members.find((member) => member.id === target.id).settled, false);
  assert.deepEqual(closed.items, original.items);
});

test('last deleted participant can be resolved after all surviving members finished', () => {
  let state = session();
  const id = state.members.find((member) => member.deletedAccount).id;
  state = act(state, 'TOGGLE_SETTLED', { memberId: 'host', settled: true });
  state = act(state, 'TOGGLE_SETTLED', { memberId: 'guest', settled: true }, 'guest');
  assert.equal(state.status, 'active');
  state = act(state, 'RESOLVE_DELETED_MEMBER', { memberId: id });
  assert.equal(state.status, 'settled'); assert.deepEqual(state.unconfirmedMemberIds, [id]);
});

test('resolution rejects non-hosts, living/paid/deactivated targets, unassigned items and deleted actors', () => {
  const state = session(); const id = state.members.find((member) => member.deletedAccount).id;
  assert.throws(() => act(state, 'RESOLVE_DELETED_MEMBER', { memberId: id }, 'guest'), /Only the host/);
  assert.throws(() => act(state, 'RESOLVE_DELETED_MEMBER', { memberId: 'guest' }), /Only an unpaid deleted/);
  for (const patch of [{ settled: true }, { active: false }]) {
    const next = structuredClone(state); Object.assign(next.members.find((member) => member.id === id), patch);
    assert.throws(() => act(next, 'RESOLVE_DELETED_MEMBER', { memberId: id }), /Only an unpaid deleted/);
  }
  const unassigned = structuredClone(state); unassigned.items[0].claimedBy = [];
  assert.throws(() => act(unassigned, 'RESOLVE_DELETED_MEMBER', { memberId: id }), /Every item must be assigned/);
  assert.throws(() => act(state, 'TOGGLE_SETTLED', { memberId: id, settled: true }, id), /not a member/);
});

test('resolved share is idempotent and freezes amounts and shared claims without claiming it was paid', () => {
  const state = session(); const id = state.members.find((member) => member.deletedAccount).id;
  const resolved = act(state, 'RESOLVE_DELETED_MEMBER', { memberId: id });
  assert.deepEqual(act(resolved, 'RESOLVE_DELETED_MEMBER', { memberId: id }), resolved);
  assert.throws(() => act(resolved, 'SET_TIP', { tipPercentage: 20 }), /allocations are locked/);
  assert.throws(() => act(resolved, 'EDIT_ITEM', { itemId: 'i1', name: 'Changed', price: 1 }), /allocations are locked/);
  assert.throws(() => act(resolved, 'TOGGLE_CLAIM', { itemId: 'i1', memberId: 'guest', claimed: false }, 'guest'), /affects a finished share/);
});

test('finalizing a linked allocation with an unconfirmed share leaves group debt unchanged', () => {
  let state = session(); state.groupId = 'g1'; state.billId = 'b1';
  const id = state.members.find((member) => member.deletedAccount).id;
  const group = { id: 'g1', members: structuredClone(state.members), bills: [{
    id: 'b1', status: 'active', amount: 132, payerId: 'host', items: structuredClone(state.items),
    participantMemberIds: state.members.map((member) => member.id), settledMemberIds: [], tipPercentage: 10,
  }] };
  const before = calculateDebtMinimization(group);
  state = act(state, 'RESOLVE_DELETED_MEMBER', { memberId: id });
  state = act(state, 'TOGGLE_SETTLED', { memberId: 'host', settled: true });
  state = act(state, 'TOGGLE_SETTLED', { memberId: 'guest', settled: true }, 'guest');
  const afterBills = [{ ...group.bills[0], status: 'finalized', items: state.items, unconfirmedMemberIds: state.unconfirmedMemberIds }];
  assert.equal(state.status, 'settled');
  assert.deepEqual(calculateDebtMinimization({ ...group, bills: afterBills }), before);
  assert.ok(before.balances.some((balance) => balance.memberId === id && balance.netBalance !== 0));
});
