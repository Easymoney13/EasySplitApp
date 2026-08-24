const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateDebtMinimization } = require('../lib/debtMinimizer');
const { processGroupBillAction } = require('../lib/groupActions');
const {
  GROUP_STATUS,
  BILL_STATUS,
  getGroupStatus,
  getBillStatus,
  finalizeGroupBill,
  reopenGroupBill,
  beginGroupSettlement,
  setGroupTransferPaid,
  closeSettledGroup,
  reopenGroupSettlement,
  assertGroupSettlementPaymentPhase,
  assertSessionSettlementNotDeferredToGroup,
  summarizeGroup,
  groupMatchesScope,
} = require('../lib/groupLifecycle');

function sampleGroup(overrides = {}) {
  return {
    id: 'grp_test_123456',
    code: '12345678',
    name: 'Eilat Weekend',
    currency: 'NIS',
    createdAt: 100,
    members: [
      { id: 'host', name: 'Yoav', isHost: true, active: true },
      { id: 'guest', name: 'Naor', isHost: false, active: true },
      { id: 'third', name: 'Lia', isHost: false, active: true },
    ],
    bills: [
      {
        id: 'bill_dinner',
        title: 'Dinner',
        status: 'active',
        amount: 120,
        payerId: 'host',
        createdByMemberId: 'host',
        items: [
          { id: 'pizza', name: 'Pizza', price: 60, claimedBy: ['host', 'guest'] },
          { id: 'salad', name: 'Salad', price: 60, claimedBy: ['third'] },
        ],
      },
    ],
    ...overrides,
  };
}

test('legacy groups and bills default to active without rewriting stored data', () => {
  const group = sampleGroup({ status: undefined, bills: [{ ...sampleGroup().bills[0], status: undefined }] });
  assert.equal(getGroupStatus(group), GROUP_STATUS.ACTIVE);
  assert.equal(getBillStatus(group.bills[0]), BILL_STATUS.ACTIVE);
  assert.equal(group.status, undefined);
  assert.equal(group.bills[0].status, undefined);
});

test('unknown persisted lifecycle states fail closed instead of becoming editable', () => {
  assert.equal(getGroupStatus({ status: 'unexpected-state' }), GROUP_STATUS.CLOSED);
  assert.equal(getBillStatus({ status: 'unexpected-state' }), BILL_STATUS.SETTLED);
});

test('the each-pays-own-share payer alias normalizes safely', () => {
  const group = sampleGroup();
  const changed = processGroupBillAction(
    group,
    'SET_PAYER',
    { billId: 'bill_dinner', payerId: 'everyone' },
    group.members[0]
  );
  assert.equal(changed.bills[0].payerId, 'each');
});

test('finalized bills remain in the aggregate balance while settled legacy bills stay excluded', () => {
  const finalized = sampleGroup({ bills: [{ ...sampleGroup().bills[0], status: 'finalized' }] });
  const finalizedDebt = calculateDebtMinimization(finalized);
  assert.equal(finalizedDebt.transactions.length, 2);
  assert.equal(finalizedDebt.transactions.reduce((sum, transfer) => sum + transfer.amount, 0), 90);

  const settled = sampleGroup({ bills: [{ ...sampleGroup().bills[0], status: 'settled' }] });
  const settledDebt = calculateDebtMinimization(settled);
  assert.deepEqual(settledDebt.transactions, []);
  assert.ok(settledDebt.balances.every((balance) => balance.netBalance === 0));
});

test('finishing a group split locks it only after all priced items are assigned', () => {
  const unfinished = sampleGroup();
  unfinished.bills[0].items[1].claimedBy = [];
  assert.throws(
    () => finalizeGroupBill(unfinished, 'bill_dinner', unfinished.members[0], () => 200),
    /Assign every priced item/
  );

  const finalized = finalizeGroupBill(sampleGroup(), 'bill_dinner', sampleGroup().members[0], () => 200);
  assert.equal(finalized.bills[0].status, BILL_STATUS.FINALIZED);
  assert.equal(finalized.bills[0].finalizedAt, 200);
  assert.equal(finalized.updatedAt, 200);
  assert.equal(sampleGroup().bills[0].status, BILL_STATUS.ACTIVE);
});

