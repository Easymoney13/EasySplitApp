const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { calculateDebtMinimization } = require('../lib/debtMinimizer');
const { finalizeGroupBill, beginGroupSettlement } = require('../lib/groupLifecycle');

function groupFixture(overrides = {}) {
  return {
    id: 'grp_hardening',
    status: 'active',
    currency: 'NIS',
    members: [
      { id: 'host', name: 'Yoav', isHost: true, active: true },
      { id: 'guest', name: 'Naor', active: true },
      { id: 'inactive', name: 'Old Member', active: false },
    ],
    bills: [{
      id: 'bill_live',
      status: 'finalized',
      amount: 100,
      payerId: 'host',
      createdByMemberId: 'host',
      items: [{ id: 'i1', price: 100, claimedBy: ['guest'] }],
    }],
    ...overrides,
  };
}

test('legacy closed/completed/unknown bills never affect live group debt', () => {
  const base = groupFixture();
  const withLegacy = groupFixture({
    bills: [
      ...base.bills,
      { id: 'old_closed', status: 'closed', amount: 900, payerId: 'guest', items: [{ id: 'x1', price: 900, claimedBy: ['host'] }] },
      { id: 'old_completed', status: 'completed', amount: 800, payerId: 'guest', items: [{ id: 'x2', price: 800, claimedBy: ['host'] }] },
      { id: 'old_unknown', status: 'future-state', amount: 700, payerId: 'guest', items: [{ id: 'x3', price: 700, claimedBy: ['host'] }] },
    ],
  });
  assert.deepEqual(calculateDebtMinimization(withLegacy), calculateDebtMinimization(base));
});

test('inactive members are excluded from balances and an inactive-only claim becomes unassigned', () => {
  const group = groupFixture({
    bills: [{
      id: 'bill_inactive_claim', status: 'active', amount: 75, payerId: 'host', createdByMemberId: 'host',
      items: [{ id: 'i1', price: 75, claimedBy: ['inactive'] }],
    }],
  });
  const debt = calculateDebtMinimization(group);
  assert.deepEqual(debt.balances.map((b) => b.memberId).sort(), ['guest', 'host']);
  assert.equal(debt.unassignedAmount, 75);
  assert.deepEqual(debt.transactions, []);
});

test('a split cannot finalize when a priced item is claimed only by an inactive member', () => {
  const group = groupFixture({
    bills: [{
      id: 'bill_bad_claim', status: 'active', amount: 40, payerId: 'host', createdByMemberId: 'host',
      items: [{ id: 'i1', price: 40, claimedBy: ['inactive'] }],
    }],
  });
  assert.throws(() => finalizeGroupBill(group, 'bill_bad_claim', group.members[0]), /Assign every priced item/);
});

test('legacy claimant names remain valid only when they uniquely identify an active member', () => {
  const group = groupFixture({
    bills: [{
      id: 'bill_name_claim', status: 'active', amount: 40, payerId: 'Yoav', createdByMemberId: 'host',
      items: [{ id: 'i1', price: 40, claimedBy: ['Naor'] }],
    }],
  });
  const finalized = finalizeGroupBill(group, 'bill_name_claim', group.members[0]);
  assert.equal(finalized.bills[0].status, 'finalized');
  assert.equal(finalized.bills[0].payerId, 'host');
});

test('final settlement rejects a legacy finalized bill whose payer is missing or inactive', () => {
  for (const payerId of ['missing-member', 'inactive']) {
    const group = groupFixture({
      bills: [{
        id: `bill_${payerId}`, status: 'finalized', amount: 100, payerId, createdByMemberId: 'host',
        items: [{ id: 'i1', price: 100, claimedBy: ['guest'] }],
      }],
    });
    assert.throws(() => beginGroupSettlement(group, group.members[0]), /valid payer for every split/);
  }
});

test('debt calculation fails closed instead of assigning an explicit invalid payer to the first member', () => {
  const group = groupFixture({
    bills: [{
      id: 'bill_invalid_payer', status: 'finalized', amount: 100, payerId: 'does-not-exist', createdByMemberId: 'host',
      items: [{ id: 'i1', price: 100, claimedBy: ['guest'] }],
    }],
  });
  const debt = calculateDebtMinimization(group);
  assert.equal(debt.isBalanced, false);
  assert.deepEqual(debt.transactions, []);
});

