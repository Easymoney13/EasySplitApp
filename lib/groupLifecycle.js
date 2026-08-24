const crypto = require('crypto');
const { calculateDebtMinimization } = require('./debtMinimizer');

const GROUP_STATUS = Object.freeze({
  ACTIVE: 'active',
  SETTLING: 'settling',
  CLOSED: 'closed',
});

const BILL_STATUS = Object.freeze({
  ACTIVE: 'active',
  FINALIZED: 'finalized',
  SETTLED: 'settled',
});

const GROUP_STATUSES = new Set(Object.values(GROUP_STATUS));
const BILL_STATUSES = new Set(Object.values(BILL_STATUS));

function lifecycleError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

function roundMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function getGroupStatus(group) {
  const rawStatus = group?.status;
  if (rawStatus === null || rawStatus === undefined || rawStatus === '') return GROUP_STATUS.ACTIVE;
  const status = String(rawStatus).toLowerCase();
  if (GROUP_STATUSES.has(status)) return status;
  if (['settled', 'archived', 'complete', 'completed'].includes(status)) return GROUP_STATUS.CLOSED;
  return GROUP_STATUS.CLOSED;
}

function getBillStatus(bill) {
  const rawStatus = bill?.status;
  if (rawStatus === null || rawStatus === undefined || rawStatus === '') return BILL_STATUS.ACTIVE;
  const status = String(rawStatus).toLowerCase();
  if (BILL_STATUSES.has(status)) return status;
  if (['closed', 'complete', 'completed'].includes(status)) return BILL_STATUS.SETTLED;
  return BILL_STATUS.SETTLED;
}

function assertGroupActive(group) {
  const status = getGroupStatus(group);
  if (status !== GROUP_STATUS.ACTIVE) {
    throw lifecycleError(status === GROUP_STATUS.CLOSED
      ? 'This group is closed and read-only'
      : 'This group is being settled and cannot be changed');
  }
}

function resolveGroupActor(group, actor) {
  const member = (Array.isArray(group?.members) ? group.members : [])
    .find((candidate) => candidate?.id === actor?.id && candidate.active !== false);
  if (!member) throw lifecycleError('A valid group membership is required', 401);
  return member;
}

function assertGroupHost(group, actor) {
  const member = resolveGroupActor(group, actor);
  if (!member.isHost) throw lifecycleError('Only the group host can perform this action', 403);
  return member;
}

function normalizeGroupPayerId(payerId) {
  const normalized = String(payerId || '').toLowerCase();
  return ['each', 'split', 'everyone'].includes(normalized) ? 'each' : payerId;
}

function isValidPayerId(group, payerId) {
  const normalized = normalizeGroupPayerId(payerId);
  if (normalized === 'each') return true;
  return (group.members || []).some((member) => member.id === normalized && member.active !== false);
}

function hasUnassignedItems(bill) {
  const items = Array.isArray(bill?.items) ? bill.items : [];
  return items.some((item) => {
    const price = Number(item?.price) || 0;
    const claimants = Array.isArray(item?.claimedBy) ? item.claimedBy.filter(Boolean) : [];
    return price > 0 && claimants.length === 0;
  });
}

function finalizeGroupBill(group, billId, actor, now = Date.now) {
  assertGroupActive(group);
  const groupActor = resolveGroupActor(group, actor);
  const updated = structuredClone(group);
  const bill = updated.bills?.find((candidate) => candidate.id === billId);
  if (!bill) throw lifecycleError('Bill not found', 404);
  const status = getBillStatus(bill);
  if (!groupActor.isHost && bill.createdByMemberId !== groupActor.id) {
    throw lifecycleError('Only the bill creator or group host can finish this split', 403);
  }
  if (status === BILL_STATUS.FINALIZED) return updated;
  if (status === BILL_STATUS.SETTLED) throw lifecycleError('This bill is already financially settled');
  if (!isValidPayerId(updated, bill.payerId)) {
    throw lifecycleError('Choose a valid payer before finishing this split');
  }
  if (hasUnassignedItems(bill)) {
    throw lifecycleError('Assign every priced item before finishing this split');
  }
  const timestamp = now();
  bill.payerId = normalizeGroupPayerId(bill.payerId);
  bill.settledMemberIds = [];
  bill.status = BILL_STATUS.FINALIZED;
  bill.finalizedAt = timestamp;
  bill.finalizedByMemberId = groupActor.id;
  bill.updatedAt = timestamp;
  updated.updatedAt = timestamp;
  return updated;
}