test('a finalized split can be reopened before group settlement but a settled bill cannot', () => {
  const finalized = sampleGroup({ bills: [{ ...sampleGroup().bills[0], status: 'finalized', finalizedAt: 150 }] });
  const reopened = reopenGroupBill(finalized, 'bill_dinner', finalized.members[0], () => 225);
  assert.equal(reopened.bills[0].status, BILL_STATUS.ACTIVE);
  assert.equal(reopened.bills[0].finalizedAt, undefined);
  assert.equal(reopened.updatedAt, 225);

  const settled = sampleGroup({ bills: [{ ...sampleGroup().bills[0], status: 'settled' }] });
  assert.throws(() => reopenGroupBill(settled, 'bill_dinner', settled.members[0]), /cannot be reopened/);
});

test('only the creator or group host can finish a split', () => {
  const group = sampleGroup();
  assert.throws(
    () => finalizeGroupBill(group, 'bill_dinner', group.members[1]),
    /Only the bill creator or group host/
  );
});

test('a finalized split is immutable through existing claim and payer actions', () => {
  const group = sampleGroup({ bills: [{ ...sampleGroup().bills[0], status: 'finalized' }] });
  assert.throws(
    () => processGroupBillAction(group, 'TOGGLE_CLAIM', { billId: 'bill_dinner', itemId: 'pizza' }, group.members[0]),
    /finalized and locked/
  );
  assert.throws(
    () => processGroupBillAction(group, 'SET_PAYER', { billId: 'bill_dinner', payerId: 'guest' }, group.members[0]),
    /finalized and locked/
  );
});

test('current group claim behavior remains unchanged for active bills', () => {
  const group = sampleGroup();
  const updated = processGroupBillAction(
    group,
    'TOGGLE_CLAIM',
    { billId: 'bill_dinner', itemId: 'pizza', claimed: true },
    group.members[2]
  );
  assert.deepEqual(updated.bills[0].items[0].claimedBy, ['host', 'guest', 'third']);
  assert.deepEqual(group.bills[0].items[0].claimedBy, ['host', 'guest']);
});

test('group settlement cannot start until every financially open split is finalized', () => {
  const group = sampleGroup();
  assert.throws(
    () => beginGroupSettlement(group, group.members[0], () => 300),
    /Finish every active split/
  );
});

test('starting settlement freezes a deterministic balance and transfer snapshot', () => {
  const group = sampleGroup({ status: undefined, bills: [{ ...sampleGroup().bills[0], status: 'finalized' }] });
  const settling = beginGroupSettlement(group, group.members[0], () => 300);
  assert.equal(settling.status, GROUP_STATUS.SETTLING);
  assert.equal(settling.settlement.version, 1);
  assert.equal(settling.settlement.createdAt, 300);
  assert.deepEqual(settling.settlement.billIds, ['bill_dinner']);
  assert.equal(settling.settlement.totalAmount, 120);
  assert.equal(settling.settlement.transfers.length, 2);
  assert.equal(settling.settlement.paymentsRemaining, 2);
  assert.ok(settling.settlement.transfers.every((transfer) => /^transfer_[a-f0-9]{16}$/.test(transfer.id)));
  assert.equal(group.status, undefined);
  assert.equal(group.settlement, undefined);

  const replay = beginGroupSettlement(group, group.members[0], () => 300);
  assert.deepEqual(replay.settlement.transfers, settling.settlement.transfers);
  assert.equal(replay.settlement.id, settling.settlement.id);
});

test('a forged actor object cannot gain host permissions without group membership', () => {
  const group = sampleGroup({ bills: [{ ...sampleGroup().bills[0], status: 'finalized' }] });
  assert.throws(
    () => beginGroupSettlement(group, { id: 'forged', isHost: true }),
    /valid group membership/
  );
});

test('only the host can freeze or close the group settlement', () => {
  const group = sampleGroup({ bills: [{ ...sampleGroup().bills[0], status: 'finalized' }] });
  assert.throws(() => beginGroupSettlement(group, group.members[1]), /Only the group host/);
});

