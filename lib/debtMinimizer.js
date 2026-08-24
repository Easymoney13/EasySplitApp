function toCents(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round((parsed + Number.EPSILON) * 100);
}

function fromCents(value) {
  return Math.round(value) / 100;
}

function resolveMemberId(target, members) {
  if (!target) return null;
  const byId = members.find((member) => member.id === target);
  if (byId) return byId.id;

  // Legacy records sometimes stored a name. Accept it only when it is unique.
  const normalized = String(target).trim().toLowerCase();
  const matches = members.filter((member) => String(member.name || '').trim().toLowerCase() === normalized);
  return matches.length === 1 ? matches[0].id : null;
}

function splitCents(totalCents, memberIds) {
  if (totalCents <= 0 || memberIds.length === 0) return [];
  const base = Math.floor(totalCents / memberIds.length);
  let remainder = totalCents % memberIds.length;
  return memberIds.map((memberId) => {
    const cents = base + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;
    return { memberId, cents };
  });
}

function allocateCentsProportionally(totalCents, weights) {
  const safeWeights = weights.map((weight) => Math.max(0, Math.round(Number(weight) || 0)));
  const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (totalCents <= 0 || weightTotal <= 0) return safeWeights.map(() => 0);
  const allocations = safeWeights.map((weight, index) => {
    const exact = (totalCents * weight) / weightTotal;
    return { index, cents: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = totalCents - allocations.reduce((sum, entry) => sum + entry.cents, 0);
  allocations
    .slice()
    .sort((first, second) => second.remainder - first.remainder || first.index - second.index)
    .forEach((entry) => {
      if (remaining <= 0) return;
      allocations[entry.index].cents += 1;
      remaining -= 1;
    });
  return allocations.map((entry) => entry.cents);
}

function allocateTipAdjustedCents(baseShareCents, tipPercentage) {
  const safeShares = baseShareCents.map((share) => Math.max(0, Math.round(Number(share) || 0)));
  const baseTotalCents = safeShares.reduce((sum, share) => sum + share, 0);
  const percentage = Math.max(0, Number(tipPercentage) || 0);
  const grandTotalCents = Math.round(baseTotalCents * (1 + percentage / 100));
  return allocateCentsProportionally(grandTotalCents, safeShares);
}

function greedyTransactions(entries) {
  const debtors = entries.filter((entry) => entry.cents < 0).map((entry) => ({ ...entry, cents: -entry.cents }));
  const creditors = entries.filter((entry) => entry.cents > 0).map((entry) => ({ ...entry }));
  debtors.sort((a, b) => b.cents - a.cents);
  creditors.sort((a, b) => b.cents - a.cents);
  const transactions = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const cents = Math.min(debtor.cents, creditor.cents);
    if (cents > 0) transactions.push({ fromId: debtor.id, toId: creditor.id, cents });
    debtor.cents -= cents;
    creditor.cents -= cents;
    if (debtor.cents === 0) debtorIndex += 1;
    if (creditor.cents === 0) creditorIndex += 1;
  }
  return transactions;
}

function exactTransactions(entries) {
  const active = entries.filter((entry) => entry.cents !== 0);
  if (active.length > 10) return greedyTransactions(active);
  const balances = active.map((entry) => entry.cents);
  let best = null;

  function search(transfers) {
    if (best && transfers.length >= best.length) return;
    const first = balances.findIndex((value) => value !== 0);
    if (first === -1) {
      best = transfers.map((transfer) => ({ ...transfer }));
      return;
    }

    const seen = new Set();
    for (let other = first + 1; other < balances.length; other += 1) {
      if (balances[first] * balances[other] >= 0 || seen.has(balances[other])) continue;
      seen.add(balances[other]);
      const firstBefore = balances[first];
      const otherBefore = balances[other];
      const cents = Math.min(Math.abs(firstBefore), Math.abs(otherBefore));
      const transfer = firstBefore < 0
        ? { fromId: active[first].id, toId: active[other].id, cents }
        : { fromId: active[other].id, toId: active[first].id, cents };

      balances[first] += firstBefore < 0 ? cents : -cents;
      balances[other] += otherBefore < 0 ? cents : -cents;
      transfers.push(transfer);
      search(transfers);
      transfers.pop();
      balances[first] = firstBefore;
      balances[other] = otherBefore;

      if (firstBefore + otherBefore === 0) break;
    }
  }

  search([]);
  return best || greedyTransactions(active);
}

function calculateDebtMinimization(group) {
  const members = Array.isArray(group?.members) ? group.members.filter((member) => member?.id) : [];
  const bills = Array.isArray(group?.bills) ? group.bills : [];
  const memberIds = members.map((member) => member.id);
  const records = new Map(memberIds.map((id) => [id, { paidCents: 0, shareCents: 0 }]));
  let unassignedCents = 0;
  let billAmountDifferenceCents = 0;

  bills.forEach((bill) => {
    if (bill?.status === 'settled') return;
    const settledMemberIds = new Set(
      (Array.isArray(bill?.settledMemberIds) ? bill.settledMemberIds : [])
        .map((memberId) => resolveMemberId(memberId, members))
        .filter(Boolean)
    );
    const eachPaidOwnShare = ['each', 'split', 'everyone'].includes(String(bill?.payerId || '').toLowerCase());
    const payerId = eachPaidOwnShare ? null : (resolveMemberId(bill?.payerId, members) || memberIds[0]);
    if (!eachPaidOwnShare && (!payerId || !records.has(payerId))) return;
    const items = Array.isArray(bill?.items) ? bill.items : [];

    if (items.length === 0) {
      const billCents = toCents(bill?.amount);
      if (billCents === 0) return;
      let outstandingCents = 0;
      splitCents(billCents, memberIds).forEach(({ memberId, cents }) => {
        if (settledMemberIds.has(memberId)) return;
        records.get(memberId).shareCents += cents;
        outstandingCents += cents;
        if (eachPaidOwnShare) records.get(memberId).paidCents += cents;
      });
      if (!eachPaidOwnShare) records.get(payerId).paidCents += outstandingCents;
      return;
    }

    const itemWeights = items.map((item) => toCents(item?.price));
    const itemTotalCents = itemWeights.reduce((sum, cents) => sum + cents, 0);
    const rawDeclaredCents = toCents(bill?.amount);
    const receiptTotalCents = toCents(bill?.receiptTotal ?? bill?.reconciliation?.receiptTotal);
    const tipPercentage = Math.max(0, Number(bill?.tipPercentage) || 0);
    const declaredBaseCents = bill?.reconciliation?.status === 'matched_adjusted'
      ? (receiptTotalCents || (tipPercentage === 0 ? rawDeclaredCents : itemTotalCents))
      : itemTotalCents;
    const declaredCents = Math.round(declaredBaseCents * (1 + tipPercentage / 100));
    const payableItemCents = allocateCentsProportionally(declaredCents, itemWeights);
    let assignedCents = 0;
    items.forEach((item, index) => {
      const itemCents = payableItemCents[index];
      if (itemCents === 0) return;
      const claimantIds = [...new Set(
        (Array.isArray(item?.claimedBy) ? item.claimedBy : [])
          .map((claimant) => resolveMemberId(claimant, members))
          .filter(Boolean)
      )];
      if (claimantIds.length === 0) {
        unassignedCents += itemCents;
        return;
      }
      splitCents(itemCents, claimantIds).forEach(({ memberId, cents }) => {
        if (settledMemberIds.has(memberId)) return;
        assignedCents += cents;
        records.get(memberId).shareCents += cents;
        if (eachPaidOwnShare) records.get(memberId).paidCents += cents;
      });
    });

    if (!eachPaidOwnShare) records.get(payerId).paidCents += assignedCents;
    if (rawDeclaredCents > 0) {
      billAmountDifferenceCents += Math.abs(rawDeclaredCents - declaredCents);
    }
  });

  const balances = members.map((member) => {
    const record = records.get(member.id);
    const netCents = record.paidCents - record.shareCents;
    return {
      memberId: member.id,
      name: member.name || 'Member',
      totalPaid: fromCents(record.paidCents),
      totalShare: fromCents(record.shareCents),
      netBalance: fromCents(netCents),
      netCents,
    };
  });

  const balanceSumCents = balances.reduce((sum, balance) => sum + balance.netCents, 0);
  const rawTransactions = balanceSumCents === 0
    ? exactTransactions(balances.map((balance) => ({ id: balance.memberId, cents: balance.netCents })))
    : [];
  const memberById = new Map(members.map((member) => [member.id, member]));
  const transactions = rawTransactions.map((transaction) => ({
    fromId: transaction.fromId,
    fromName: memberById.get(transaction.fromId)?.name || 'Member',
    toId: transaction.toId,
    toName: memberById.get(transaction.toId)?.name || 'Member',
    toPhone: memberById.get(transaction.toId)?.phone || '',
    amount: fromCents(transaction.cents),
  }));

  return {
    balances: balances.map(({ netCents, ...balance }) => balance),
    transactions,
    unassignedAmount: fromCents(unassignedCents),
    billAmountDifference: fromCents(billAmountDifferenceCents),
    isBalanced: balanceSumCents === 0,
  };
}

module.exports = {
  calculateDebtMinimization,
  allocateCentsProportionally,
  allocateTipAdjustedCents,
  splitCents,
  toCents,
};
