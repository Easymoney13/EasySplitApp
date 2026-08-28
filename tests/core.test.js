const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUniqueRoomCode, hashAccessToken, tokenMatches } = require('../lib/ids');
const { ValidationError, validateItems, validateSessionAction, validateReceiptBody, validateUserSyncBody } = require('../lib/validation');
const { processSessionAction } = require('../lib/sessionActions');
const { createRoomMember, findRoomMember, joinRoom, publicRoom } = require('../lib/roomAuth');
const { broadcastToRoom, subscribeClient } = require('../lib/realtimeRooms');
const { calculateDebtMinimization, allocateTipAdjustedCents, splitCents } = require('../lib/debtMinimizer');
const { normalizeReceipt, haveSameReceiptValues, buildValueConsensus, selectBetterReceipt, parseReceiptImage } = require('../lib/gemini');
const { normalizeAmount, reconcileReceipt, getReceiptPayableTotal, isTotalOrTaxLine } = require('../lib/receiptMath');
const { assessReceipt } = require('../lib/receiptAssessment');
const { createStableScanEntityId, normalizeScanId, normalizeRecoveryToken, createAsyncGate, createExpiringPromiseCache } = require('../lib/ocrControl');
const { processGroupBillAction } = require('../lib/groupActions');
const security = require('../lib/security');
const { reconstructReceiptRows } = require('../lib/ocrRows');
const { reserveUniqueFirestoreRoomCode } = require('../lib/db');
const {
  assessOcrReadability,
  evaluateReceiptAccuracy,
  HEBREW_OCR_ACCEPTANCE_TARGET,
  haveSamePurchasedRows,
  hasRequiredHebrewVerification,
  normalizeOcrName,
} = require('../lib/ocrQuality');

function sampleSession() {
  return {
    id: 'sess_123456_abcdef',
    status: 'active',
    members: [
      { id: 'host-1', name: 'Alex', isHost: true },
      { id: 'member-1', name: 'Alex', isHost: false },
    ],
    items: [{ id: 'item-1', name: 'Pizza', price: 80, category: 'Food', claimedBy: [] }],
  };
}

test('user sync validation strips identity and account-structure field tampering', () => {
  const result = validateUserSyncBody({
    uid: 'victim-uid',
    id: 'victim-id',
    username: '<b>Alice</b>',
    groups: ['victim-group'],
    settings: {
      language: 'HE',
      currency: 'usd',
      theme: 'DARK',
      ocrEngine: 'GEMINI',
      role: 'admin',
      hiddenHistoryIds: ['victim-history'],
    },
  });
  assert.deepEqual(result, {
    username: 'Alice',
    settings: {
      language: 'he',
      currency: 'USD',
      theme: 'dark',
      ocrEngine: 'gemini',
    },
  });
});

test('room codes never reuse an occupied session or group code', () => {
  const data = { sessions: { a: { code: '12345678' } }, groups: { b: { code: '56781234' } } };
  const values = [12345678, 56781234, 90123456];
  const result = createUniqueRoomCode(data, () => values.shift());
  assert.equal(result, '90123456');
});

test('room code allocation finds a deterministic free code after random retries are exhausted', () => {
  const sessions = { occupied: { code: '10000000' } };
  const result = createUniqueRoomCode({ sessions, groups: {} }, () => 10000000);
  assert.equal(result, '10000001');
});

test('Firestore room codes are reserved atomically before room persistence', async () => {
  const created = [];
  const values = [12345678, 87654321];
  const firestore = {
    collection(name) {
      assert.equal(name, '_room_codes');
      return {
        doc(code) {
          return {
            async create(value) {
              created.push({ code, value });
              if (code === '12345678') throw Object.assign(new Error('occupied'), { code: 'already-exists' });
            },
          };
        },
      };
    },
  };

  const code = await reserveUniqueFirestoreRoomCode(firestore, 'session', 'sess_secure', () => values.shift());
  assert.equal(code, '87654321');
  assert.equal(created.length, 2);
  assert.equal(created[1].value.roomType, 'session');
  assert.equal(created[1].value.roomId, 'sess_secure');
});

test('access token hashes compare without exposing the token', () => {
  const hash = hashAccessToken('secret-token');
  assert.equal(tokenMatches('secret-token', hash), true);
  assert.equal(tokenMatches('wrong-token', hash), false);
});

test('group live session ids pass validation', () => {
  assert.equal(security.isValidSessionId('sess_g_bill_123_abc'), true);
});

test('invalid prices are rejected rather than invented', () => {
  assert.throws(() => validateItems([{ name: 'Unreadable', price: 'not-a-price' }]), ValidationError);
});

test('receipt validation accepts bounded image sections and rejects oversized batches', () => {
  const valid = validateReceiptBody({
    imageBase64Parts: ['data:image/jpeg;base64,/9j/', 'data:image/jpeg;base64,/9j/'],
    mimeType: 'image/jpeg',
    scanId: '550e8400-e29b-41d4-a716-446655440000',
  });
  assert.equal(valid.imageBase64Parts.length, 2);
  assert.equal(valid.scanId, '550e8400-e29b-41d4-a716-446655440000');
  assert.throws(() => validateReceiptBody({
    imageBase64Parts: Array.from({ length: 7 }, () => 'data:image/jpeg;base64,/9j/'),
  }), /more than 6 image sections/);
  assert.throws(() => validateReceiptBody({ imageBase64: 'not actually base64!' }), /valid base64/);
});

test('unknown session actions are rejected', () => {
  assert.throws(() => validateSessionAction('BECOME_HOST', {}), ValidationError);
});

test('members with the same display name remain distinct', () => {
  const updated = processSessionAction(
    sampleSession(),
    'TOGGLE_CLAIM',
    { itemId: 'item-1', memberId: 'member-1' },
    { memberId: 'member-1' },
    () => 1000,
  );
  assert.deepEqual(updated.items[0].claimedBy, ['member-1']);
});

test('explicit claim state is idempotent across a duplicated request', () => {
  const first = processSessionAction(
    sampleSession(),
    'TOGGLE_CLAIM',
    { itemId: 'item-1', memberId: 'member-1', claimed: true },
    { memberId: 'member-1' },
  );
  const replay = processSessionAction(
    first,
    'TOGGLE_CLAIM',
    { itemId: 'item-1', memberId: 'member-1', claimed: true },
    { memberId: 'member-1' },
  );
  assert.deepEqual(replay.items[0].claimedBy, ['member-1']);
});

test('a client-provided add-item id prevents duplicate rows on replay', () => {
  const payload = { itemId: 'item-stable', name: 'Tea', price: 4, category: 'Beverages' };
  const first = processSessionAction(sampleSession(), 'ADD_ITEM', payload, { memberId: 'host-1' });
  const replay = processSessionAction(first, 'ADD_ITEM', payload, { memberId: 'host-1' });
  assert.equal(replay.items.filter((item) => item.id === 'item-stable').length, 1);
});

test('a guest cannot perform a host action', () => {
  assert.throws(
    () => processSessionAction(sampleSession(), 'DELETE_ITEM', { itemId: 'item-1' }, { memberId: 'member-1' }),
    /Only the host/,
  );
});

test('a guest cannot claim an item for somebody else', () => {
  assert.throws(
    () => processSessionAction(sampleSession(), 'TOGGLE_CLAIM', { itemId: 'item-1', memberId: 'host-1' }, { memberId: 'member-1' }),
    /only claim items for yourself/,
  );
});

test('closed sessions are immutable', () => {
  const session = sampleSession();
  session.status = 'settled';
  assert.throws(
    () => processSessionAction(session, 'SET_TIP', { tipPercentage: 10 }, { memberId: 'host-1' }),
    /already closed/,
  );
});

