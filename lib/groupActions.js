const { requireString } = require('./validation');
const {
  BILL_STATUS,
  getBillStatus,
  normalizeGroupPayerId,
  isValidPayerId,
  assertGroupActive,
  resolveGroupActor,
  finalizeGroupBill,
  reopenGroupBill,
  beginGroupSettlement,
  setGroupTransferPaid,
  closeSettledGroup,
  reopenGroupSettlement,
} = require('./groupLifecycle');

function processGroupBillAction(group, rawAction, rawPayload, actor) {
  if (!group || !actor) throw Object.assign(new Error('A valid group membership is required'), { statusCode: 401 });
  const groupActor = resolveGroupActor(group, actor);
  const action = requireString(rawAction, 'action', 50);
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};

  if (action === 'START_GROUP_SETTLEMENT') {
    return beginGroupSettlement(group, groupActor);
  }
  if (action === 'SET_GROUP_TRANSFER_PAID') {
    const transferId = requireString(payload.transferId, 'transferId', 100);
    return setGroupTransferPaid(group, transferId, payload.paid !== false, groupActor);
  }
  if (action === 'CLOSE_GROUP') {
    return closeSettledGroup(group, groupActor);
  }
  if (action === 'REOPEN_GROUP_SETTLEMENT') {
    return reopenGroupSettlement(group, groupActor);
  }

  const billId = requireString(payload.billId, 'billId', 100);
  if (action === 'FINALIZE_BILL') {
    return finalizeGroupBill(group, billId, groupActor);
  }
  if (action === 'REOPEN_BILL') {
    return reopenGroupBill(group, billId, groupActor);
  }

  assertGroupActive(group);
  const updated = structuredClone(group);
  const bill = updated.bills?.find((candidate) => candidate.id === billId);
  if (!bill) throw Object.assign(new Error('Bill not found'), { statusCode: 404 });
  const billStatus = getBillStatus(bill);
  if (billStatus !== BILL_STATUS.ACTIVE) {
    throw Object.assign(new Error(
      billStatus === BILL_STATUS.FINALIZED
        ? 'This split is finalized and locked'
        : 'This bill is already settled'
    ), { statusCode: 409 });
  }
  const canManageBill = groupActor.isHost || bill.createdByMemberId === groupActor.id;

  if (action === 'TOGGLE_CLAIM') {
    const itemId = requireString(payload.itemId, 'itemId', 100);
    const item = bill.items?.find((candidate) => candidate.id === itemId);
    if (!item) throw Object.assign(new Error('Item not found'), { statusCode: 404 });
    const claimants = Array.isArray(item.claimedBy) ? item.claimedBy : [];
    const shouldClaim = payload.claimed !== undefined
      ? Boolean(payload.claimed)
      : !claimants.includes(groupActor.id);
    item.claimedBy = shouldClaim
      ? [...new Set([...claimants, groupActor.id])]
      : claimants.filter((id) => id !== groupActor.id);
  } else if (action === 'SET_PAYER') {
    if (!canManageBill) throw Object.assign(new Error('Only the bill creator or group host can change the payer'), { statusCode: 403 });
    const payerId = normalizeGroupPayerId(requireString(payload.payerId, 'payerId', 100));
    if (!isValidPayerId(updated, payerId)) {
      throw Object.assign(new Error('Payer is not an active group member'), { statusCode: 400 });
    }
    bill.payerId = payerId;
  } else if (action === 'SPLIT_ALL') {
    if (!canManageBill) throw Object.assign(new Error('Only the bill creator or group host can split every item'), { statusCode: 403 });
    const memberIds = updated.members.filter((member) => member.active !== false).map((member) => member.id);
    (bill.items || []).forEach((item) => { item.claimedBy = [...memberIds]; });
  } else {
    throw Object.assign(new Error('Unknown group bill action'), { statusCode: 400 });
  }

  updated.updatedAt = Date.now();
  return updated;
}

module.exports = { processGroupBillAction };
