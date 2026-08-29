const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { createRoomMember } = require('../lib/roomAuth');

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

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function requestBatch(count, operation) {
  const startedAt = Date.now();
  const results = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const requestStartedAt = Date.now();
    const response = await operation(index);
    await response.arrayBuffer();
    return { status: response.status, durationMs: Date.now() - requestStartedAt };
  }));
  return { results, durationMs: Date.now() - startedAt };
}

function openSocket(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const closed = new Promise((closeResolve) => ws.once('close', (code) => closeResolve({ code })));
    ws.on('error', () => {});
    ws.once('open', () => resolve({ outcome: 'open', ws, closed }));
    ws.once('unexpected-response', (_, response) => {
      response.resume();
      resolve({ outcome: `rejected-${response.statusCode}`, ws, closed });
    });
  });
}

test('critical HTTP and WebSocket paths shed load without crashing', { timeout: 90_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easysplit-strain-'));
  const dbPath = path.join(tempDir, 'db.json');
  const sessionHost = createRoomMember({ name: 'Session Host', isHost: true });
  const groupHost = createRoomMember({ name: 'Group Host', isHost: true });
  fs.writeFileSync(dbPath, JSON.stringify({
    users: {},
    history: [],
    sessions: {
      sess_strain: {
        id: 'sess_strain',
        code: '4321',
        status: 'active',
        members: [sessionHost.member],
        items: [{ id: 'item-1', name: 'Shared Dish', price: 90, claimedBy: [] }],
      },
    },
    groups: {
      grp_strain: {
        id: 'grp_strain',
        code: '12345678',
        status: 'active',
        currency: 'NIS',
        members: [groupHost.member],
        bills: [],
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
      WS_SUBSCRIPTION_TIMEOUT_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  const lookups = await requestBatch(240, () => fetch(`${baseUrl}/api/session/4321`));
  const lookupStatuses = lookups.results.map(({ status }) => status);
  assert.ok(lookupStatuses.includes(200));
  assert.ok(lookupStatuses.includes(429));
  assert.ok(lookupStatuses.every((status) => status === 200 || status === 429));

  const joins = await requestBatch(100, (index) => fetch(`${baseUrl}/api/groups/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-easysplit-client-id': `strain-device-${index}` },
    body: JSON.stringify({
      // Match the real browser flow: lookup resolves the code first, then the
      // join POST carries the durable group ID.
      groupId: 'grp_strain',
      name: `Guest ${index}`,
      phone: `050${String(index).padStart(7, '0')}`,
      clientId: `strain-device-${index}`,
    }),
  }));
  const joinStatuses = joins.results.map(({ status }) => status);
  assert.ok(joinStatuses.includes(200));
  assert.ok(joinStatuses.every((status) => status === 200 || status === 409 || status === 429));
  assert.equal(joinStatuses.includes(503), false);
  assert.ok(joinStatuses.filter((status) => status === 200).length >= 95);

  const durableJoinReplay = await requestBatch(13, (index) => fetch(`${baseUrl}/api/groups/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-easysplit-client-id': 'durable-replay-client' },
    body: JSON.stringify({
      groupId: 'grp_strain',
      name: 'Durable Replay Guest',
      phone: '0509999999',
      clientId: 'durable-replay-client',
      replay: index,
    }),
  }));
  assert.ok(durableJoinReplay.results.some(({ status }) => status === 429));

  const mutations = await requestBatch(300, (index) => fetch(`${baseUrl}/api/session/action`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-room-token': sessionHost.accessToken,
    },
    body: JSON.stringify({
      sessionId: 'sess_strain',
      actionId: `strain-${index}`,
      action: 'TOGGLE_CLAIM',
      payload: { itemId: 'item-1', memberId: sessionHost.member.id, claimed: true },
    }),
  }));
  const mutationStatuses = mutations.results.map(({ status }) => status);
  assert.ok(mutationStatuses.includes(200));
  assert.ok(mutationStatuses.includes(429));
  assert.ok(mutationStatuses.every((status) => status === 200 || status === 429));

  const socketAttempts = await Promise.all(Array.from({ length: 12 }, () => openSocket(`ws://127.0.0.1:${port}/`)));
  const openedAttempts = socketAttempts.filter(({ outcome }) => outcome === 'open');
  const openSockets = openedAttempts.map(({ ws }) => ws);
  const rejectedSockets = socketAttempts.filter(({ outcome }) => outcome.startsWith('rejected-'));
  assert.ok(openSockets.length <= 8);
  assert.ok(rejectedSockets.length >= 4);
  const deadlineCloses = await Promise.race([
    Promise.all(openedAttempts.map(({ closed }) => closed)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('WebSockets did not close on the subscription deadline')), 2_000)),
  ]);
  assert.ok(deadlineCloses.every(({ code }) => code === 1008 || code === 1006));

  const authorized = await openSocket(`ws://127.0.0.1:${port}/`);
  assert.equal(authorized.outcome, 'open');
  const sessionUpdate = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Authorized WebSocket did not receive the room state')), 2_000);
    authorized.ws.once('message', (message) => {
      clearTimeout(timeout);
      resolve(JSON.parse(message.toString()));
    });
  });
  authorized.ws.send(JSON.stringify({ type: 'SUBSCRIBE', sessionId: 'sess_strain', accessToken: sessionHost.accessToken }));
  assert.equal((await sessionUpdate).type, 'SESSION_UPDATE');
  authorized.ws.close();

  const health = await fetch(`${baseUrl}/api/network-ip`);
  assert.equal(health.status, 200);
  assert.equal(child.exitCode, null);

  const processStatusPath = `/proc/${child.pid}/status`;
  const rssLine = fs.existsSync(processStatusPath)
    ? fs.readFileSync(processStatusPath, 'utf8').split('\n').find((line) => line.startsWith('VmRSS:')) || ''
    : 'unavailable-in-test-namespace';
  t.diagnostic(JSON.stringify({
    lookups: { total: lookupStatuses.length, accepted: lookupStatuses.filter((status) => status === 200).length, rejected: lookupStatuses.filter((status) => status === 429).length, durationMs: lookups.durationMs, p95Ms: percentile(lookups.results.map(({ durationMs }) => durationMs), 0.95) },
    joins: { total: joinStatuses.length, accepted: joinStatuses.filter((status) => status === 200).length, rejected: joinStatuses.filter((status) => status === 429).length, durationMs: joins.durationMs, p95Ms: percentile(joins.results.map(({ durationMs }) => durationMs), 0.95) },
    mutations: { total: mutationStatuses.length, accepted: mutationStatuses.filter((status) => status === 200).length, rejected: mutationStatuses.filter((status) => status === 429).length, durationMs: mutations.durationMs, p95Ms: percentile(mutations.results.map(({ durationMs }) => durationMs), 0.95) },
    websockets: { opened: openSockets.length, rejected: rejectedSockets.length, unauthenticatedClosed: deadlineCloses.length },
    processRss: rssLine.trim(),
  }));
});