test('a member can mark only their own share as paid without closing the session', () => {
  const updated = processSessionAction(
    sampleSession(),
    'TOGGLE_SETTLED',
    { memberId: 'member-1', settled: true },
    { memberId: 'member-1' },
    () => 1000,
  );
  assert.equal(updated.members.find((member) => member.id === 'member-1').settled, true);
  assert.equal(updated.status, 'active');
  assert.throws(
    () => processSessionAction(sampleSession(), 'TOGGLE_SETTLED', { memberId: 'host-1', settled: true }, { memberId: 'member-1' }),
    /only update your own payment status/,
  );
});

test('a paid member locks every accounting mutation until their share is reopened', () => {
  const paid = processSessionAction(
    sampleSession(),
    'TOGGLE_SETTLED',
    { memberId: 'member-1', settled: true },
    { memberId: 'member-1' },
  );
  assert.throws(
    () => processSessionAction(paid, 'TOGGLE_CLAIM', { itemId: 'item-1', memberId: 'member-1', claimed: true }, { memberId: 'member-1' }),
    /allocations are locked/,
  );
  assert.throws(
    () => processSessionAction(paid, 'SET_TIP', { tipPercentage: 12 }, { memberId: 'host-1' }),
    /allocations are locked/,
  );
  const reopened = processSessionAction(
    paid,
    'TOGGLE_SETTLED',
    { memberId: 'member-1', settled: false },
    { memberId: 'member-1' },
  );
  const claimed = processSessionAction(
    reopened,
    'TOGGLE_CLAIM',
    { itemId: 'item-1', memberId: 'member-1', claimed: true },
    { memberId: 'member-1' },
  );
  assert.deepEqual(claimed.items[0].claimedBy, ['member-1']);
});

test('room tokens authenticate exactly one member and are never exposed publicly', () => {
  const first = createRoomMember({ name: 'Noa', isHost: true });
  const second = createRoomMember({ name: 'Noa' });
  const room = { members: [first.member, second.member] };

  assert.equal(findRoomMember(room, { accessToken: first.accessToken }).id, first.member.id);
  assert.equal(findRoomMember(room, { accessToken: second.accessToken }).id, second.member.id);
  assert.equal(JSON.stringify(publicRoom(room)).includes('accessTokenHash'), false);
  const publicReceiptRoom = JSON.stringify(publicRoom({ ...room, scanId: 'secret-scan-id', inputDigest: 'private-digest' }));
  assert.equal(publicReceiptRoom.includes('secret-scan-id'), false);
  assert.equal(publicReceiptRoom.includes('private-digest'), false);
});

test('joining with the same name creates a distinct member without a valid token', () => {
  const host = createRoomMember({ name: 'Dana', isHost: true });
  const room = { members: [host.member] };
  const joined = joinRoom(room, { name: 'Dana', avatarColor: '#38BDF8' });

  assert.notEqual(joined.member.id, host.member.id);
  assert.equal(room.members.length, 2);
  assert.equal(joined.member.isHost, false);
});

test('concurrent authenticated rejoins keep both recently issued room tokens valid', () => {
  const first = createRoomMember({ uid: 'uid-1', name: 'Member' });
  const room = { members: [first.member] };
  const second = joinRoom(room, { uid: 'uid-1', name: 'Member' });
  const third = joinRoom(room, { uid: 'uid-1', name: 'Member' });
  assert.equal(findRoomMember(room, { accessToken: second.accessToken })?.id, 'uid-1');
  assert.equal(findRoomMember(room, { accessToken: third.accessToken })?.id, 'uid-1');
  assert.equal(publicRoom(room).members[0].accessTokenHashes, undefined);
});

test('rooms enforce a bounded participant count', () => {
  const room = { members: Array.from({ length: 100 }, (_, index) => ({ id: `member-${index}`, active: true })) };
  assert.throws(() => joinRoom(room, { name: 'Overflow' }), /participant limit/);
});

test('real-time broadcasts reach only subscribers of the matching room', () => {
  const sessionClient = { readyState: 1, sent: [], send(value) { this.sent.push(value); } };
  const otherSessionClient = { readyState: 1, sent: [], send(value) { this.sent.push(value); } };
  const groupClient = { readyState: 1, sent: [], send(value) { this.sent.push(value); } };
  subscribeClient(sessionClient, 'session', 'sess_one');
  subscribeClient(otherSessionClient, 'session', 'sess_two');
  subscribeClient(groupClient, 'group', 'grp_one');

  const recipients = broadcastToRoom(
    [sessionClient, otherSessionClient, groupClient],
    'session',
    'sess_one',
    { type: 'SESSION_UPDATE' }
  );

  assert.equal(recipients, 1);
  assert.equal(sessionClient.sent.length, 1);
  assert.equal(otherSessionClient.sent.length, 0);
  assert.equal(groupClient.sent.length, 0);
});

test('real-time authorization can revoke a stale room subscription before broadcast', () => {
  const client = { readyState: 1, sent: [], send(value) { this.sent.push(value); } };
  subscribeClient(client, 'group', 'grp_one', { memberId: 'member-1', tokenHash: 'hash-1' });
  const recipients = broadcastToRoom(
    [client],
    'group',
    'grp_one',
    { type: 'GROUP_UPDATE' },
    1,
    (candidate, key) => candidate.roomAuthorizations.get(key)?.memberId === 'still-active',
  );
  assert.equal(recipients, 0);
  assert.equal(client.subscriptions.has('group:grp_one'), false);
});

test('cent splitting preserves every cent deterministically', () => {
  const shares = splitCents(1001, ['a', 'b', 'c']);
  assert.deepEqual(shares.map((share) => share.cents), [334, 334, 333]);
  assert.equal(shares.reduce((sum, share) => sum + share.cents, 0), 1001);
});

test('group balances always sum to zero despite decimal rounding', () => {
  const result = calculateDebtMinimization({
    members: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ],
    bills: [{
      payerId: 'a',
      amount: 10.01,
      items: [{ price: 10.01, claimedBy: ['a', 'b', 'c'] }],
    }],
  });
  assert.equal(result.isBalanced, true);
  assert.equal(result.balances.reduce((sum, balance) => sum + Math.round(balance.netBalance * 100), 0), 0);
  assert.equal(result.transactions.reduce((sum, transaction) => sum + Math.round(transaction.amount * 100), 0), 667);
});

test('settled group shares and bills no longer produce payment transfers', () => {
  const members = [{ id: 'payer', name: 'Payer' }, { id: 'guest', name: 'Guest' }];
  const settledMemberResult = calculateDebtMinimization({
    members,
    bills: [{
      payerId: 'payer',
      amount: 20,
      settledMemberIds: ['guest'],
      items: [{ price: 20, claimedBy: ['guest'] }],
    }],
  });
  assert.deepEqual(settledMemberResult.transactions, []);
  assert.equal(settledMemberResult.isBalanced, true);

  const settledBillResult = calculateDebtMinimization({
    members,
    bills: [{
      payerId: 'payer',
      amount: 20,
      status: 'settled',
      items: [{ price: 20, claimedBy: ['guest'] }],
    }],
  });
  assert.deepEqual(settledBillResult.transactions, []);
  assert.equal(settledBillResult.isBalanced, true);
});

test('unassigned items are visible and never create phantom debt', () => {
  const result = calculateDebtMinimization({
    members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    bills: [{ payerId: 'a', amount: 12, items: [
      { price: 7, claimedBy: ['a', 'b'] },
      { price: 5, claimedBy: [] },
    ] }],
  });
  assert.equal(result.unassignedAmount, 5);
  assert.equal(result.isBalanced, true);
  assert.equal(result.balances.reduce((sum, balance) => sum + Math.round(balance.netBalance * 100), 0), 0);
});