test('settling status blocks ordinary group bill mutations', () => {
  const group = beginGroupSettlement(
    sampleGroup({ bills: [{ ...sampleGroup().bills[0], status: 'finalized' }] }),
    sampleGroup().members[0],
    () => 300
  );
  assert.throws(
    () => processGroupBillAction(group, 'SPLIT_ALL', { billId: 'bill_dinner' }, group.members[0]),
    /being settled/
  );
});

test('only a transfer party or host can update a frozen payment', () => {
  const group = beginGroupSettlement(
    sampleGroup({ bills: [{ ...sampleGroup().bills[0], status: 'finalized' }] }),
    sampleGroup().members[0],
    () => 300
  );
  const transfer = group.settlement.transfers[0];
  const outsider = { id: 'outsider', name: 'Outsider', isHost: false };
  assert.throws(
    () => setGroupTransferPaid(group, transfer.id, true, outsider, () => 400),
    /valid group membership/
  );

  const payer = group.members.find((member) => member.id === transfer.fromId);
  const updated = setGroupTransferPaid(group, transfer.id, true, payer, () => 400);
  assert.equal(updated.settlement.transfers[0].paid, true);
  assert.equal(updated.settlement.transfers[0].paidAt, 400);
  assert.equal(updated.settlement.transfers[0].paidByMemberId, payer.id);
  assert.equal(updated.settlement.paymentsRemaining, 1);
  assert.equal(group.settlement.transfers[0].paid, false);
});

test('a settlement can be reopened only before any payment is recorded', () => {
  const group = beginGroupSettlement(
    sampleGroup({ bills: [{ ...sampleGroup().bills[0], status: 'finalized' }] }),
    sampleGroup().members[0],
    () => 300
  );
  const reopened = reopenGroupSettlement(group, group.members[0], () => 350);
  assert.equal(reopened.status, GROUP_STATUS.ACTIVE);
  assert.equal(reopened.settlement, undefined);

  const transfer = group.settlement.transfers[0];
  const paid = setGroupTransferPaid(group, transfer.id, true, group.members[0], () => 400);
  assert.throws(() => reopenGroupSettlement(paid, paid.members[0]), /recorded payments cannot be reopened/);

  const unmarked = setGroupTransferPaid(paid, transfer.id, false, paid.members[0], () => 450);
  assert.equal(unmarked.settlement.transfers[0].paid, false);
  assert.equal(unmarked.settlement.paymentActivityAt, 400);
  assert.throws(() => reopenGroupSettlement(unmarked, unmarked.members[0]), /recorded payments cannot be reopened/);
});

test('closing requires every frozen transfer and financially settles only snapshot bills', () => {
  let group = beginGroupSettlement(
    sampleGroup({
      bills: [
        { ...sampleGroup().bills[0], status: 'finalized' },
        {
          id: 'legacy_paid',
          title: 'Already paid',
          status: 'settled',
          amount: 20,
          payerId: 'host',
          createdByMemberId: 'host',
          items: [],
        },
      ],
    }),
    sampleGroup().members[0],
    () => 300
  );
  assert.throws(() => closeSettledGroup(group, group.members[0], () => 500), /still pending/);

  for (const transfer of [...group.settlement.transfers]) {
    group = setGroupTransferPaid(group, transfer.id, true, group.members[0], () => 400);
  }
  const closed = closeSettledGroup(group, group.members[0], () => 500);
  assert.equal(closed.status, GROUP_STATUS.CLOSED);
  assert.equal(closed.closedAt, 500);
  assert.equal(closed.settlement.status, 'completed');
  assert.equal(closed.settlement.paymentsRemaining, 0);
  assert.equal(closed.bills.find((bill) => bill.id === 'bill_dinner').status, BILL_STATUS.SETTLED);
  assert.equal(closed.bills.find((bill) => bill.id === 'bill_dinner').financiallySettledAt, 500);
  assert.equal(closed.bills.find((bill) => bill.id === 'legacy_paid').settledAt, undefined);
});

test('zero-transfer groups can move directly from frozen snapshot to closed', () => {
  const group = sampleGroup({
    bills: [{
      ...sampleGroup().bills[0],
      status: 'finalized',
      payerId: 'each',
    }],
  });
  const settling = beginGroupSettlement(group, group.members[0], () => 300);
  assert.equal(settling.settlement.transfers.length, 0);
  assert.equal(settling.settlement.status, 'ready_to_close');
  const closed = closeSettledGroup(settling, settling.members[0], () => 500);
  assert.equal(closed.status, GROUP_STATUS.CLOSED);
});

