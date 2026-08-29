const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRoomMember } = require('../lib/roomAuth');
const { hashAccessToken } = require('../lib/ids');
const { calculateDebtMinimization } = require('../lib/debtMinimizer');

async function getAvailablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function waitForServer(child, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out.\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('BillSplit Unified Server ready')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before startup with code ${code}.\n${output}`));
    });
  });
}

test('guest receipt parsing and legacy invite access remain account-free', { timeout: 60_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-invite-'));
  const dbPath = path.join(tempDir, 'db.json');
  const sessionHost = createRoomMember({ name: 'Session Host', phone: '0501111111', isHost: true });
  const sessionGuest = createRoomMember({ name: 'Session Guest', phone: '0504444444' });
  const groupHost = createRoomMember({ name: 'Group Host', phone: '0502222222', isHost: true });
  const groupGuest = createRoomMember({ name: 'Group Guest', phone: '0503333333' });
  const deleteHistoryHost = createRoomMember({ uid: 'delete-history-host', name: 'Delete Host', phone: '0505555555', isHost: true });
  const deleteHistoryGuest = createRoomMember({ uid: 'delete-history-guest', name: 'Delete Guest', phone: '0506666666' });
  fs.writeFileSync(dbPath, JSON.stringify({
    users: {
      'delete-history-host': {
        id: 'delete-history-host',
        groups: ['grp_delete_history_test'],
        bills: [{ id: 'sess_delete_history_test', storeName: 'Deleted Group Dinner' }],
      },
      'delete-history-guest': {
        id: 'delete-history-guest',
        groups: ['grp_delete_history_test'],
        bills: [{ id: 'sess_delete_history_test', storeName: 'Deleted Group Dinner' }],
      },
    },
    history: [{
      id: 'sess_delete_history_test',
      groupId: 'grp_delete_history_test',
      isGroupBill: true,
      memberIds: ['delete-history-host', 'delete-history-guest'],
      status: 'settled',
    }],
    historyPointers: {
      'delete-history-host': [{ historyId: 'sess_delete_history_test' }],
      'delete-history-guest': [{ historyId: 'sess_delete_history_test' }],
    },
    sessions: {
      'sess_invite_test': {
        id: 'sess_invite_test',
        code: '4321',
        status: 'active',
        currency: 'NIS',
        payerId: sessionHost.member.id,
        members: [sessionHost.member, sessionGuest.member],
        items: [{ id: 'session_item_1', name: 'Lunch', price: 20, claimedBy: [sessionGuest.member.id] }],
      },
      'sess_linked_finish_test': {
        id: 'sess_linked_finish_test',
        code: '54321',
        groupId: 'grp_linked_finish_test',
        billId: 'bill_linked_finish',
        status: 'active',
        currency: 'NIS',
        restaurant: { id: 'rest_linked_finish', identityBasis: 'name_only_session', confidence: 0.5, trustScore: 0.68 },
        payerId: groupHost.member.id,
        members: [groupHost.member, groupGuest.member],
        items: [{ id: 'linked_item_1', name: 'Shared Dinner', price: 40, claimedBy: [groupHost.member.id, groupGuest.member.id] }],
      },
      'sess_expiring_invite_test': {
        id: 'sess_expiring_invite_test',
        code: '55555',
        status: 'active',
        currency: 'NIS',
        admissionExpiresAt: Date.now() + 5 * 60_000,
        inviteExpiresAt: Date.now() + 5 * 60_000,
        inviteTokenHash: hashAccessToken('old-invite-token'),
        members: [sessionHost.member],
        items: [],
      },
      'sess_delete_history_test': {
        id: 'sess_delete_history_test',
        code: '55666',
        groupId: 'grp_delete_history_test',
        billId: 'bill_delete_history_test',
        status: 'settled',
        members: [deleteHistoryHost.member, deleteHistoryGuest.member],
        items: [],
      },
    },
    groups: {
      'grp_invite_test': {
        id: 'grp_invite_test',
        code: '6789',
        status: 'active',
        currency: 'NIS',
        members: [groupHost.member, groupGuest.member],
        bills: [{
          id: 'bill_payment_target',
          payerId: groupHost.member.id,
          amount: 20,
          items: [{ id: 'item_1', name: 'Dinner', price: 20, claimedBy: [groupGuest.member.id] }],
        }],
      },
      'grp_member_settled_test': {
        id: 'grp_member_settled_test',
        code: '6790',
        status: 'active',
        currency: 'NIS',
        members: [groupHost.member, groupGuest.member],
        bills: [{
          id: 'bill_member_settled',
          payerId: groupHost.member.id,
          amount: 20,
          settledMemberIds: [groupGuest.member.id],
          items: [{ id: 'item_2', name: 'Dinner', price: 20, claimedBy: [groupGuest.member.id] }],
        }],
      },
      'grp_bill_settled_test': {
        id: 'grp_bill_settled_test',
        code: '6791',
        status: 'active',
        currency: 'NIS',
        members: [groupHost.member, groupGuest.member],
        bills: [{
          id: 'bill_fully_settled',
          payerId: groupHost.member.id,
          amount: 20,
          status: 'settled',
          items: [{ id: 'item_3', name: 'Dinner', price: 20, claimedBy: [groupGuest.member.id] }],
        }],
      },
      'grp_linked_finish_test': {
        id: 'grp_linked_finish_test',
        code: '12345678',
        status: 'active',
        currency: 'NIS',
        members: [groupHost.member, groupGuest.member],
        bills: [{
          id: 'bill_linked_finish',
          sessionId: 'sess_linked_finish_test',
          payerId: groupHost.member.id,
          amount: 40,
          status: 'active',
          items: [{ id: 'linked_item_1', name: 'Shared Dinner', price: 40, claimedBy: [groupHost.member.id, groupGuest.member.id] }],
        }],
      },
      'grp_delete_history_test': {
        id: 'grp_delete_history_test',
        code: '12345679',
        status: 'active',
        currency: 'NIS',
        members: [deleteHistoryHost.member, deleteHistoryGuest.member],
        bills: [{
          id: 'bill_delete_history_test',
          sessionId: 'sess_delete_history_test',
          status: 'finalized',
          items: [],
        }],
      },
    },
  }));

  const port = await getAvailablePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      NEXT_TELEMETRY_DISABLED: '1',
      BILLSPLIT_DB_PATH: dbPath,
      // A stale deployment variable must never restore the retired OCR auth gate.
      REQUIRE_OCR_AUTH: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  const anonymousReceiptDraft = await fetch(`${baseUrl}/api/receipt/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      parsedBill: {
        storeName: 'Guest Scan Test',
        currency: 'NIS',
        items: [{ name: 'Coffee', price: 12 }],
      },
    }),
  });
  assert.equal(anonymousReceiptDraft.status, 200);
  assert.equal((await anonymousReceiptDraft.json()).success, true);

  const anonymousSessionCreation = await fetch(`${baseUrl}/api/receipt/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      parsedBill: {
        storeName: 'Creator Gate Test',
        currency: 'NIS',
        items: [{ name: 'Coffee', price: 12 }],
      },
      hostName: 'Guest Creator',
      hostPhone: '0501234567',
      clientId: 'guest-creator-device',
      confirmedByUser: true,
    }),
  });
  assert.equal(anonymousSessionCreation.status, 200);
  const createdSession = await anonymousSessionCreation.json();
  assert.equal(createdSession.success, true);
  assert.match(createdSession.code, /^\d{5}$/);
  assert.ok(createdSession.inviteToken);

  const reusedFreshInvite = await fetch(`${baseUrl}/api/session/${createdSession.sessionId}/refresh-invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': createdSession.accessToken },
    body: JSON.stringify({ inviteToken: createdSession.inviteToken }),
  });
  assert.equal(reusedFreshInvite.status, 200);
  const reusedFreshInviteBody = await reusedFreshInvite.json();
  assert.equal(reusedFreshInviteBody.code, createdSession.code);
  assert.equal(reusedFreshInviteBody.inviteToken, createdSession.inviteToken);

  const refreshedExpiringInvite = await fetch(`${baseUrl}/api/session/sess_expiring_invite_test/refresh-invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': sessionHost.accessToken },
    body: JSON.stringify({ inviteToken: 'old-invite-token' }),
  });
  assert.equal(refreshedExpiringInvite.status, 200);
  const refreshedExpiringInviteBody = await refreshedExpiringInvite.json();
  assert.match(refreshedExpiringInviteBody.code, /^\d{5}$/);
  assert.notEqual(refreshedExpiringInviteBody.code, '55555');
  assert.notEqual(refreshedExpiringInviteBody.inviteToken, 'old-invite-token');
  assert.equal((await fetch(`${baseUrl}/api/session/55555`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/session/${refreshedExpiringInviteBody.code}`)).status, 200);

  const cacheStatus = await fetch(`${baseUrl}/api/rooms/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionIds: [createdSession.sessionId, 'sess_missing_cache_12345'],
      groupIds: ['grp_invite_test', 'grp_missing_cache_12345'],
    }),
  });
  assert.equal(cacheStatus.status, 200);
  assert.deepEqual(await cacheStatus.json(), {
    success: true,
    sessions: {
      [createdSession.sessionId]: 'active',
      sess_missing_cache_12345: 'deleted',
    },
    groups: {
      grp_invite_test: 'active',
      grp_missing_cache_12345: 'deleted',
    },
    sessionHistoryStates: {
      [createdSession.sessionId]: 'absent',
    },
  });

  const unsignedJoin = await fetch(`${baseUrl}/api/session/${createdSession.sessionId}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Unsigned Guest',
      phone: '0505555555',
      clientId: 'unsigned-device',
    }),
  });
  assert.equal(unsignedJoin.status, 403);

  const concurrentJoinRequest = () => fetch(`${baseUrl}/api/session/${createdSession.sessionId}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Kuti',
      phone: '0507654321',
      clientId: 'kuti-stable-device',
      inviteToken: createdSession.inviteToken,
    }),
  });
  const [firstConcurrentJoin, secondConcurrentJoin] = await Promise.all([
    concurrentJoinRequest(),
    concurrentJoinRequest(),
  ]);
  assert.equal(firstConcurrentJoin.status, 200);
  assert.equal(secondConcurrentJoin.status, 200);
  const firstConcurrentBody = await firstConcurrentJoin.json();
  const secondConcurrentBody = await secondConcurrentJoin.json();
  assert.equal(firstConcurrentBody.memberId, secondConcurrentBody.memberId);
  assert.equal(secondConcurrentBody.session.members.length, 2);

  const claimWithForgedClientMemberId = await fetch(`${baseUrl}/api/session/action`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-room-token': secondConcurrentBody.accessToken,
    },
    body: JSON.stringify({
      sessionId: createdSession.sessionId,
      action: 'TOGGLE_CLAIM',
      actionId: 'race-claim-1',
      payload: {
        itemId: createdSession.session.items[0].id,
        memberId: createdSession.hostId,
        claimed: true,
      },
    }),
  });
  assert.equal(claimWithForgedClientMemberId.status, 200);
  const claimBody = await claimWithForgedClientMemberId.json();
  assert.deepEqual(claimBody.session.items[0].claimedBy, [secondConcurrentBody.memberId]);
  const persistedAfterRace = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const raceVisits = Object.values(persistedAfterRace.restaurantVisits || {})
    .filter((visit) => visit.sessionId === createdSession.sessionId);
  assert.equal(raceVisits.length, 2);
  assert.equal(new Set(raceVisits.map((visit) => visit.memberId)).size, 2);

  const laniJoinResponse = await fetch(`${baseUrl}/api/session/${createdSession.sessionId}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Lani',
      phone: '0523456789',
      clientId: 'lani-stable-device',
      inviteToken: createdSession.inviteToken,
    }),
  });
  assert.equal(laniJoinResponse.status, 200);
  const laniJoinBody = await laniJoinResponse.json();

  const finishFor = async (accessToken, memberId, actionId) => {
    const response = await fetch(`${baseUrl}/api/session/action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-room-token': accessToken,
      },
      body: JSON.stringify({
        sessionId: createdSession.sessionId,
        action: 'TOGGLE_SETTLED',
        actionId,
        payload: { memberId, settled: true },
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const hostFinished = await finishFor(createdSession.accessToken, 'forged-member', 'finish-host');
  assert.equal(hostFinished.session.status, 'active');
  const kutiFinished = await finishFor(firstConcurrentBody.accessToken, createdSession.hostId, 'finish-kuti');
  assert.equal(kutiFinished.session.status, 'active');
  const laniFinished = await finishFor(laniJoinBody.accessToken, createdSession.hostId, 'finish-lani');
  assert.equal(laniFinished.session.status, 'settled');
  assert.equal(laniFinished.session.members.every((member) => member.settled), true);

  const persistedAfterThreePersonFinish = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const finishedSessionVisits = Object.values(persistedAfterThreePersonFinish.restaurantVisits || {})
    .filter((visit) => visit.sessionId === createdSession.sessionId);
  assert.equal(finishedSessionVisits.length, 3);
  assert.equal(new Set(finishedSessionVisits.map((visit) => visit.memberId)).size, 3);
  assert.equal(persistedAfterThreePersonFinish.history.find((entry) => entry.id === createdSession.sessionId)?.status, 'settled');

  const finishLinkedShare = async (accessToken, actionId) => {
    const response = await fetch(`${baseUrl}/api/session/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-room-token': accessToken },
      body: JSON.stringify({
        sessionId: 'sess_linked_finish_test',
        action: 'TOGGLE_SETTLED',
        actionId,
        payload: { memberId: 'forged-other-member', settled: true },
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const linkedHostFinished = await finishLinkedShare(groupHost.accessToken, 'linked-host-finished');
  assert.equal(linkedHostFinished.session.status, 'active');
  assert.equal(linkedHostFinished.session.members.filter((member) => member.settled).length, 1);

  const lateGroupJoin = await fetch(`${baseUrl}/api/groups/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      groupId: 'grp_linked_finish_test',
      name: 'Late Group Guest',
      phone: '0541234567',
      clientId: 'late-group-device',
    }),
  });
  assert.equal(lateGroupJoin.status, 200);
  const lateGroupJoinBody = await lateGroupJoin.json();
  assert.equal(lateGroupJoinBody.group.members.length, 3);
  const afterLateGroupJoin = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(afterLateGroupJoin.sessions.sess_linked_finish_test.members.length, 2);

  const blockedLateLeave = await fetch(`${baseUrl}/api/groups/grp_linked_finish_test/leave`, {
    method: 'POST',
    headers: { 'x-room-token': lateGroupJoinBody.accessToken },
  });
  assert.equal(blockedLateLeave.status, 409);

  const linkedGuestFinished = await finishLinkedShare(groupGuest.accessToken, 'linked-guest-finished');
  assert.equal(linkedGuestFinished.session.status, 'settled');
  assert.equal(linkedGuestFinished.session.groupSettlementDeferred, true);
  const afterLinkedFinish = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(afterLinkedFinish.groups.grp_linked_finish_test.bills[0].status, 'finalized');
  assert.equal(afterLinkedFinish.groups.grp_linked_finish_test.bills[0].finalizedByMemberId, 'all_participants');
  assert.deepEqual(afterLinkedFinish.groups.grp_linked_finish_test.bills[0].settledMemberIds, []);
  assert.equal(afterLinkedFinish.groups.grp_linked_finish_test.bills[0].finishedMemberIds.length, 2);
  assert.equal(afterLinkedFinish.groups.grp_linked_finish_test.bills[0].participantMemberIds.length, 2);
  assert.equal(afterLinkedFinish.history.find((entry) => entry.id === 'sess_linked_finish_test')?.isGroupBill, true);
  const linkedVisits = Object.values(afterLinkedFinish.restaurantVisits || {})
    .filter((visit) => visit.sessionId === 'sess_linked_finish_test');
  assert.equal(linkedVisits.length, 2);
  const linkedDebt = calculateDebtMinimization(afterLinkedFinish.groups.grp_linked_finish_test);
  assert.equal(linkedDebt.transactions.length, 1);
  assert.equal(linkedDebt.transactions[0].amount, 20);

  const lateLeaveAfterFinalization = await fetch(`${baseUrl}/api/groups/grp_linked_finish_test/leave`, {
    method: 'POST',
    headers: { 'x-room-token': lateGroupJoinBody.accessToken },
  });
  assert.equal(lateLeaveAfterFinalization.status, 200);
  assert.equal((await lateLeaveAfterFinalization.json()).group.members.length, 2);

  const reopenedLinkedBill = await fetch(`${baseUrl}/api/groups/bill/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': groupHost.accessToken },
    body: JSON.stringify({
      groupId: 'grp_linked_finish_test',
      actionId: 'reopen-linked-bill',
      action: 'REOPEN_BILL',
      payload: { billId: 'bill_linked_finish' },
    }),
  });
  assert.equal(reopenedLinkedBill.status, 200);
  const reopenedLinkedBillBody = await reopenedLinkedBill.json();
  assert.match(reopenedLinkedBillBody.sessionCode, /^\d{5}$/);
  assert.notEqual(reopenedLinkedBillBody.sessionCode, '54321');
  const afterLinkedReopen = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.deepEqual(afterLinkedReopen.groups.grp_linked_finish_test.bills[0].finishedMemberIds, []);
  assert.equal(afterLinkedReopen.sessions.sess_linked_finish_test.status, 'active');
  assert.equal(afterLinkedReopen.sessions.sess_linked_finish_test.members.every((member) => member.settled === false), true);
  assert.equal(afterLinkedReopen.sessions.sess_linked_finish_test.code, reopenedLinkedBillBody.sessionCode);
  assert.equal(afterLinkedReopen.history.some((entry) => entry.id === 'sess_linked_finish_test'), false);
  const reopenedSessionDiscovery = await fetch(`${baseUrl}/api/session/${reopenedLinkedBillBody.sessionCode}`);
  assert.equal(reopenedSessionDiscovery.status, 200);
  const expiredSessionCode = await fetch(`${baseUrl}/api/session/54321`);
  assert.equal(expiredSessionCode.status, 404);

  const anonymousGroupCreation = await fetch(`${baseUrl}/api/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Creator Gate Test',
      currency: 'NIS',
      hostName: 'Guest Creator',
      hostPhone: '0501234567',
      clientId: 'guest-creator-device',
    }),
  });
  assert.equal(anonymousGroupCreation.status, 200);
  assert.equal((await anonymousGroupCreation.json()).success, true);

  const sessionDiscovery = await fetch(`${baseUrl}/api/session/4321`);
  assert.equal(sessionDiscovery.status, 200);
  assert.equal(sessionDiscovery.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(sessionDiscovery.headers.get('x-frame-options'), 'DENY');
  assert.equal(sessionDiscovery.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(sessionDiscovery.headers.get('permissions-policy') || '', /microphone=\(\)/);
  assert.match(sessionDiscovery.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(sessionDiscovery.headers.get('content-security-policy') || '', /https:\/\/fonts\.googleapis\.com/);
  assert.match(sessionDiscovery.headers.get('content-security-policy') || '', /https:\/\/fonts\.gstatic\.com/);
  assert.deepEqual(await sessionDiscovery.json(), {
    session: { id: 'sess_invite_test', code: '4321', status: 'active' },
  });

  const oversizedEarlyResponse = await fetch(`${baseUrl}/api/unknown`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'x'.repeat(769 * 1024),
  });
  assert.equal(oversizedEarlyResponse.status, 413);
  assert.equal(oversizedEarlyResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(oversizedEarlyResponse.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

  const sessionJoin = await fetch(`${baseUrl}/api/session/4321/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': sessionGuest.accessToken },
    body: JSON.stringify({ name: 'Session Guest', phone: '0504444444' }),
  });
  assert.equal(sessionJoin.status, 200);
  const sessionJoinBody = await sessionJoin.json();
  assert.equal(sessionJoinBody.session.members.length, 2);
  assert.equal(sessionJoinBody.session.members.every((member) => member.phone === undefined), true);
  assert.equal(sessionJoinBody.session.paymentPhone, undefined);

  const sessionPaymentTarget = await fetch(
    `${baseUrl}/api/session/sess_invite_test/payment-target/${sessionHost.member.id}`,
    { headers: { 'x-room-token': sessionGuest.accessToken } },
  );
  assert.equal(sessionPaymentTarget.status, 200);
  assert.deepEqual(await sessionPaymentTarget.json(), {
    memberId: sessionHost.member.id,
    phone: '0501111111',
    amount: 20,
  });

  const sessionUnrelatedTarget = await fetch(
    `${baseUrl}/api/session/sess_invite_test/payment-target/${sessionGuest.member.id}`,
    { headers: { 'x-room-token': sessionHost.accessToken } },
  );
  assert.equal(sessionUnrelatedTarget.status, 403);

  const groupDiscovery = await fetch(`${baseUrl}/api/groups/6789`);
  assert.equal(groupDiscovery.status, 200);
  assert.deepEqual(await groupDiscovery.json(), {
    group: { id: 'grp_invite_test', code: '6789', status: 'active' },
  });

  const groupJoin = await fetch(`${baseUrl}/api/groups/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': groupGuest.accessToken },
    body: JSON.stringify({ groupId: '6789', name: 'Group Guest', phone: '0503333333' }),
  });
  assert.equal(groupJoin.status, 200);
  const groupJoinBody = await groupJoin.json();
  assert.equal(groupJoinBody.group.members.length, 2);
  assert.equal(groupJoinBody.group.members.every((member) => member.phone === undefined), true);
  assert.equal(groupJoinBody.group.minimizedTransactions.every((transaction) => transaction.toPhone === undefined), true);

  const paymentTarget = await fetch(
    `${baseUrl}/api/groups/grp_invite_test/payment-target/${groupHost.member.id}`,
    { headers: { 'x-room-token': groupGuest.accessToken } },
  );
  assert.equal(paymentTarget.status, 409);
  assert.match((await paymentTarget.json()).error, /Start the final group settlement/);

  const unrelatedTarget = await fetch(
    `${baseUrl}/api/groups/grp_invite_test/payment-target/${groupGuest.member.id}`,
    { headers: { 'x-room-token': groupHost.accessToken } },
  );
  assert.equal(unrelatedTarget.status, 409);

  for (const settledGroupId of ['grp_member_settled_test', 'grp_bill_settled_test']) {
    const settledTarget = await fetch(
      `${baseUrl}/api/groups/${settledGroupId}/payment-target/${groupHost.member.id}`,
      { headers: { 'x-room-token': groupGuest.accessToken } },
    );
    assert.equal(settledTarget.status, 409);
  }

  const deletedGroupWithHistory = await fetch(`${baseUrl}/api/groups/grp_delete_history_test`, {
    method: 'DELETE',
    headers: { 'x-room-token': deleteHistoryHost.accessToken },
  });
  assert.equal(deletedGroupWithHistory.status, 200);
  const afterGroupDeletion = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  assert.equal(afterGroupDeletion.groups.grp_delete_history_test, undefined);
  assert.equal(afterGroupDeletion.sessions.sess_delete_history_test, undefined);
  assert.equal(afterGroupDeletion.history.some((entry) => entry.id === 'sess_delete_history_test'), false);
  assert.equal(afterGroupDeletion.historyPointers['delete-history-host'].length, 0);
  assert.equal(afterGroupDeletion.historyPointers['delete-history-guest'].length, 0);
  assert.equal(afterGroupDeletion.users['delete-history-host'].bills.length, 0);
  assert.equal(afterGroupDeletion.users['delete-history-guest'].bills.length, 0);
});