test('matched receipt adjustments are allocated proportionally without losing cents', () => {
  const result = calculateDebtMinimization({
    members: [{ id: 'payer', name: 'Payer' }, { id: 'guest', name: 'Guest' }],
    bills: [{
      payerId: 'payer',
      amount: 100,
      reconciliation: { status: 'matched_adjusted' },
      items: [
        { price: 60, claimedBy: ['payer'] },
        { price: 30, claimedBy: ['guest'] },
      ],
    }],
  });
  assert.equal(result.isBalanced, true);
  assert.equal(result.billAmountDifference, 0);
  assert.equal(result.balances.reduce((sum, balance) => sum + Math.round(balance.totalShare * 100), 0), 10000);
  assert.equal(result.transactions[0].amount, 33.33);
});

test('group debt includes tip once and conserves the tipped cents', () => {
  const result = calculateDebtMinimization({
    members: [{ id: 'payer', name: 'Payer' }, { id: 'guest', name: 'Guest' }],
    bills: [{
      payerId: 'payer',
      amount: 110,
      tipPercentage: 10,
      items: [
        { price: 0.05, claimedBy: ['payer'] },
        { price: 99.95, claimedBy: ['guest'] },
      ],
    }],
  });
  assert.equal(result.isBalanced, true);
  assert.equal(result.balances.reduce((sum, balance) => sum + Math.round(balance.totalShare * 100), 0), 11000);
  assert.equal(result.transactions[0].amount, 109.94);
});

test('each-paid-own-share bills never create transfers between members', () => {
  const result = calculateDebtMinimization({
    members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    bills: [{
      payerId: 'each',
      amount: 100,
      items: [{ price: 100, claimedBy: ['a', 'b'] }],
    }],
  });
  assert.equal(result.isBalanced, true);
  assert.deepEqual(result.transactions, []);
  assert.deepEqual(result.balances.map((balance) => balance.netBalance), [0, 0]);
});

test('OCR drops unreadable prices instead of inventing a fallback amount', () => {
  const receipt = normalizeReceipt({
    storeName: 'Cafe',
    items: [
      { name: 'Coffee', price: 'unreadable' },
      { name: 'Cake', price: '18.50' },
    ],
  }, 'Cafe');
  assert.equal(receipt.items.length, 1);
  assert.equal(receipt.items[0].name, 'Cake');
  assert.equal(receipt.items[0].price, 18.5);
});

test('Hebrew OCR quality accepts readable receipt rows above the 96% release target', () => {
  const receipt = {
    documentLanguage: 'hebrew',
    storeName: 'מסעדת השולחן',
    currency: 'NIS',
    items: [
      { name: 'סלט יווני', price: 42 },
      { name: 'פיצה מרגריטה', price: 64 },
      { name: 'קולה זירו', price: 14 },
    ],
  };
  const quality = assessOcrReadability(receipt, { expectedLanguage: 'hebrew', confidence: 92 });
  const benchmark = evaluateReceiptAccuracy(receipt, receipt);
  assert.equal(quality.readable, true);
  assert.ok(quality.score >= HEBREW_OCR_ACCEPTANCE_TARGET);
  assert.equal(benchmark.passed, true);
  assert.equal(benchmark.accuracy, 1);
});

test('Hebrew OCR quality keeps mixed-brand receipts reviewable instead of rejecting them', () => {
  const quality = assessOcrReadability({
    documentLanguage: 'hebrew',
    currency: 'NIS',
    items: [
      { name: 'קולה זירו', price: 14 },
      { name: 'Coca Cola', price: 16 },
      { name: 'Sprite', price: 15 },
    ],
  }, { expectedLanguage: 'hebrew', confidence: 54 });
  assert.equal(quality.readable, true);
  assert.ok(quality.score >= 0.58);
});

test('Hebrew OCR quality rejects mojibake instead of displaying gibberish as items', () => {
  const quality = assessOcrReadability({
    documentLanguage: 'hebrew',
    currency: 'NIS',
    items: [
      { name: '×¤×™×¦×” ×ž×¨×’×¨×™×˜×”', price: 64 },
      { name: '×§×•×œ×” ×–×™×¨×•', price: 14 },
    ],
  }, { expectedLanguage: 'hebrew', confidence: 91 });
  assert.equal(quality.readable, false);
  assert.ok(quality.reasons.includes('invalid-unicode-output'));
  assert.ok(quality.reasons.includes('hebrew-script-mismatch'));
});

test('Hebrew OCR normalization removes dangerous bidi controls without reversing text', () => {
  assert.equal(normalizeOcrName(`\u202eפיצה מרגריטה\u202c`), 'פיצה מרגריטה');
  assert.equal(normalizeOcrName(`קולה\u200f זירו`), 'קולה זירו');
});

test('Hebrew OCR reconstructs an RTL item and its price from physical word coordinates', () => {
  const blocks = [{ paragraphs: [{ lines: [{ words: [
    { text: '45.00', confidence: 96, bbox: { x0: 1010, y0: 207, x1: 1126, y1: 240 } },
  ] }, { words: [
    { text: 'סלט', confidence: 91, bbox: { x0: 856, y0: 208, x1: 928, y1: 240 } },
    { text: 'יווני', confidence: 86, bbox: { x0: 785, y0: 216, x1: 837, y1: 239 } },
  ] }] }] }];
  assert.equal(reconstructReceiptRows(blocks), '45.00 סלט יווני');
});

test('OCR row reconstruction preserves LTR order on English receipts', () => {
  const blocks = [{ paragraphs: [{ lines: [{ words: [
    { text: 'Greek', confidence: 95, bbox: { x0: 30, y0: 100, x1: 100, y1: 130 } },
    { text: 'salad', confidence: 95, bbox: { x0: 110, y0: 100, x1: 170, y1: 130 } },
  ] }, { words: [
    { text: '45.00', confidence: 96, bbox: { x0: 400, y0: 101, x1: 470, y1: 130 } },
  ] }] }] }];
  assert.equal(reconstructReceiptRows(blocks), 'Greek salad 45.00');
});

test('Hebrew OCR replaces a damaged price only from the matching numeric pass coordinates', () => {
  const primary = [{ paragraphs: [{ lines: [{ words: [
    { text: '0', confidence: 70, bbox: { x0: 1010, y0: 300, x1: 1126, y1: 340 } },
    { text: 'פיצה', confidence: 90, bbox: { x0: 880, y0: 305, x1: 970, y1: 340 } },
    { text: 'מרגריטה', confidence: 91, bbox: { x0: 710, y0: 305, x1: 865, y1: 340 } },
  ] }] }] }];
  const numeric = [{ paragraphs: [{ lines: [{ words: [
    { text: '62.00', confidence: 96, bbox: { x0: 1010, y0: 307, x1: 1126, y1: 340 } },
    { text: '14.00', confidence: 96, bbox: { x0: 1010, y0: 407, x1: 1126, y1: 440 } },
  ] }] }] }];
  assert.equal(reconstructReceiptRows(primary, numeric), '62.00 פיצה מרגריטה');
});

test('Hebrew OCR benchmark fails when even one row name or price is wrong', () => {
  const expected = {
    items: [
      { name: 'סלט יווני', price: 42 },
      { name: 'פיצה מרגריטה', price: 64 },
      { name: 'קולה זירו', price: 14 },
    ],
  };
  const actual = {
    items: [
      { name: 'סלט יווני', price: 42 },
      { name: 'פיצה מרגריטה', price: 46 },
      { name: 'קולה זירו', price: 14 },
    ],
  };
  const result = evaluateReceiptAccuracy(expected, actual);
  assert.equal(result.passed, false);
  assert.ok(result.accuracy < HEBREW_OCR_ACCEPTANCE_TARGET);
});

test('Hebrew OCR name verification rejects a single-letter spelling disagreement', () => {
  assert.equal(haveSamePurchasedRows(
    { items: [{ name: 'פיצה מרגריטה', price: 62 }] },
    { items: [{ name: 'פיצה מרגריתא', price: 62 }] },
  ), false);
  assert.equal(haveSamePurchasedRows(
    { items: [{ name: 'פיצה מרגריטה', price: 62 }] },
    { items: [{ name: 'פיצה  מרגריטה', price: 62 }] },
  ), true);
});

