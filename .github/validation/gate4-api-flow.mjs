import WebSocket from 'ws';

const origin = String(process.env.GATE4_API_ORIGIN || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const wsOrigin = origin.replace(/^http/, 'ws');

async function request(path, init = {}) {
  const response = await fetch(`${origin}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${init.method || 'GET'} ${path} failed (${response.status})`);
  return body;
}

function headers(token, clientId) {
  return {
    'Content-Type': 'application/json',
    'X-Room-Token': token,
    'X-EasySplit-Client-Id': clientId,
  };
}

function performAction(sessionId, memberId, token, clientId, action, payload = {}) {
  return request('/api/session/action', {
    method: 'POST',
    headers: headers(token, clientId),
    body: JSON.stringify({
      sessionId,
      action,
      actionId: `gate4_api_${action.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      payload: { ...payload, memberId },
    }),
  });
}

function subscribe(sessionId, token) {
  const socket = new WebSocket(wsOrigin);
  let current = null;
  return {
    socket,
    ready: new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Realtime subscription timed out')), 30_000);
      socket.once('error', reject);
      socket.once('close', (code, reason) => reject(new Error(`Realtime closed (${code}): ${String(reason)}`)));
      socket.once('open', () => {
        socket.send(JSON.stringify({ type: 'SUBSCRIBE', sessionId, accessToken: token }));
      });
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'ERROR') reject(new Error(message.error));
        if (message.type === 'SESSION_UPDATE') {
          current = message.session;
          clearTimeout(timeout);
          resolve(message.session);
        }
      });
    }),
    async waitUntil(predicate, label, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (current && predicate(current)) return current;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Realtime ${label} timed out`);
    },
  };
}

const hostClientId = `gate4_host_${Date.now()}`;
const created = await request('/api/receipt/scan', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-EasySplit-Client-Id': hostClientId },
  body: JSON.stringify({
    parsedBill: {
      storeName: 'Gate Four API Dinner',
      currency: 'NIS',
      items: [{ id: 'gate4_item', name: 'Shared Dinner', price: 150, category: 'Food', claimedBy: [] }],
    },
    hostName: 'Gate Four Host',
    hostPhone: '0501234567',
    clientId: hostClientId,
    confirmedByUser: true,
  }),
});
if (!created.sessionId || !created.memberId || !created.accessToken || !created.inviteToken) {
  throw new Error('Session creation credentials are incomplete');
}
process.stdout.write('GATE4_SESSION_CREATION=PASS\n');

const guestClientId = `gate4_guest_${Date.now()}`;
const joined = await request(`/api/session/${created.sessionId}/join`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-EasySplit-Client-Id': guestClientId },
  body: JSON.stringify({
    name: 'Gate Four Guest',
    phone: '0527654321',
    clientId: guestClientId,
    inviteToken: created.inviteToken,
  }),
});
const realtime = subscribe(created.sessionId, joined.accessToken);
await realtime.ready;
await realtime.waitUntil((session) => session.members?.length === 2, 'join');
process.stdout.write('GATE4_REALTIME_PARTICIPANT=PASS\n');

await performAction(created.sessionId, created.memberId, created.accessToken, hostClientId, 'SPLIT_EVERYONE');
await realtime.waitUntil(
  (session) => session.items?.every((item) => item.claimedBy?.length === 2),
  'shared allocation',
);
await performAction(created.sessionId, created.memberId, created.accessToken, hostClientId, 'SET_PAYER', { payerId: created.memberId });
await realtime.waitUntil((session) => session.payerId === created.memberId, 'payer selection');
await performAction(created.sessionId, created.memberId, created.accessToken, hostClientId, 'SET_TIP', { tipPercentage: 10 });
const allocated = await realtime.waitUntil(
  (session) => session.items?.every((item) => item.claimedBy?.length === 2)
    && session.payerId === created.memberId
    && session.tipPercentage === 10,
  'allocation',
);
if (allocated.items.reduce((sum, item) => sum + Number(item.price || 0), 0) !== 150) {
  throw new Error('Allocated item total does not reconcile');
}
process.stdout.write('GATE4_ALLOCATION_RECONCILIATION=PASS\n');

const payment = await request(`/api/session/${created.sessionId}/payment-target/${created.memberId}`, {
  headers: headers(joined.accessToken, guestClientId),
});
if (payment.phone !== '0501234567' || Math.abs(Number(payment.amount) - 82.5) > 0.01) {
  throw new Error(`Payment target mismatch: ${JSON.stringify(payment)}`);
}
await performAction(created.sessionId, joined.memberId, joined.accessToken, guestClientId, 'TOGGLE_SETTLED', { settled: true });
await performAction(created.sessionId, created.memberId, created.accessToken, hostClientId, 'TOGGLE_SETTLED', { settled: true });
const completed = await realtime.waitUntil((session) => session.status === 'settled', 'completion');
if (completed.members.some((member) => member.settled !== true)) throw new Error('Not every member completed payment');
realtime.socket.close();
process.stdout.write('GATE4_PAYMENT_COMPLETION=PASS\n');
process.stdout.write('GATE4_API_CORE_FLOW=PASS\n');
