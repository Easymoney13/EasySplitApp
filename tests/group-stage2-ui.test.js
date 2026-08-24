const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('Groups Stage 2 keeps group overview lightweight and settlement group-level', () => {
  const groupPage = source('src/app/group/[id]/page.tsx');
  assert.match(groupPage, /START_GROUP_SETTLEMENT/);
  assert.match(groupPage, /SET_GROUP_TRANSFER_PAID/);
  assert.match(groupPage, /CLOSE_GROUP/);
  assert.match(groupPage, /FINALIZE_BILL/);
  assert.doesNotMatch(groupPage, /tapMemberChipNotice/);
  assert.doesNotMatch(groupPage, /handleToggleItemClaim/);
});

test('group-linked split UI defers payment and normal splits retain the existing settlement path', () => {
  const sessionPage = source('src/app/session/[id]/page.tsx');
  assert.match(sessionPage, /isGroupLinked/);
  assert.match(sessionPage, /FINALIZE_BILL/);
  assert.match(sessionPage, /showSettleModal && !isGroupLinked/);
  assert.match(sessionPage, /Settle & Pay/);
});

test('closed groups are loaded only for History and active cards use lightweight summaries', () => {
  const homePage = source('src/app/page.tsx');
  assert.match(homePage, /scope: 'closed'/);
  assert.match(homePage, /activeTab !== 'history'/);
  assert.match(homePage, /g\.billsCount/);
  assert.match(homePage, /g\.totalSpent/);
});