test('server Hebrew OCR policy accepts readable review drafts but rejects missing evidence', () => {
  const items = [{ name: 'פיצה מרגריטה', price: 62 }];
  assert.equal(hasRequiredHebrewVerification({
    documentLanguage: 'hebrew',
    items,
    ocr: { source: 'gemini-vision', nameVerificationStatus: 'exact-cross-model-agreement' },
  }), true);
  assert.equal(hasRequiredHebrewVerification({
    documentLanguage: 'hebrew',
    items,
    ocr: { source: 'gemini-vision', nameVerificationStatus: 'review-required' },
  }), true);
  assert.equal(hasRequiredHebrewVerification({
    documentLanguage: 'hebrew',
    items,
    ocr: { source: 'client-tesseract', nameVerificationStatus: 'dual-hebrew-pass-agreement' },
  }), true);
  assert.equal(hasRequiredHebrewVerification({
    documentLanguage: 'hebrew',
    items,
    ocr: { source: 'client-tesseract', nameVerificationStatus: 'single-hebrew-pass-review' },
  }), true);
  assert.equal(hasRequiredHebrewVerification({ documentLanguage: 'hebrew', items }), false);
});

test('Gemini normalization rejects Hebrew-script mismatch before it reaches the editor', () => {
  const rejected = normalizeReceipt({
    storeName: 'מסעדה',
    documentLanguage: 'hebrew',
    currency: 'NIS',
    items: [{ name: 'P1zz@ xqv', lineTotal: 64 }],
  }, '{"documentLanguage":"hebrew"}');
  assert.equal(rejected, null);

  const accepted = normalizeReceipt({
    storeName: 'מסעדה',
    documentLanguage: 'hebrew',
    currency: 'NIS',
    items: [{ name: 'פיצה מרגריטה', lineTotal: 64 }],
  }, '{"documentLanguage":"hebrew"}');
  assert.equal(accepted.items[0].name, 'פיצה מרגריטה');
  assert.equal(accepted.ocrQuality.readable, true);
});

test('OCR uses the full line total when a receipt row contains multiple units', () => {
  const receipt = normalizeReceipt({
    storeName: 'Cafe',
    receiptTotal: 36,
    items: [{ name: 'Coffee', quantity: 3, unitPrice: 12, lineTotal: 36 }],
  }, 'Cafe');
  assert.equal(receipt.items[0].name, 'Coffee (3x)');
  assert.equal(receipt.items[0].price, 36);
});

test('OCR normalizes negative printed discounts as positive adjustment amounts', () => {
  const receipt = normalizeReceipt({
    storeName: 'Cafe',
    receiptTotal: 90,
    subtotal: 100,
    discount: -10,
    items: [{ name: 'Meal', lineTotal: 100 }],
  }, 'Cafe');
  assert.equal(receipt.discount, 10);
});

test('OCR verification refuses to add a row merely to reconcile the total', () => {
  const first = { receiptTotal: 100, items: [{ name: 'Meal', price: 60 }] };
  const second = { receiptTotal: 100, items: [{ name: 'Meal', price: 60 }, { name: 'Drink', price: 40 }] };
  assert.equal(selectBetterReceipt(first, second), first);
});

test('OCR verification never changes a value merely to improve reconciliation', () => {
  const first = { receiptTotal: 100, items: [{ name: 'Meal', price: 60 }, { name: 'Drink', price: 30 }] };
  const second = { receiptTotal: 100, items: [{ name: 'Meal', price: 60 }, { name: 'Drink', price: 40 }] };
  assert.equal(haveSameReceiptValues(first, second), false);
  assert.equal(selectBetterReceipt(first, second), first);
});

test('OCR numeric consensus changes a price only when two independent reads agree', () => {
  const base = {
    storeName: 'מסעדה',
    date: '2026-08-23',
    currency: 'NIS',
    receiptTotal: 69,
    items: [{ name: 'כרוב ממולא', price: 9, lineTotal: 9, quantity: 1, unitPrice: 9 }],
  };
  const verification = {
    ...base,
    items: [{ ...base.items[0], price: 69, lineTotal: 69, unitPrice: 69 }],
  };
  const tiebreaker = {
    ...verification,
    items: [{ ...verification.items[0] }],
  };
  const consensus = buildValueConsensus(base, verification, tiebreaker);
  assert.equal(consensus.receipt.items[0].price, 69);
  assert.equal(consensus.resolvedItemPrices, 1);
  assert.equal(consensus.unresolvedItemPrices, 0);
  assert.equal(consensus.changedValues, 1);

  const unresolved = buildValueConsensus(base, verification, {
    ...base,
    items: [{ ...base.items[0], price: 89, lineTotal: 89, unitPrice: 89 }],
  });
  assert.equal(unresolved.receipt.items[0].price, 9);
  assert.equal(unresolved.resolvedItemPrices, 0);
  assert.equal(unresolved.unresolvedItemPrices, 1);
});

test('OCR starts three independent reads and resolves numeric disagreement by majority', async () => {
  const originalFetch = global.fetch;
  const endpoints = [];
  const prices = [9, 69, 69];
  global.fetch = async (endpoint) => {
    endpoints.push(String(endpoint));
    const price = prices[endpoints.length - 1];
    return {
      ok: true,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            storeName: 'מסעדה',
            date: '2026-08-23',
            currency: 'NIS',
            documentLanguage: 'hebrew',
            receiptTotal: 69,
            items: [{ name: 'כרוב ממולא', lineTotal: price }],
          }) }] } }],
        };
      },
    };
  };
  try {
    const receipt = await parseReceiptImage('/9j/', 'image/jpeg', 'test-key', { pipelineTimeoutMs: 12_000 });
    assert.equal(endpoints.length, 3);
    assert.match(endpoints[0], /gemini-3\.6-flash:generateContent/);
    assert.match(endpoints[1], /gemini-3\.5-flash:generateContent/);
    assert.match(endpoints[2], /gemini-3\.5-flash-lite:generateContent/);
    assert.equal(receipt.items[0].price, 69);
    assert.equal(receipt.ocr.verificationStatus, 'value_consensus');
    assert.equal(receipt.ocr.resolvedItemPrices, 1);
    assert.equal(receipt.ocr.unresolvedItemPrices, 0);
    assert.equal(receipt.ocr.nameVerificationStatus, 'exact-cross-model-agreement');
  } finally {
    global.fetch = originalFetch;
  }
});