test('group summaries are lightweight, backwards-compatible and scope-aware', () => {
  const active = sampleGroup({
    status: undefined,
    updatedAt: 250,
    bills: [
      sampleGroup().bills[0],
      { ...sampleGroup().bills[0], id: 'bill_two', status: 'finalized', amount: 80 },
      { ...sampleGroup().bills[0], id: 'bill_three', status: 'settled', amount: 20 },
    ],
  });
  const summary = summarizeGroup(active);
  assert.deepEqual(
    {
      status: summary.status,
      membersCount: summary.membersCount,
      billsCount: summary.billsCount,
      activeBillsCount: summary.activeBillsCount,
      finalizedBillsCount: summary.finalizedBillsCount,
      settledBillsCount: summary.settledBillsCount,
      totalSpent: summary.totalSpent,
      paymentsRemaining: summary.paymentsRemaining,
      updatedAt: summary.updatedAt,
    },
    {
      status: 'active',
      membersCount: 3,
      billsCount: 3,
      activeBillsCount: 1,
      finalizedBillsCount: 1,
      settledBillsCount: 1,
      totalSpent: 220,
      paymentsRemaining: 0,
      updatedAt: 250,
    }
  );
  assert.equal(groupMatchesScope(active, 'active'), true);
  assert.equal(groupMatchesScope(active, 'closed'), false);
  assert.equal(groupMatchesScope({ ...active, status: 'closed' }, 'closed'), true);
  assert.equal(groupMatchesScope({ ...active, status: 'closed' }, 'active'), false);
  assert.equal(groupMatchesScope(active, 'all'), true);
});

test('group-level lifecycle actions work through the existing action processor without a bill id', () => {
  const finalized = sampleGroup({ bills: [{ ...sampleGroup().bills[0], status: 'finalized' }] });
  const settling = processGroupBillAction(finalized, 'START_GROUP_SETTLEMENT', {}, finalized.members[0]);
  assert.equal(settling.status, GROUP_STATUS.SETTLING);
  const transfer = settling.settlement.transfers[0];
  const paid = processGroupBillAction(
    settling,
    'SET_GROUP_TRANSFER_PAID',
    { transferId: transfer.id, paid: true },
    settling.members[0]
  );
  assert.equal(paid.settlement.transfers[0].paid, true);

  const reopenedSettlement = processGroupBillAction(settling, 'REOPEN_GROUP_SETTLEMENT', {}, settling.members[0]);
  const reopenedBill = processGroupBillAction(reopenedSettlement, 'REOPEN_BILL', { billId: 'bill_dinner' }, reopenedSettlement.members[0]);
  assert.equal(reopenedBill.bills[0].status, BILL_STATUS.ACTIVE);
});


test('group-linked sessions defer every financial settlement action to the group', () => {
  assert.doesNotThrow(() => assertSessionSettlementNotDeferredToGroup({ id: 'session_regular' }));
  assert.throws(
    () => assertSessionSettlementNotDeferredToGroup({ id: 'session_group', groupId: 'grp_test' }),
    /settled at the group level/,
  );
});


test('group payment targets are available only after the final settlement snapshot is frozen', () => {
  assert.throws(
    () => assertGroupSettlementPaymentPhase(sampleGroup({ status: 'active' })),
    /Start the final group settlement/,
  );
  assert.doesNotThrow(() => assertGroupSettlementPaymentPhase(sampleGroup({ status: 'settling' })));
  assert.throws(
    () => assertGroupSettlementPaymentPhase(sampleGroup({ status: 'closed' })),
    /already closed/,
  );
});


test('finalizing a cleaned legacy bill drops stale paid-member markers', () => {
  const group = sampleGroup({
    bills: [{ ...sampleGroup().bills[0], settledMemberIds: ['guest'] }],
  });
  const finalized = finalizeGroupBill(group, 'bill_dinner', group.members[0], () => 500);
  assert.deepEqual(finalized.bills[0].settledMemberIds, []);
  assert.equal(finalized.bills[0].status, BILL_STATUS.FINALIZED);
});