function reopenGroupBill(group, billId, actor, now = Date.now) {
  assertGroupActive(group);
  const groupActor = resolveGroupActor(group, actor);
  const updated = structuredClone(group);
  const bill = updated.bills?.find((candidate) => candidate.id === billId);
  if (!bill) throw lifecycleError('Bill not found', 404);
  if (!groupActor.isHost && bill.createdByMemberId !== groupActor.id) {
    throw lifecycleError('Only the bill creator or group host can reopen this split', 403);
  }
  const status = getBillStatus(bill);
  if (status === BILL_STATUS.ACTIVE) return updated;
  if (status === BILL_STATUS.SETTLED) throw lifecycleError('A financially settled bill cannot be reopened');
  const timestamp = now();
  bill.status = BILL_STATUS.ACTIVE;
  delete bill.finalizedAt;
  delete bill.finalizedByMemberId;
  bill.updatedAt = timestamp;
  updated.updatedAt = timestamp;
  return updated;
}

function transferIdFor(transaction, index) {
  const cents = Math.round((Number(transaction.amount) || 0) * 100);
  const digest = crypto
    .createHash('sha256')
    .update(`${transaction.fromId}:${transaction.toId}:${cents}:${index}`)
    .digest('hex')
    .slice(0, 16);
  return `transfer_${digest}`;
}

function beginGroupSettlement(group, actor, now = Date.now) {
  assertGroupActive(group);
  const groupActor = assertGroupHost(group, actor);
  const updated = structuredClone(group);
  const bills = Array.isArray(updated.bills) ? updated.bills : [];
  const financiallyOpenBills = bills.filter((bill) => getBillStatus(bill) !== BILL_STATUS.SETTLED);
  if (financiallyOpenBills.length === 0) {
    throw lifecycleError('Finish at least one group split before starting settlement');
  }
  const unfinishedBills = financiallyOpenBills.filter((bill) => getBillStatus(bill) !== BILL_STATUS.FINALIZED);
  if (unfinishedBills.length > 0) {
    throw lifecycleError('Finish every active split before starting group settlement');
  }

  const debt = calculateDebtMinimization(updated);
  if (Number(debt.unassignedAmount) > 0.009) {
    throw lifecycleError('Assign every priced item before starting group settlement');
  }
  if (!debt.isBalanced) {
    throw lifecycleError('The group balance is inconsistent and cannot be settled safely');
  }

  const timestamp = now();
  const transfers = debt.transactions.map((transaction, index) => ({
    id: transferIdFor(transaction, index),
    fromId: transaction.fromId,
    fromName: transaction.fromName,
    toId: transaction.toId,
    toName: transaction.toName,
    amount: roundMoney(transaction.amount),
    paid: false,
  }));
  const totalAmount = roundMoney(financiallyOpenBills.reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0));
  const snapshotId = `settlement_${crypto
    .createHash('sha256')
    .update(`${updated.id || ''}:${timestamp}:${financiallyOpenBills.map((bill) => bill.id).join(',')}`)
    .digest('hex')
    .slice(0, 16)}`;

  updated.status = GROUP_STATUS.SETTLING;
  updated.settlement = {
    version: 1,
    id: snapshotId,
    status: transfers.length === 0 ? 'ready_to_close' : 'pending',
    currency: updated.currency || 'NIS',
    createdAt: timestamp,
    createdByMemberId: groupActor.id,
    updatedAt: timestamp,
    billIds: financiallyOpenBills.map((bill) => bill.id),
    billsCount: financiallyOpenBills.length,
    totalAmount,
    balances: debt.balances.map((balance) => ({
      memberId: balance.memberId,
      name: balance.name,
      totalPaid: roundMoney(balance.totalPaid),
      totalShare: roundMoney(balance.totalShare),
      netBalance: roundMoney(balance.netBalance),
    })),
    transfers,
    paymentsRemaining: transfers.length,
  };
  updated.updatedAt = timestamp;
  return updated;
}

function setGroupTransferPaid(group, transferId, paid, actor, now = Date.now) {
  if (getGroupStatus(group) !== GROUP_STATUS.SETTLING) {
    throw lifecycleError('This group is not currently being settled');
  }
  const groupActor = resolveGroupActor(group, actor);
  const updated = structuredClone(group);
  const transfer = updated.settlement?.transfers?.find((candidate) => candidate.id === transferId);
  if (!transfer) throw lifecycleError('Settlement transfer not found', 404);
  if (!groupActor.isHost && groupActor.id !== transfer.fromId && groupActor.id !== transfer.toId) {
    throw lifecycleError('Only the people in this transfer or the group host can update it', 403);
  }

  const nextPaid = Boolean(paid);
  if (Boolean(transfer.paid) !== nextPaid) {
    const timestamp = now();
    transfer.paid = nextPaid;
    if (nextPaid) {
      transfer.paidAt = timestamp;
      transfer.paidByMemberId = groupActor.id;
      updated.settlement.paymentActivityAt = updated.settlement.paymentActivityAt || timestamp;
    } else {
      delete transfer.paidAt;
      delete transfer.paidByMemberId;
    }
    updated.settlement.updatedAt = timestamp;
    updated.updatedAt = timestamp;
  }
  const paymentsRemaining = updated.settlement.transfers.filter((candidate) => !candidate.paid).length;
  updated.settlement.paymentsRemaining = paymentsRemaining;
  updated.settlement.status = paymentsRemaining === 0 ? 'ready_to_close' : 'pending';
  return updated;
}