test('OCR verification uses a different pinned model from the primary read', async () => {
  const originalFetch = global.fetch;
  const endpoints = [];
  const payloads = [];
  global.fetch = async (endpoint, options) => {
    endpoints.push(String(endpoint));
    payloads.push(JSON.parse(options.body));
    return {
      ok: true,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            storeName: 'Cafe',
            date: '2026-08-18',
            currency: 'NIS',
            receiptTotal: 10,
            items: [{ name: 'Tea', lineTotal: 10 }],
          }) }] } }],
        };
      },
    };
  };
  try {
    const receipt = await parseReceiptImage('/9j/', 'image/jpeg', 'test-key', { pipelineTimeoutMs: 12_000 });
    assert.equal(endpoints.length, 3);
    assert.match(endpoints[0], /gemini-3\.6-flash:generateContent/);
    assert.match(endpoints[1], /gemini-3\.5-flash:generateContent/);
    assert.match(endpoints[2], /gemini-3\.5-flash-lite:generateContent/);
    assert.equal(payloads[0].generationConfig.thinkingConfig.thinkingLevel, 'low');
    assert.equal(Object.hasOwn(payloads[0].generationConfig, 'temperature'), false);
    assert.equal(receipt.ocr.verificationStatus, 'cross_model_agreement');
    assert.equal(receipt.ocr.verificationModelName, 'gemini-3.5-flash');
    assert.equal(receipt.ocr.successfulModelReads, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OCR model reads run concurrently instead of adding their latencies', async () => {
  const originalFetch = global.fetch;
  const starts = [];
  let callCount = 0;
  global.fetch = async (_endpoint, options) => {
    const index = callCount;
    callCount += 1;
    starts.push(Date.now());
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, [35, 70, 105][index]);
      options.signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
    return {
      ok: true,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            storeName: 'Cafe',
            date: '2026-08-18',
            currency: 'NIS',
            receiptTotal: 10,
            items: [{ name: 'Tea', lineTotal: 10 }],
          }) }] } }],
        };
      },
    };
  };
  try {
    const startedAt = Date.now();
    const receipt = await parseReceiptImage('/9j/', 'image/jpeg', 'test-key', { pipelineTimeoutMs: 2_000 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(callCount, 3);
    assert.ok(Math.max(...starts) - Math.min(...starts) < 30, `model starts were ${Math.max(...starts) - Math.min(...starts)}ms apart`);
    assert.ok(elapsedMs < 100, `parallel quorum OCR took ${elapsedMs}ms`);
    assert.equal(receipt.ocr.verificationStatus, 'cross_model_agreement');
    assert.ok(receipt.ocr.providerDurationMs < 100);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OCR reaches the bounded fallback pool when the fast model quorum is unavailable', async () => {
  const originalFetch = global.fetch;
  const endpoints = [];
  global.fetch = async (endpoint) => {
    endpoints.push(String(endpoint));
    if (endpoints.length <= 3) return { ok: false, status: 503 };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            storeName: 'חשבון לקוח',
            date: '2026-08-24',
            currency: 'NIS',
            documentLanguage: 'hebrew',
            receiptTotal: 237,
            items: [
              { name: 'עראייס', lineTotal: 59 },
              { name: 'סיגרי ומח עצם', lineTotal: 165 },
              { name: 'קולה זירו', lineTotal: 13 },
            ],
          }) }] } }],
        };
      },
    };
  };
  try {
    const receipt = await parseReceiptImage('/9j/', 'image/jpeg', 'test-key', {
      pipelineTimeoutMs: 2_000,
      fallbackTimeoutMs: 2_000,
      verificationGraceMs: 250,
    });
    assert.equal(endpoints.length, 5);
    assert.match(endpoints[3], /gemini-2\.5-flash:generateContent/);
    assert.match(endpoints[4], /gemini-flash-latest:generateContent/);
    assert.equal(receipt.items.length, 3);
    assert.equal(receipt.receiptTotal, 237);
    assert.equal(receipt.ocr.verificationStatus, 'cross_model_agreement');
    assert.equal(receipt.ocr.modelAttempts, 5);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OCR provider outages are not mislabeled as unreadable receipt images', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503 });
  try {
    await assert.rejects(
      parseReceiptImage('/9j/', 'image/jpeg', 'test-key', {
        pipelineTimeoutMs: 2_000,
        fallbackTimeoutMs: 2_000,
        verificationGraceMs: 250,
      }),
      (error) => error?.statusCode === 503 && error?.errorCode === 'OCR_PROVIDER_UNAVAILABLE',
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('Hebrew Gemini OCR keeps a readable primary draft on a one-letter verifier disagreement', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    const name = ['פיצה מרגריטה', 'פיצה מרגריתא', 'פיצה מרגרטה'][callCount - 1];
    return {
      ok: true,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            storeName: 'מסעדה',
            date: '2026-08-19',
            currency: 'NIS',
            documentLanguage: 'hebrew',
            receiptTotal: 62,
            items: [{ name, lineTotal: 62 }],
          }) }] } }],
        };
      },
    };
  };
  try {
    const receipt = await parseReceiptImage('/9j/', 'image/jpeg', 'test-key', { pipelineTimeoutMs: 12_000 });
    assert.equal(receipt.items[0].name, 'פיצה מרגריטה');
    assert.equal(receipt.ocr.verificationStatus, 'row_disagreement');
    assert.equal(receipt.ocr.nameVerificationStatus, 'review-required');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Hebrew Gemini OCR keeps a readable primary draft when verification is unavailable', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    if (callCount > 1) return { ok: false };
    return {
      ok: true,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            storeName: 'מסעדה',
            date: '2026-08-19',
            currency: 'NIS',
            documentLanguage: 'hebrew',
            receiptTotal: 76,
            items: [
              { name: 'פיצה מרגריטה', lineTotal: 62 },
              { name: 'קולה זירו', lineTotal: 14 },
            ],
          }) }] } }],
        };
      },
    };
  };
  try {
    const receipt = await parseReceiptImage('/9j/', 'image/jpeg', 'test-key', { pipelineTimeoutMs: 12_000 });
    assert.equal(receipt.items.length, 2);
    assert.equal(receipt.ocr.verificationStatus, 'verification_failed');
    assert.equal(receipt.ocr.nameVerificationStatus, 'review-required');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Hebrew Gemini OCR records exact cross-model name agreement', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          storeName: 'מסעדה',
          date: '2026-08-19',
          currency: 'NIS',
          documentLanguage: 'hebrew',
          receiptTotal: 62,
          items: [{ name: 'פיצה מרגריטה', lineTotal: 62 }],
        }) }] } }],
      };
    },
  });
  try {
    const receipt = await parseReceiptImage('/9j/', 'image/jpeg', 'test-key', { pipelineTimeoutMs: 12_000 });
    assert.equal(receipt.ocr.verificationStatus, 'cross_model_agreement');
    assert.equal(receipt.ocr.nameVerificationStatus, 'exact-cross-model-agreement');
  } finally {
    global.fetch = originalFetch;
  }
});

test('adjustment labels are never accepted as purchased items', () => {
  for (const label of [
    'Service charge', 'Service fee', 'Service 10%', 'VAT 17%', 'Discount coupon',
    'Member discount', 'Club discount', 'Discount member',
    'Tip', 'שירות', 'דמי שירות 12%', '12% דמי שירות', '17% מעמ', 'טיפ', 'הנחה',
    'הנחת מועדון', 'הנחת חבר', 'הנחת קופון',
  ]) {
    assert.equal(isTotalOrTaxLine(label), true);
  }
  for (const purchasedItem of ['Tip Top Ice Cream', 'Serviceberry Pie', 'Taxi ride', 'טיפ טופ גלידה']) {
    assert.equal(isTotalOrTaxLine(purchasedItem), false);
  }
});

test('tip cents are allocated once and always conserve the grand total', () => {
  const tippedShares = allocateTipAdjustedCents([5, 9995], 10);
  assert.deepEqual(tippedShares, [6, 10994]);
  assert.equal(tippedShares.reduce((sum, cents) => sum + cents, 0), 11000);
});

test('receipt reconciliation flags a meaningful mismatch for review', () => {
  const result = reconcileReceipt({
    receiptTotal: 100,
    subtotal: 90,
    tax: 5,
    service: 5,
    items: [{ price: 40 }, { price: 30 }],
  });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.needsReview, true);
  assert.equal(result.difference, 20);
});

test('missing optional amounts remain missing instead of becoming zero', () => {
  assert.equal(normalizeAmount(null), null);
  assert.equal(normalizeAmount(undefined), null);
  assert.equal(normalizeAmount(''), null);
  const result = reconcileReceipt({
    receiptTotal: 100,
    subtotal: null,
    items: [{ price: 60 }, { price: 40 }],
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.subtotal, null);
  assert.equal(result.needsReview, false);
});

test('receipt reconciliation accepts matching totals with adjustments', () => {
  const result = reconcileReceipt({
    receiptTotal: 100,
    subtotal: 90,
    tax: 5,
    service: 5,
    items: [{ price: 45 }, { price: 45 }],
  });
  assert.equal(result.status, 'matched_adjusted');
  assert.equal(result.needsReview, false);
  assert.equal(getReceiptPayableTotal({ reconciliation: result }), 100);
});

test('receipt reconciliation accepts a printed negative discount field', () => {
  const result = reconcileReceipt({
    receiptTotal: 90,
    subtotal: 100,
    discount: -10,
    items: [{ price: 60 }, { price: 40 }],
  });
  assert.equal(result.discount, 10);
  assert.equal(result.status, 'matched_adjusted');
});

test('large receipts do not receive a percentage-sized reconciliation tolerance', () => {
  const result = reconcileReceipt({ receiptTotal: 1000, items: [{ price: 991 }] });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.needsReview, true);
});