test('50-bill hardening stress excludes inactive/legacy data and preserves exact money conservation', () => {
  const members = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `M${i}`, active: i < 10, isHost: i === 0 }));
  const bills = [];
  for (let b = 0; b < 50; b += 1) {
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: `b${b}_i${i}`,
      price: ((b + 3) * (i + 7)) % 97 + 0.37,
      claimedBy: [`m${(b + i) % 10}`, `m${(b + i + 3) % 10}`],
    }));
    bills.push({
      id: `bill${b}`,
      status: b % 9 === 0 ? 'completed' : 'finalized',
      amount: items.reduce((sum, item) => sum + item.price, 0),
      payerId: `m${b % 10}`,
      createdByMemberId: 'm0',
      items,
    });
  }
  const group = { id: 'max', status: 'active', currency: 'NIS', members, bills };
  const started = performance.now();
  const debt = calculateDebtMinimization(group);
  const elapsed = performance.now() - started;
  assert.equal(debt.balances.length, 10);
  assert.equal(debt.isBalanced, true);
  const netSum = Math.round(debt.balances.reduce((s, b) => s + b.netBalance, 0) * 100) / 100;
  assert.ok(Math.abs(netSum) < 0.001);
  const credits = Math.round(debt.balances.filter((b) => b.netBalance > 0).reduce((s, b) => s + b.netBalance, 0) * 100) / 100;
  const transfers = Math.round(debt.transactions.reduce((s, t) => s + t.amount, 0) * 100) / 100;
  assert.equal(transfers, credits);
  assert.ok(elapsed < 2000, `debt calculation took ${elapsed.toFixed(1)}ms`);
});

test('500 randomized mixed-state groups match an active-only canonical accounting view', () => {
  let state = 0x5eed1234;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const statuses = ['active', 'finalized', 'settled', 'closed', 'completed', 'mystery'];
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const memberCount = 2 + Math.floor(rand() * 8);
    const members = Array.from({ length: memberCount }, (_, i) => ({
      id: `m${i}`,
      name: `Member ${i}`,
      active: i < 2 ? true : rand() > 0.2,
      isHost: i === 0,
    }));
    const activeMembers = members.filter((m) => m.active !== false);
    const activeIds = activeMembers.map((m) => m.id);
    const bills = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, b) => {
      const status = statuses[Math.floor(rand() * statuses.length)];
      const itemCount = 1 + Math.floor(rand() * 8);
      const items = Array.from({ length: itemCount }, (_, i) => {
        const validClaim = activeIds[Math.floor(rand() * activeIds.length)];
        const maybeInactive = members[Math.floor(rand() * members.length)].id;
        const claimedBy = rand() < 0.12 ? [maybeInactive] : [validClaim];
        return { id: `b${b}i${i}`, price: 1 + Math.floor(rand() * 200) + 0.01 * Math.floor(rand() * 99), claimedBy };
      });
      return {
        id: `b${b}`,
        status,
        payerId: activeIds[Math.floor(rand() * activeIds.length)],
        amount: items.reduce((s, i) => s + i.price, 0),
        items,
      };
    });
    const group = { members, bills };
    const canonical = {
      members: activeMembers,
      bills: bills
        .filter((b) => !b.status || ['active', 'finalized'].includes(String(b.status).toLowerCase()))
        .map((b) => ({
          ...b,
          items: b.items.map((item) => ({ ...item, claimedBy: item.claimedBy.filter((id) => activeIds.includes(id)) })),
        })),
    };
    assert.deepEqual(calculateDebtMinimization(group), calculateDebtMinimization(canonical));
  }
});

test('legacy finalized payer names remain settleable when they uniquely match an active member', () => {
  const group = groupFixture({
    bills: [{
      id: 'legacy_name_payer', status: 'finalized', amount: 100, payerId: 'Yoav', createdByMemberId: 'host',
      items: [{ id: 'i1', price: 100, claimedBy: ['guest'] }],
    }],
  });
  const settling = beginGroupSettlement(group, group.members[0], () => 1234);
  assert.equal(settling.status, 'settling');
  assert.equal(settling.settlement.transfers.length, 1);
  assert.equal(settling.settlement.transfers[0].toId, 'host');
});

const fs = require('node:fs');
const path = require('node:path');

test('Stage 3 UI contracts fail closed on inconsistent balances and keep realtime recovery lightweight', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const groupPath = path.join(repoRoot, 'src/app/group/[id]/page.tsx');
  const sessionPath = path.join(repoRoot, 'src/app/session/[id]/page.tsx');
  if (!fs.existsSync(groupPath) || !fs.existsSync(sessionPath)) return;
  const groupSource = fs.readFileSync(groupPath, 'utf8');
  const sessionSource = fs.readFileSync(sessionPath, 'utf8');
  assert.match(groupSource, /const isGroupBalanceConsistent = group\?\.isBalanced !== false;/);
  assert.match(groupSource, /allOpenSplitsFinalized && unassignedAmount <= 0\.009 && isGroupBalanceConsistent/);
  assert.match(groupSource, /ws\.onclose = \(\) =>/);
  assert.match(groupSource, /socketRef\.current === ws/);
  assert.match(groupSource, /socketRef\.current = null;/);
  assert.match(sessionSource, /socketRef\.current = null;/);
  assert.doesNotMatch(sessionSource, /Payment happens when the group is settled\./);
});