function closeSettledGroup(group, actor, now = Date.now) {
  if (getGroupStatus(group) !== GROUP_STATUS.SETTLING) {
    throw lifecycleError('Start group settlement before closing the group');
  }
  const groupActor = assertGroupHost(group, actor);
  const updated = structuredClone(group);
  if (!updated.settlement || !Array.isArray(updated.settlement.transfers)) {
    throw lifecycleError('The group settlement snapshot is missing');
  }
  const paymentsRemaining = updated.settlement.transfers.filter((transfer) => !transfer.paid).length;
  if (paymentsRemaining > 0) {
    throw lifecycleError(`${paymentsRemaining} settlement payment${paymentsRemaining === 1 ? '' : 's'} still pending`);
  }
  const timestamp = now();
  updated.status = GROUP_STATUS.CLOSED;
  updated.closedAt = timestamp;
  updated.updatedAt = timestamp;
  updated.settlement.status = 'completed';
  updated.settlement.completedAt = timestamp;
  updated.settlement.completedByMemberId = groupActor.id;
  updated.settlement.updatedAt = timestamp;
  updated.settlement.paymentsRemaining = 0;
  const snapshotBillIds = new Set(updated.settlement.billIds || []);
  (updated.bills || []).forEach((bill) => {
    if (!snapshotBillIds.has(bill.id) || getBillStatus(bill) !== BILL_STATUS.FINALIZED) return;
    bill.status = BILL_STATUS.SETTLED;
    bill.financiallySettledAt = timestamp;
    bill.financiallySettledByMemberId = groupActor.id;
    bill.settledAt = bill.settledAt || timestamp;
    bill.updatedAt = timestamp;
  });
  return updated;
}

function reopenGroupSettlement(group, actor, now = Date.now) {
  if (getGroupStatus(group) !== GROUP_STATUS.SETTLING) {
    throw lifecycleError('This group is not currently being settled');
  }
  assertGroupHost(group, actor);
  const paidTransfers = (group.settlement?.transfers || []).filter((transfer) => transfer.paid);
  if (group.settlement?.paymentActivityAt || paidTransfers.length > 0) {
    throw lifecycleError('A settlement with recorded payments cannot be reopened');
  }
  const updated = structuredClone(group);
  updated.status = GROUP_STATUS.ACTIVE;
  delete updated.settlement;
  updated.updatedAt = now();
  return updated;
}


function assertGroupSettlementPaymentPhase(group) {
  const status = getGroupStatus(group);
  if (status !== GROUP_STATUS.SETTLING) {
    throw lifecycleError(status === GROUP_STATUS.CLOSED
      ? 'This group is already closed'
      : 'Start the final group settlement before making group payments');
  }
}

function assertSessionSettlementNotDeferredToGroup(session) {
  if (session?.groupId) {
    throw lifecycleError('Group-linked splits are settled at the group level. Finish the split and settle the group instead.');
  }
}

function summarizeGroup(group) {
  const bills = Array.isArray(group?.bills) ? group.bills : [];
  const status = getGroupStatus(group);
  const membersCount = Array.isArray(group?.members)
    ? group.members.filter((member) => member?.active !== false).length
    : 0;
  const activeBillsCount = bills.filter((bill) => getBillStatus(bill) === BILL_STATUS.ACTIVE).length;
  const finalizedBillsCount = bills.filter((bill) => getBillStatus(bill) === BILL_STATUS.FINALIZED).length;
  const settledBillsCount = bills.filter((bill) => getBillStatus(bill) === BILL_STATUS.SETTLED).length;
  const totalSpent = roundMoney(bills.reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0));
  return {
    id: group?.id,
    code: group?.code,
    name: group?.name,
    currency: group?.currency || 'NIS',
    status,
    membersCount,
    billsCount: bills.length,
    activeBillsCount,
    finalizedBillsCount,
    settledBillsCount,
    totalSpent,
    paymentsRemaining: status === GROUP_STATUS.SETTLING
      ? Math.max(0, Number(group?.settlement?.paymentsRemaining) || 0)
      : 0,
    updatedAt: Number(group?.updatedAt || group?.createdAt || 0),
    closedAt: status === GROUP_STATUS.CLOSED ? Number(group?.closedAt || 0) : undefined,
  };
}

function groupMatchesScope(group, scope = 'active') {
  const status = getGroupStatus(group);
  if (scope === 'all') return true;
  if (scope === 'closed') return status === GROUP_STATUS.CLOSED;
  return status !== GROUP_STATUS.CLOSED;
}

module.exports = {
  GROUP_STATUS,
  BILL_STATUS,
  getGroupStatus,
  getBillStatus,
  assertGroupActive,
  resolveGroupActor,
  normalizeGroupPayerId,
  isValidPayerId,
  hasUnassignedItems,
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
};