test('receipt reconciliation does not let an unanchored adjustment hide a missing item', () => {
  const result = reconcileReceipt({
    receiptTotal: 100,
    service: 10,
    items: [{ price: 60 }, { price: 30 }],
  });
  assert.equal(result.status, 'ambiguous_adjustments');
  assert.equal(result.needsReview, true);
});

test('receipt assessment requires confirmation and escalates row disagreement', () => {
  const receipt = {
    receiptTotal: 100,
    items: [{ name: 'Meal', price: 100 }],
    ocr: { verificationStatus: 'row_disagreement' },
  };
  const assessment = assessReceipt(receipt, { source: 'gemini-vision' });
  assert.equal(assessment.level, 'high');
  assert.equal(assessment.requiresUserConfirmation, true);
  assert.ok(assessment.reasons.includes('verification-row-disagreement'));
  const confirmed = assessReceipt(receipt, { source: 'gemini-vision', confirmedByUser: true });
  assert.equal(confirmed.requiresUserConfirmation, false);
  assert.equal(confirmed.confirmedByUser, true);
});

test('receipt assessment keeps partial numeric consensus in mandatory review', () => {
  const assessment = assessReceipt({
    receiptTotal: 100,
    items: [{ name: 'Meal', price: 100 }],
    ocr: { verificationStatus: 'partial_value_consensus' },
  }, { source: 'gemini-vision' });
  assert.equal(assessment.level, 'high');
  assert.ok(assessment.reasons.includes('verification-partial-value-consensus'));
});

test('scan ids create deterministic owner-scoped entity ids', () => {
  const scanId = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(normalizeScanId(scanId), scanId);
  assert.equal(createStableScanEntityId('sess_scan', 'owner-a', scanId), createStableScanEntityId('sess_scan', 'owner-a', scanId));
  assert.notEqual(createStableScanEntityId('sess_scan', 'owner-a', scanId), createStableScanEntityId('sess_scan', 'owner-b', scanId));
  assert.equal(security.isValidSessionId(createStableScanEntityId('sess_scan', 'owner-a', scanId)), true);
  assert.equal(normalizeScanId('short'), '');
  assert.equal(normalizeRecoveryToken('short'), '');
  assert.equal(normalizeRecoveryToken('recovery_550e8400-e29b-41d4-a716-446655440000_550e8400-e29b-41d4-a716-446655440001').startsWith('recovery_'), true);
});

test('OCR promise cache coalesces simultaneous retries', async () => {
  const cache = createExpiringPromiseCache({ ttlMs: 1000, maxEntries: 5 });
  let calls = 0;
  const operation = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true };
  };
  const [first, second] = await Promise.all([cache.run('same-scan', operation), cache.run('same-scan', operation)]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});

test('OCR concurrency gate never exceeds its configured limit', async () => {
  const gate = createAsyncGate({ maxConcurrent: 2, maxQueue: 5, waitTimeoutMs: 200 });
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    const release = await gate.acquire();
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    release();
  }));
  assert.equal(peak, 2);
  assert.deepEqual(gate.state(), { active: 0, queued: 0 });
});

test('OCR concurrency gate rejects overflow and a release is idempotent', async () => {
  const gate = createAsyncGate({ maxConcurrent: 1, maxQueue: 1, waitTimeoutMs: 100 });
  const releaseFirst = await gate.acquire();
  const queued = gate.acquire();
  await assert.rejects(() => gate.acquire(), /busy/);
  releaseFirst();
  releaseFirst();
  const releaseSecond = await queued;
  assert.deepEqual(gate.state(), { active: 1, queued: 0 });
  releaseSecond();
  assert.deepEqual(gate.state(), { active: 0, queued: 0 });
});

test('timed-out OCR queue entries are removed', async () => {
  const gate = createAsyncGate({ maxConcurrent: 1, maxQueue: 1, waitTimeoutMs: 5 });
  const release = await gate.acquire();
  await assert.rejects(() => gate.acquire(), /busy/);
  assert.deepEqual(gate.state(), { active: 1, queued: 0 });
  release();
});

