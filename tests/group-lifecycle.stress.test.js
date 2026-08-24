const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BILL_STATUS,
  beginGroupSettlement,
  setGroupTransferPaid,
  closeSettledGroup,
  summarizeGroup,
} = require('../lib/groupLifecycle');

function seededRandom(seed = 0x5eed1234) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

test('seeded multi-bill settlement stress preserves money and closes cleanly', () => {
  const random = seededRandom();

  for (let iteration = 0; iteration < 120; iteration += 1) {
    const memberCount = 2 + Math.floor(random() * 7);
    const members = Array.from({ length: memberCount }, (_, index) => ({
      id: `m_${iteration}_${index}`,
      name: `Member ${index}`,
      isHost: index === 0,
      active: true,
    }));
    const billCount = 1 + Math.floor(random() * 5);
    const bills = Array.from({ length: billCount }, (_, billIndex) => {
      const itemCount = 1 + Math.floor(random() * 8);
      const items = Array.from({ length: itemCount }, (_, itemIndex) => {
        const price = roundMoney(1 + random() * 250);
        const claimants = members.filter(() => random() > 0.55).map((member) => member.id);
        if (claimants.length === 0) claimants.push(members[Math.floor(random() * members.length)].id);
        return {
          id: `item_${iteration}_${billIndex}_${itemIndex}`,
          name: `Item ${itemIndex}`,
          price,
          claimedBy: claimants,
        };
      });
      const amount = roundMoney(items.reduce((sum, item) => sum + item.price, 0));
      return {
        id: `bill_${iteration}_${billIndex}`,
        title: `Bill ${billIndex}`,
        status: BILL_STATUS.FINALIZED,
        amount,
        payerId: members[Math.floor(random() * members.length)].id,
        createdByMemberId: members[0].id,
        items,
      };
    });
    const group = {
      id: `grp_${iteration}`,
      name: `Stress ${iteration}`,
      currency: 'NIS',
      members,
      bills,
    };

    let settling = beginGroupSettlement(group, members[0], () => 1_000 + iteration);
    const balanceSum = roundMoney(settling.settlement.balances.reduce((sum, balance) => sum + balance.netBalance, 0));
    assert.ok(Math.abs(balanceSum) < 0.001, `iteration ${iteration} should balance`);
    const creditorTotal = roundMoney(settling.settlement.balances
      .filter((balance) => balance.netBalance > 0)
      .reduce((sum, balance) => sum + balance.netBalance, 0));
    const transferTotal = roundMoney(settling.settlement.transfers.reduce((sum, transfer) => sum + transfer.amount, 0));
    assert.ok(Math.abs(transferTotal - creditorTotal) < 0.001, `iteration ${iteration} transfer total should match credits`);
    assert.equal(group.status, undefined, 'settlement must not mutate the source group');

    for (const transfer of [...settling.settlement.transfers]) {
      const payer = settling.members.find((member) => member.id === transfer.fromId);
      settling = setGroupTransferPaid(settling, transfer.id, true, payer, () => 5_000 + iteration);
    }
    const closed = closeSettledGroup(settling, settling.members[0], () => 10_000 + iteration);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.settlement.paymentsRemaining, 0);
    assert.ok(closed.bills.every((bill) => bill.status === BILL_STATUS.SETTLED));
    assert.equal(summarizeGroup(closed).billsCount, billCount);
  }
});
