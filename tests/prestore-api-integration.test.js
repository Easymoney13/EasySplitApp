const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRoomMember } = require('../lib/roomAuth');
const { calculateDebtMinimization } = require('../lib/debtMinimizer');
const { RECEIPT_CLOUD_CONSENT_VERSION } = require('../lib/receiptPrivacyConsent');

const root = path.resolve(__dirname, '..');
const consent = () => ({ accepted: true, version: RECEIPT_CLOUD_CONSENT_VERSION, acceptedAt: new Date().toISOString() });
const receipt = {
  storeName: 'Loopback Cafe', currency: 'NIS', receiptTotal: 30,
  items: [{ name: 'Coffee', price: 12 }, { name: 'Sandwich', price: 18 }],
  ocr: { source: 'server-image', documentLanguage: 'en', verificationStatus: 'verified', modelAttempts: 1 },
};

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`API startup timed out: ${output}`)), 15_000);
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes('BillSplit Unified Server ready')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`API exited (${code}): ${output}`)); });
  });
}

// Run the actual server routes, middleware, domain actions, and local database.
// Only rendering, identity verification, and the external OCR provider are
// replaced. Any attempted fetch outside loopback fails in the child process.
async function apiFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-prestore-api-'));
  const dbPath = path.join(directory, 'db.json');
  const host = createRoomMember({ uid: 'fixture_host', name: 'Host', phone: '0501111111', isHost: true });
  const guest = createRoomMember({ uid: 'fixture_guest', name: 'Guest', phone: '0502222222' });
  const lateGuest = createRoomMember({ uid: 'fixture_late_guest', name: 'Late Guest', phone: '0504444444' });
  host.member.settled = true;
  guest.member.settled = true;
  const deleted = { id: 'member_deleted_fixture', name: 'Deleted participant', active: true, deletedAccount: true, settled: false, isHost: false };
  const members = [host.member, guest.member, deleted];
  const unfinishedMembers = members.map(member => ({ ...member, settled: false }));
  const items = [{ id: 'item_deleted_share', name: 'Dinner', price: 60, claimedBy: members.map(member => member.id) }];
  fs.writeFileSync(dbPath, JSON.stringify({
    users: {
      fixture_host: { id: 'fixture_host', groups: ['grp_deleted_share'], bills: [] },
      fixture_guest: { id: 'fixture_guest', groups: ['grp_deleted_share'], bills: [] },
      fixture_sync: { id: 'fixture_sync', username: 'Before', phone: '0503333333', groups: ['grp_existing'], bills: [{ id: 'bill_existing' }] },
    },
    sessions: { sess_deleted_share: {
      id: 'sess_deleted_share', code: '54672', groupId: 'grp_deleted_share', billId: 'bill_deleted_share',
      status: 'active', currency: 'NIS', payerId: host.member.id, members, items,
    }, sess_partial_deleted_share: {
      id: 'sess_partial_deleted_share', code: '54673', groupId: 'grp_partial_deleted_share', billId: 'bill_partial_deleted_share',
      status: 'active', currency: 'NIS', payerId: host.member.id, members: unfinishedMembers, items,
    } },
    groups: { grp_deleted_share: {
      id: 'grp_deleted_share', code: '76543', name: 'Shared Dinner', status: 'active', currency: 'NIS', members,
      bills: [{ id: 'bill_deleted_share', sessionId: 'sess_deleted_share', payerId: host.member.id, amount: 60, status: 'active', items, settledMemberIds: [] }],
    }, grp_partial_deleted_share: {
      id: 'grp_partial_deleted_share', code: '76544', name: 'Unfinished Dinner', status: 'active', currency: 'NIS', members: [...unfinishedMembers, lateGuest.member],
      bills: [{ id: 'bill_partial_deleted_share', sessionId: 'sess_partial_deleted_share', payerId: host.member.id, amount: 60, status: 'active', items, settledMemberIds: [] }],
    } },
    history: [],
  }));

  const providerCalls = [];
  const provider = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    providerCalls.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(receipt));
  });
  const providerPort = await listen(provider);
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const preloadPath = path.join(directory, 'preload.cjs');
  fs.writeFileSync(preloadPath, `
const Module = require('node:module');
const path = require('node:path');
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'next') return () => ({ prepare: async () => {}, getRequestHandler: () => (_req, res) => { res.statusCode = 404; res.end(); } });
  if (request === 'firebase-admin/app') return { cert: value => value, initializeApp: () => ({}) };
  if (request === 'firebase-admin/auth') return { getAuth: () => ({ verifyIdToken: async token => {
    if (!/^fixture_[a-z0-9_-]+$/.test(token)) throw new Error('Invalid fixture token');
    return { uid: token, name: 'Fixture User', ...(token === 'fixture_sync' ? { picture: 'https://example.invalid/avatar.png' } : {}) };
  } }) };
  return originalLoad.call(this, request, ...args);
};
const originalFetch = global.fetch;
global.fetch = (url, options) => {
  const parsed = new URL(String(url));
  if (parsed.hostname !== '127.0.0.1') throw new Error('External traffic is forbidden in the API fixture');
  return originalFetch(url, options);
};
const gemini = require(path.join(process.cwd(), 'lib/gemini'));
const provider = async (input, ...args) => {
  const response = await fetch(process.env.PRESTORE_PROVIDER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, args }) });
  return response.json();
};
gemini.parseReceiptImage = provider;
gemini.parseReceiptTextWithGemini = provider;
const db = require(path.join(process.cwd(), 'lib/db'));
const originalFind = db.findOrCreateUser.bind(db);
const originalSave = db.saveUser.bind(db);
db.findOrCreateUser = async (...args) => {
  const stale = await originalFind(...args);
  if (args[0] === 'fixture_sync') await originalSave({ id: 'fixture_sync', groups: [...stale.groups, 'grp_concurrent'], bills: [...stale.bills, { id: 'bill_concurrent' }] }, 'fixture_sync');
  return stale;
};
`);
  const child = spawn(process.execPath, ['--require', preloadPath, 'server.js'], {
    cwd: root,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1',
      BILLSPLIT_DB_PATH: dbPath, GEMINI_API_KEY: 'loopback-fixture-key',
      FIREBASE_PRIVATE_KEY: '', FIREBASE_CLIENT_EMAIL: '', FIREBASE_PROJECT_ID: 'demo-easysplit-api',
      FIREBASE_SERVICE_ACCOUNT_PATH: path.join(directory, 'no-service-account.json'),
      ENFORCE_APP_CHECK: 'false', MIGRATE_LOCAL_DB_TO_FIRESTORE: 'false',
      PRESTORE_PROVIDER_URL: `http://127.0.0.1:${providerPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitForStartup(child);
  return {
    host, guest, lateGuest, deleted, providerCalls,
    readDb: () => JSON.parse(fs.readFileSync(dbPath, 'utf8')),
    async post(route, body, token = '', roomToken = '') {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(roomToken ? { 'x-room-token': roomToken } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('pre-store repairs preserve the real receipt and shared-debt API boundaries', { timeout: 45_000 }, async t => {
  const api = await apiFixture(t);

  for (const route of ['parse', 'scan']) {
    for (const [kind, input] of Object.entries({ text: { rawText: 'Coffee 12\nSandwich 18\nTotal 30' }, image: { imageBase64: '/9j/AA==' }, parts: { imageBase64Parts: ['/9j/AA==', '/9j/AA=='] } })) {
      await t.test(`${route}: ${kind} requires current affirmative consent before any provider call`, async () => {
        const before = api.providerCalls.length;
        for (const cloudReceiptConsent of [undefined, { ...consent(), accepted: false }, { ...consent(), version: 'old-policy' }, { ...consent(), acceptedAt: 'invalid-date' }]) {
          const result = await api.post(`/api/receipt/${route}`, { ...input, hostName: 'Host', hostPhone: '0501111111', cloudReceiptConsent }, `fixture_${route}_${kind}`);
          assert.equal(result.status, 428, JSON.stringify(result.body));
          assert.equal(result.body.errorCode, 'RECEIPT_CLOUD_CONSENT_REQUIRED');
        }
        assert.equal(api.providerCalls.length, before);
        const accepted = await api.post(`/api/receipt/${route}`, { ...input, hostName: 'Host', hostPhone: '0501111111', cloudReceiptConsent: consent() }, `fixture_${route}_${kind}`);
        assert.equal(accepted.status, route === 'parse' ? 200 : 409, JSON.stringify(accepted.body));
        assert.equal(accepted.body.receipt.items.length, 2);
        assert.equal(api.providerCalls.length, before + 1, 'Valid consent permits the intended provider input');
      });
    }
    await t.test(`${route}: successful OCR cache cannot bypass revoked or stale consent`, async () => {
      const body = { rawText: 'Coffee 12\nSandwich 18\nTotal 30', scanId: `scan_cache_${route}_fixture`, recoveryToken: 'fixture_recovery_token_01234567890123456789', hostName: 'Host', hostPhone: '0501111111' };
      const token = `fixture_cache_${route}`;
      const before = api.providerCalls.length;
      const expectedStatus = route === 'parse' ? 200 : 409; // Scanned bills still require review.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await api.post(`/api/receipt/${route}`, { ...body, cloudReceiptConsent: consent() }, token);
        assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
        assert.equal(result.body.receipt.items.length, 2);
        if (route === 'scan') assert.equal(result.body.confirmationRequired, true);
      }
      assert.equal(api.providerCalls.length, before + 1, 'Same scan reuses the successful provider result');
      for (const cloudReceiptConsent of [undefined, { ...consent(), version: 'old-policy' }, { ...consent(), accepted: false }]) {
        const result = await api.post(`/api/receipt/${route}`, { ...body, cloudReceiptConsent }, token);
        assert.equal(result.status, 428, JSON.stringify(result.body));
        assert.equal(result.body.receipt, undefined, 'Cached receipt must not bypass consent validation');
      }
      assert.equal(api.providerCalls.length, before + 1);
    });
  }

  await t.test('manual entry remains usable without receipt-cloud consent', async () => {
    const before = api.providerCalls.length;
    const parsed = await api.post('/api/receipt/parse', { parsedBill: receipt }, 'fixture_manual_parse');
    assert.equal(parsed.status, 200, JSON.stringify(parsed.body));
    const created = await api.post('/api/receipt/scan', { parsedBill: { ...receipt, ocr: undefined }, hostName: 'Manual Host', hostPhone: '0501111111', confirmedByUser: true }, 'fixture_manual_scan');
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.success, true);
    assert.equal(api.providerCalls.length, before);
  });

  await t.test('a resolved deleted share locks joining and edits while surviving participants are unfinished', async () => {
    const sessionId = 'sess_partial_deleted_share';
    const groupId = 'grp_partial_deleted_share';
    const billId = 'bill_partial_deleted_share';
    const resolved = await api.post('/api/session/action', {
      sessionId, action: 'RESOLVE_DELETED_MEMBER', payload: { memberId: api.deleted.id }, actionId: 'resolve_partial_deleted_once',
    }, '', api.host.accessToken);
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.session.status, 'active');
    assert.ok(resolved.body.session.members.every(member => member.settled === false));
    const before = api.readDb();

    // This person already belongs to the group; only the finished-share lock
    // prevents their admission to the live split.
    const join = await api.post(`/api/session/${sessionId}/join`, { name: 'Late Guest', phone: '0504444444' }, '', api.lateGuest.accessToken);
    assert.equal(join.status, 409, JSON.stringify(join.body));
    assert.match(join.body.error, /New participants cannot join/);
    const sessionEdit = await api.post('/api/session/action', {
      sessionId, action: 'EDIT_ITEM', payload: { itemId: 'item_deleted_share', name: 'Changed Dinner', price: 60 },
    }, '', api.host.accessToken);
    assert.equal(sessionEdit.status, 403, JSON.stringify(sessionEdit.body));
    assert.match(sessionEdit.body.error, /locked/);
    const groupEdit = await api.post('/api/groups/bill/action', {
      groupId, action: 'SET_PAYER', payload: { billId, payerId: api.host.member.id },
    }, '', api.host.accessToken);
    assert.equal(groupEdit.status, 409, JSON.stringify(groupEdit.body));
    assert.match(groupEdit.body.error, /locked/);
    const replacement = await api.post('/api/groups/bill', {
      groupId, bill: { id: billId, title: 'Changed Dinner', amount: 60, expectedRevision: 1, payerId: api.host.member.id, currency: 'NIS', items: before.sessions[sessionId].items },
    }, '', api.host.accessToken);
    assert.equal(replacement.status, 409, JSON.stringify(replacement.body));
    assert.match(replacement.body.error, /locked/);
    const prematureFinalize = await api.post('/api/groups/bill/action', {
      groupId, action: 'FINALIZE_BILL', payload: { billId },
    }, '', api.host.accessToken);
    assert.equal(prematureFinalize.status, 409, JSON.stringify(prematureFinalize.body));
    assert.match(prematureFinalize.body.error, /Every participant must finish/);
    assert.deepEqual(api.readDb().sessions[sessionId], before.sessions[sessionId]);
    assert.deepEqual(api.readDb().groups[groupId], before.groups[groupId]);
  });

  await t.test('only the host can resolve a deleted share; replay preserves history and outstanding debt', async () => {
    const body = { sessionId: 'sess_deleted_share', action: 'RESOLVE_DELETED_MEMBER', payload: { memberId: api.deleted.id }, actionId: 'resolve_deleted_once' };
    const before = api.readDb();
    const debtsBefore = calculateDebtMinimization(before.groups.grp_deleted_share);
    const unauthenticated = await api.post('/api/session/action', body);
    assert.equal(unauthenticated.status, 401);
    const guest = await api.post('/api/session/action', body, '', api.guest.accessToken);
    assert.equal(guest.status, 403);
    assert.deepEqual(api.readDb().sessions.sess_deleted_share, before.sessions.sess_deleted_share);

    const result = await api.post('/api/session/action', body, '', api.host.accessToken);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.session.status, 'settled');
    const closed = api.readDb();
    const session = closed.sessions.sess_deleted_share;
    const deleted = session.members.find(member => member.id === api.deleted.id);
    assert.equal(deleted.settled, false);
    assert.equal(deleted.active, true);
    assert.equal(deleted.deletionResolution.status, 'unconfirmed');
    assert.equal(deleted.deletionResolution.resolvedByMemberId, api.host.member.id);
    assert.deepEqual(session.unconfirmedMemberIds, [api.deleted.id]);
    assert.deepEqual(session.items, before.sessions.sess_deleted_share.items);
    assert.equal(session.groupSettlementDeferred, true);
    const bill = closed.groups.grp_deleted_share.bills[0];
    assert.equal(bill.status, 'finalized');
    assert.deepEqual(bill.settledMemberIds, []);
    assert.deepEqual(bill.unconfirmedMemberIds, [api.deleted.id]);
    assert.deepEqual(calculateDebtMinimization(closed.groups.grp_deleted_share), debtsBefore);
    assert.equal(debtsBefore.transactions.find(transaction => transaction.fromId === api.deleted.id)?.amount, 20);
    const history = closed.history.find(record => record.id === session.id);
    assert.ok(history, 'Completion writes the session history');
    assert.deepEqual(history.unconfirmedMemberIds, [api.deleted.id]);
    assert.equal(history.settledMemberIds.includes(api.deleted.id), false);

    const replay = await api.post('/api/session/action', body, '', api.host.accessToken);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    const afterReplay = api.readDb();
    // Transactions may refresh their bookkeeping timestamp on replay; all
    // financial content, completion timestamps, and action IDs must be stable.
    const { updatedAt: previousUpdatedAt, ...originalContent } = session;
    const { updatedAt: replayUpdatedAt, ...replayedContent } = afterReplay.sessions.sess_deleted_share;
    assert.deepEqual(replayedContent, originalContent);
    assert.ok(replayUpdatedAt >= previousUpdatedAt);
    assert.deepEqual(afterReplay.groups.grp_deleted_share.bills[0], bill);
    assert.deepEqual(afterReplay.history, closed.history);
  });

  await t.test('reopening clears every unconfirmed marker and permits edits without removing debt or claims', async () => {
    const before = api.readDb();
    const originalSession = before.sessions.sess_deleted_share;
    assert.equal(originalSession.status, 'settled');
    const debtsBefore = calculateDebtMinimization(before.groups.grp_deleted_share);
    const reopened = await api.post('/api/groups/bill/action', {
      groupId: 'grp_deleted_share', action: 'REOPEN_BILL', payload: { billId: 'bill_deleted_share' }, actionId: 'reopen_deleted_share_once',
    }, '', api.host.accessToken);
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    const after = api.readDb();
    const session = after.sessions.sess_deleted_share;
    const bill = after.groups.grp_deleted_share.bills[0];
    assert.equal(session.status, 'active');
    assert.equal(session.settledAt, undefined);
    assert.equal(session.unconfirmedMemberIds, undefined);
    assert.equal(session.groupSettlementDeferred, undefined);
    for (const member of session.members) {
      assert.equal(member.settled, false);
      assert.equal(member.settledAt, undefined);
      assert.equal(member.deletionResolution, undefined);
    }
    assert.equal(session.members.find(member => member.id === api.deleted.id).deletedAccount, true);
    assert.equal(bill.status, 'active');
    assert.equal(bill.unconfirmedMemberIds, undefined);
    assert.deepEqual(bill.finishedMemberIds, []);
    assert.deepEqual(bill.settledMemberIds, []);
    assert.deepEqual(session.items, originalSession.items);
    assert.deepEqual(calculateDebtMinimization(after.groups.grp_deleted_share), debtsBefore);
    assert.equal(after.history.some(record => record.id === session.id), false);

    const groupEdit = await api.post('/api/groups/bill/action', {
      groupId: 'grp_deleted_share', action: 'SET_PAYER', payload: { billId: 'bill_deleted_share', payerId: api.host.member.id },
    }, '', api.host.accessToken);
    assert.equal(groupEdit.status, 200, JSON.stringify(groupEdit.body));
    const edit = await api.post('/api/session/action', {
      sessionId: session.id, action: 'EDIT_ITEM', payload: { itemId: 'item_deleted_share', name: 'Renamed Dinner', price: 60 },
    }, '', api.host.accessToken);
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    const edited = api.readDb();
    assert.equal(edited.sessions[session.id].items[0].name, 'Renamed Dinner');
    assert.deepEqual(edited.sessions[session.id].items[0].claimedBy, originalSession.items[0].claimedBy);
    assert.deepEqual(calculateDebtMinimization(edited.groups.grp_deleted_share), debtsBefore);
  });

  await t.test('avatar sync preserves group and bill indices written after profile synchronization', async () => {
    const result = await api.post('/api/user/sync', { username: 'After', phone: '0503333333' }, 'fixture_sync');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const user = api.readDb().users.fixture_sync;
    assert.equal(user.avatarUrl, 'https://example.invalid/avatar.png');
    assert.deepEqual(user.groups, ['grp_existing', 'grp_concurrent']);
    assert.deepEqual(user.bills.map(bill => bill.id), ['bill_existing', 'bill_concurrent']);
  });
});