test('failed cached OCR work is evicted so a retry can recover', async () => {
  const cache = createExpiringPromiseCache({ ttlMs: 1000, maxEntries: 5 });
  let calls = 0;
  await assert.rejects(() => cache.run('retryable-scan', async () => {
    calls += 1;
    throw new Error('temporary');
  }), /temporary/);
  const recovered = await cache.run('retryable-scan', async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(recovered, 'ok');
  assert.equal(calls, 2);
});

test('receipt reconciliation does not add VAT twice when it is already included', () => {
  const result = reconcileReceipt({
    receiptTotal: 100,
    tax: 15.25,
    items: [{ price: 60 }, { price: 40 }],
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.calculatedTotal, 100);
  assert.equal(result.calculationMode, 'items');
});

test('group members can claim only for themselves without rewriting a bill', () => {
  const group = {
    members: [{ id: 'host', isHost: true }, { id: 'guest', isHost: false }],
    bills: [{ id: 'bill', createdByMemberId: 'host', items: [{ id: 'item', claimedBy: [] }] }],
  };
  const updated = processGroupBillAction(group, 'TOGGLE_CLAIM', { billId: 'bill', itemId: 'item' }, group.members[1]);
  assert.deepEqual(updated.bills[0].items[0].claimedBy, ['guest']);
  assert.deepEqual(group.bills[0].items[0].claimedBy, []);
});

test('group members cannot change somebody else’s bill payer', () => {
  const group = {
    members: [{ id: 'host', isHost: true }, { id: 'guest', isHost: false }],
    bills: [{ id: 'bill', createdByMemberId: 'host', payerId: 'host', items: [] }],
  };
  assert.throws(
    () => processGroupBillAction(group, 'SET_PAYER', { billId: 'bill', payerId: 'guest' }, group.members[1]),
    /Only the bill creator/
  );
});

test('settled group bills are immutable', () => {
  const group = {
    members: [{ id: 'host', isHost: true }],
    bills: [{ id: 'bill', status: 'settled', createdByMemberId: 'host', items: [{ id: 'item', claimedBy: [] }] }],
  };
  assert.throws(
    () => processGroupBillAction(group, 'TOGGLE_CLAIM', { billId: 'bill', itemId: 'item' }, group.members[0]),
    /already settled/
  );
});

test('inactive members cannot authenticate with their former room token', () => {
  const created = createRoomMember({ name: 'Former member' });
  created.member.active = false;
  assert.equal(findRoomMember({ members: [created.member] }, { accessToken: created.accessToken }), null);
});

test('session settlement persists the closed session and history in one database write', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'billsplit-db-test-'));
  const temporaryDbPath = path.join(temporaryDirectory, 'db.json');
  fs.writeFileSync(temporaryDbPath, JSON.stringify({
    users: {
      host: { id: 'host', username: 'Same Name', bills: [] },
      legacy: { id: 'legacy', username: 'Same Name', phone: '', bills: ['legacy-bill'] },
      inactive: { id: 'inactive', groups: [] },
    },
    sessions: {},
    history: [],
    groups: {},
  }));
  const previousPath = process.env.BILLSPLIT_DB_PATH;
  process.env.BILLSPLIT_DB_PATH = temporaryDbPath;
  delete require.cache[require.resolve('../lib/db')];
  const temporaryDb = require('../lib/db');

  const session = { id: 'sess_test_atomic', status: 'settled', members: [{ id: 'host' }] };
  const history = { id: session.id, members: session.members, totalAmount: 12.5 };
  temporaryDb.saveSessionAndHistory(session, history);
  const persisted = JSON.parse(fs.readFileSync(temporaryDbPath, 'utf8'));

  assert.equal(persisted.sessions[session.id].status, 'settled');
  assert.equal(persisted.history[0].id, session.id);
  assert.equal(persisted.users.host.bills[0].id, session.id);

  temporaryDb.hideHistoryForUser('host', session.id);
  const afterHide = JSON.parse(fs.readFileSync(temporaryDbPath, 'utf8'));
  assert.equal(afterHide.history[0].id, session.id);
  assert.deepEqual(afterHide.users.host.hiddenHistoryIds, [session.id]);

  const firstCreate = temporaryDb.createSessionIfAbsent({ id: 'sess_idempotent', code: '1111', members: [] });
  const secondCreate = temporaryDb.createSessionIfAbsent({ id: 'sess_idempotent', code: '2222', members: [] });
  assert.equal(firstCreate.created, true);
  assert.equal(secondCreate.created, false);
  assert.equal(secondCreate.session.code, '1111');

  temporaryDb.saveGroup({ id: 'grp-atomic-bill', members: [{ id: 'host', isHost: true }], bills: [] });
  const atomicBill = temporaryDb.saveGroupBillAndSession(
    'grp-atomic-bill',
    { id: 'bill-atomic', createdByMemberId: 'host', contentDigest: 'digest-1', revision: 1, items: [] },
    { id: 'sess-atomic-bill', groupId: 'grp-atomic-bill', billId: 'bill-atomic' },
    'host',
  );
  assert.equal(atomicBill.group.bills[0].id, 'bill-atomic');
  assert.equal(atomicBill.session.billId, 'bill-atomic');
  const atomicReplay = temporaryDb.saveGroupBillAndSession(
    'grp-atomic-bill',
    { id: 'bill-atomic', createdByMemberId: 'host', contentDigest: 'digest-1', revision: 1, items: [] },
    { id: 'sess-atomic-bill', groupId: 'grp-atomic-bill', billId: 'bill-atomic' },
    'host',
    null,
  );
  assert.equal(atomicReplay.idempotentReplay, true);

  temporaryDb.transactSessionAndLinkedGroup('sess-atomic-bill', (currentSession, currentGroup) => ({
    session: { ...currentSession, revision: Number(currentSession.revision || 0) + 1 },
    group: currentGroup,
  }));
  const secondSessionMutation = temporaryDb.transactSessionAndLinkedGroup('sess-atomic-bill', (currentSession, currentGroup) => ({
    session: { ...currentSession, revision: Number(currentSession.revision || 0) + 1 },
    group: currentGroup,
    history: { id: currentSession.id, totalAmount: 42, members: [], memberIds: ['host'] },
  }));
  assert.equal(secondSessionMutation.session.revision, 2);
  assert.equal(secondSessionMutation.history.totalAmount, 42);
  assert.equal(JSON.parse(fs.readFileSync(temporaryDbPath, 'utf8')).history[0].id, 'sess-atomic-bill');
  assert.equal(temporaryDb.getHistoryForUser('host')[0].totalAmount, 42);
  const paginationData = JSON.parse(fs.readFileSync(temporaryDbPath, 'utf8'));
  paginationData.history.push(
    { id: 'hist-new', memberIds: ['host'], settledAt: 300, totalAmount: 30 },
    { id: 'hist-middle', memberIds: ['host'], settledAt: 200, totalAmount: 20 },
    { id: 'hist-old', memberIds: ['host'], settledAt: 100, totalAmount: 10 },
  );
  fs.writeFileSync(temporaryDbPath, JSON.stringify(paginationData), 'utf8');
  assert.deepEqual(temporaryDb.getHistoryForUser('host', 2, 0).map((entry) => entry.id), ['hist-new', 'hist-middle']);
  assert.deepEqual(temporaryDb.getHistoryForUser('host', 2, 2).map((entry) => entry.id), ['hist-old', 'sess-atomic-bill']);
  const historyPage = temporaryDb.getHistoryPageForUser('host', 3, 1);
  assert.equal(historyPage.rawCount, 3);
  assert.deepEqual(historyPage.slots.map((entry) => entry.id), ['hist-middle', 'hist-old', 'sess-atomic-bill']);
  assert.deepEqual(temporaryDb.getResolvableHistoryPointerIds('host', ['hist-new', 'legacy-only']), ['hist-new']);
  const danglingPointerData = JSON.parse(fs.readFileSync(temporaryDbPath, 'utf8'));
  danglingPointerData.historyPointers = {
    host: [{ id: 'missing-central', historyId: 'missing-central' }, { id: 'hist-new', historyId: 'hist-new' }],
  };
  fs.writeFileSync(temporaryDbPath, JSON.stringify(danglingPointerData), 'utf8');
  const danglingPage = temporaryDb.getHistoryPageForUser('host', 2, 0);
  assert.equal(danglingPage.rawCount, 2);
  assert.equal(danglingPage.slots[0], null);
  assert.equal(danglingPage.slots[1].id, 'hist-new');
  assert.deepEqual(
    temporaryDb.getResolvableHistoryPointerIds('host', ['missing-central', 'hist-new']),
    ['hist-new'],
  );
  delete danglingPointerData.historyPointers;
  fs.writeFileSync(temporaryDbPath, JSON.stringify(danglingPointerData), 'utf8');

  temporaryDb.saveGroup({
    id: 'grp-concurrent',
    members: [{ id: 'host', isHost: true }, { id: 'guest', isHost: false }],
    bills: [{
      id: 'bill-concurrent', sessionId: 'sess-concurrent', createdByMemberId: 'host', payerId: 'host', status: 'active',
      items: [{ id: 'line-1', name: 'Old', price: 10, claimedBy: ['guest'] }],
    }],
  });
  temporaryDb.saveSession({
    id: 'sess-concurrent', groupId: 'grp-concurrent', billId: 'bill-concurrent', status: 'active', payerId: 'host', tipPercentage: 12,
    members: [{ id: 'host', settled: true }, { id: 'guest', settled: false }],
    items: [{ id: 'line-1', name: 'Old', price: 10, claimedBy: ['guest'] }],
  });
  const concurrentBillUpdate = () => temporaryDb.saveGroupBillAndSession(
    'grp-concurrent',
    { id: 'bill-concurrent', sessionId: 'sess-concurrent', createdByMemberId: 'host', payerId: 'guest', status: 'active', items: [{ id: 'line-1', name: 'Corrected', price: 11, claimedBy: [] }] },
    { id: 'sess-concurrent', groupId: 'grp-concurrent', billId: 'bill-concurrent', status: 'active', payerId: 'guest', members: [], items: [{ id: 'line-1', name: 'Corrected', price: 11, claimedBy: [] }] },
    'host',
    0,
  );
  assert.throws(concurrentBillUpdate, /allocations are locked/);
  temporaryDb.transactSessionAndLinkedGroup('sess-concurrent', (currentSession, currentGroup) => ({
    session: {
      ...currentSession,
      members: currentSession.members.map((member) => ({ ...member, settled: false })),
    },
    group: currentGroup,
  }));
  const concurrentSave = concurrentBillUpdate();
  assert.deepEqual(concurrentSave.session.items[0].claimedBy, ['guest']);
  assert.equal(concurrentSave.session.members.find((member) => member.id === 'host').settled, false);
  assert.equal(concurrentSave.session.tipPercentage, 12);
  assert.equal(concurrentSave.session.payerId, 'host');
  assert.equal(concurrentSave.group.bills[0].payerId, 'host');

  assert.throws(
    () => temporaryDb.leaveGroup('grp-concurrent', 'host'),
    /Settle or reassign this member’s active bill shares/,
  );
  const reassignedGroup = temporaryDb.getGroup('grp-concurrent');
  reassignedGroup.bills[0].payerId = 'guest';
  temporaryDb.saveGroup(reassignedGroup);
  const groupAfterHostLeave = temporaryDb.leaveGroup('grp-concurrent', 'host');
  assert.equal(groupAfterHostLeave.members[0].id, 'guest');
  assert.equal(groupAfterHostLeave.members[0].isHost, true);
  const sessionAfterHostLeave = temporaryDb.getSession('sess-concurrent');
  assert.equal(sessionAfterHostLeave.members[0].id, 'guest');
  assert.equal(sessionAfterHostLeave.members[0].isHost, true);

  temporaryDb.saveGroup({
    id: 'grp-amount-only',
    members: [{ id: 'payer', isHost: true }, { id: 'debtor', isHost: false }],
    bills: [{ id: 'amount-only', status: 'active', payerId: 'payer', amount: 20, items: [] }],
  });
  assert.throws(
    () => temporaryDb.leaveGroup('grp-amount-only', 'debtor'),
    /Settle or reassign this member’s active bill shares/,
  );

  const groupMutation = temporaryDb.transactGroupAndLinkedSession(
    'grp-atomic-bill',
    (currentGroup) => currentGroup.bills[0].sessionId,
    (currentGroup, currentSession) => ({
      group: { ...currentGroup, revision: 1 },
      session: { ...currentSession, groupRevision: 1 },
    }),
  );
  assert.equal(groupMutation.group.revision, 1);
  assert.equal(groupMutation.session.groupRevision, 1);

  temporaryDb.findOrCreateUser('new-firebase-uid', 'Same Name', '');
  const afterIdentitySync = JSON.parse(fs.readFileSync(temporaryDbPath, 'utf8'));
  assert.deepEqual(afterIdentitySync.users.legacy.bills, ['legacy-bill']);
  assert.equal(afterIdentitySync.users['new-firebase-uid'].id, 'new-firebase-uid');

  temporaryDb.saveGroup({
    id: 'grp-test',
    members: [{ id: 'host', active: true, isHost: true }],
    bills: [{ id: 'bill-test', sessionId: 'sess-bill-test', createdByMemberId: 'host' }],
  });
  temporaryDb.saveSession({ id: 'sess-bill-test' });
  temporaryDb.deleteGroupBill('grp-test', 'bill-test', 'host');
  const afterBillDelete = JSON.parse(fs.readFileSync(temporaryDbPath, 'utf8'));
  assert.deepEqual(afterBillDelete.users.inactive.groups, []);
  assert.equal(afterBillDelete.groups['grp-test'].bills.length, 0);
  assert.equal(afterBillDelete.sessions['sess-bill-test'], undefined);

  assert.throws(
    () => temporaryDb.saveGroup({
      id: 'grp-over-limit',
      members: [{ id: 'host', active: true, isHost: true }],
      bills: Array.from({ length: 51 }, (_, index) => ({ id: `bill-${index}` })),
    }),
    /50-bill limit/,
  );
  assert.throws(
    () => temporaryDb.saveSession({ id: 'sess-over-limit', oversized: 'x'.repeat(700_001) }),
    /too large to update safely/,
  );

  if (previousPath === undefined) delete process.env.BILLSPLIT_DB_PATH;
  else process.env.BILLSPLIT_DB_PATH = previousPath;
  delete require.cache[require.resolve('../lib/db')];
  fs.rmSync(temporaryDirectory, { recursive: true });
});

test('session SET_PAYER is host-only and supports each paid share', () => {
  const session = sampleSession();
  const updatedHost = processSessionAction(session, 'SET_PAYER', { payerId: 'member-1' }, { memberId: 'host-1' });
  assert.equal(updatedHost.payerId, 'member-1');

  const updatedEach = processSessionAction(session, 'SET_PAYER', { payerId: 'each' }, { memberId: 'host-1' });
  assert.equal(updatedEach.payerId, 'each');
  assert.throws(
    () => processSessionAction(session, 'SET_PAYER', { payerId: 'host-1' }, { memberId: 'member-1' }),
    /Only the host/,
  );
  assert.throws(
    () => processSessionAction(session, 'SETTLE_ALL', {}, { memberId: 'member-1' }),
    /Only the host/,
  );
});
test('isTotalOrTaxLine correctly identifies total/tax lines in Hebrew and English', () => {
  const { isTotalOrTaxLine } = require('../lib/receiptMath');
  assert.equal(isTotalOrTaxLine('סה""כ חשבון :'), true);
  assert.equal(isTotalOrTaxLine('סה"כ לתשלום'), true);
  assert.equal(isTotalOrTaxLine('סך הכל:'), true);
  assert.equal(isTotalOrTaxLine('סכום לתשלום'), true);
  assert.equal(isTotalOrTaxLine('חשבון לתשלום'), true);
  assert.equal(isTotalOrTaxLine('TOTAL'), true);
  assert.equal(isTotalOrTaxLine('GRAND TOTAL'), true);
  assert.equal(isTotalOrTaxLine('SUBTOTAL'), true);
  assert.equal(isTotalOrTaxLine('BALANCE DUE'), true);
  assert.equal(isTotalOrTaxLine('AMOUNT DUE: 45.00'), true);
  assert.equal(isTotalOrTaxLine('מע"מ'), true);
  assert.equal(isTotalOrTaxLine('סה"כ פריטים'), true);
  assert.equal(isTotalOrTaxLine('סיכום פריטים'), true);
  assert.equal(isTotalOrTaxLine('יתרה'), true);
  
  // Real menu items should NOT be identified as totals
  assert.equal(isTotalOrTaxLine('פיצה מרגריטה'), false);
  assert.equal(isTotalOrTaxLine('קולה זירו'), false);
  assert.equal(isTotalOrTaxLine('Pasta Bolognese'), false);
  assert.equal(isTotalOrTaxLine('Steak & Fries'), false);
});

test('formatCurrency and formatDualPrice format $ and ₪ properly without double parens', () => {
  const { formatCurrency, formatDualPrice } = require('../lib/i18n');
  assert.equal(formatCurrency(303, 'NIS'), '₪303.00');
  assert.equal(formatCurrency(102.47, 'USD'), '$102.47');
  
  const dual = formatDualPrice(303, 'NIS', 'USD');
  assert.equal(dual.primary, '₪303.00');
  assert.ok(dual.secondary.startsWith('$'));
  assert.equal(dual.secondary.includes('(('), false);
});

test('IP rate limiter allows 5 requests per 15 minutes and blocks the 6th', () => {
  const { createIpRateLimiter } = require('../lib/security');
  const limiter = createIpRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });
  const ip = '192.168.1.50';
  const startTime = 1000000;

  // Requests 1 to 5 should succeed
  for (let i = 1; i <= 5; i++) {
    const res = limiter.check(ip, startTime + i * 1000);
    assert.equal(res.allowed, true, `Request ${i} should be allowed`);
    assert.equal(res.remaining, 5 - i);
  }

  // 6th request within window should be rejected with status 429
  const blocked = limiter.check(ip, startTime + 6000);
  assert.equal(blocked.allowed, false, 'Request 6 should be blocked');
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterSeconds > 0);

  // Different IP should still have full quota
  const otherIpRes = limiter.check('10.0.0.1', startTime + 7000);
  assert.equal(otherIpRes.allowed, true, 'Other IP should be allowed');
  assert.equal(otherIpRes.remaining, 4);

  // After 15 minutes window passes, quota should reset
  const afterExpiry = limiter.check(ip, startTime + (15 * 60 * 1000) + 1000);
  assert.equal(afterExpiry.allowed, true, 'Request after window expiry should be allowed');
  assert.equal(afterExpiry.remaining, 4);
});
