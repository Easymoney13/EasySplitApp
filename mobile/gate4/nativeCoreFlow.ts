import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { realtimeUrl } from '../../lib/platformTransport';

const MARKERS = [
  'GATE4_SESSION_CREATION=PASS',
  'GATE4_REALTIME_PARTICIPANT=PASS',
  'GATE4_ALLOCATION_RECONCILIATION=PASS',
  'GATE4_PAYMENT_COMPLETION=PASS',
  'GATE4_NATIVE_CORE_FLOW=PASS',
];

const API_ORIGIN = String(process.env.NEXT_PUBLIC_EASYSPLIT_API_ORIGIN || '').replace(/\/+$/, '');
const REPORT_ORIGIN = String(import.meta.env.VITE_GATE4_REPORT_ORIGIN || '').replace(/\/+$/, '');
const TIMEOUT_MS = 30_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | null | undefined | false, label: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function query<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function click(selector: string) {
  const element = query<HTMLElement>(selector);
  if (!element) throw new Error(`Missing control: ${selector}`);
  element.click();
}

function setControlValue(control: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Browser value setter unavailable');
  setter.call(control, value);
  control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

function roomHeaders(token: string, clientId: string) {
  return {
    'Content-Type': 'application/json',
    'X-Room-Token': token,
    'X-EasySplit-Client-Id': clientId,
  };
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_ORIGIN}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${init.method || 'GET'} ${path} failed (${response.status})`);
  return body;
}

function action(sessionId: string, memberId: string, token: string, clientId: string, type: string, payload: Record<string, unknown>) {
  return request('/api/session/action', {
    method: 'POST',
    headers: roomHeaders(token, clientId),
    body: JSON.stringify({
      sessionId,
      action: type,
      actionId: `gate4_${type.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      payload: { ...payload, memberId },
    }),
  });
}

function subscribe(sessionId: string, token: string) {
  const socket = new WebSocket(realtimeUrl());
  let current: any = null;
  let failure: Error | null = null;
  const waiters = new Set<() => void>();
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'SUBSCRIBE', sessionId, accessToken: token }));
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === 'ERROR') failure = new Error(message.error || 'Realtime subscription failed');
    if (message.type === 'SESSION_UPDATE') {
      current = message.session;
      for (const notify of waiters) notify();
    }
  });
  socket.addEventListener('error', () => {
    failure = new Error('Realtime connection failed');
    for (const notify of waiters) notify();
  });
  socket.addEventListener('close', (event) => {
    if (!failure && event.code !== 1000) failure = new Error(`Realtime closed (${event.code})`);
    for (const notify of waiters) notify();
  });
  return {
    socket,
    waitUntil(predicate: (session: any) => boolean, label: string, timeoutMs = TIMEOUT_MS) {
      return new Promise<any>((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
          if (failure) {
            cleanup();
            reject(failure);
          } else if (current && predicate(current)) {
            cleanup();
            resolve(current);
          } else if (Date.now() >= deadline) {
            cleanup();
            reject(new Error(`Timed out waiting for realtime ${label}`));
          }
        };
        const timer = setInterval(check, 100);
        const cleanup = () => {
          clearInterval(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });
    },
  };
}

async function report(platform: string, status: 'PASS' | 'FAIL', details: Record<string, unknown>) {
  if (!REPORT_ORIGIN) throw new Error('VITE_GATE4_REPORT_ORIGIN is required');
  const response = await fetch(`${REPORT_ORIGIN}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, status, markers: status === 'PASS' ? MARKERS : [], ...details }),
  });
  if (!response.ok) throw new Error(`Gate 4 reporter rejected the result (${response.status})`);
}

async function run() {
  const platform = Capacitor.getPlatform();
  if (!['ios', 'android'].includes(platform)) throw new Error(`Gate 4 requires a native platform, received ${platform}`);
  if (!API_ORIGIN) throw new Error('Gate 4 API origin is required');

  const nameInput = await waitFor(() => query<HTMLInputElement>('[data-testid="profile-display-name"]'), 'onboarding name');
  const phoneInput = query<HTMLInputElement>('[data-testid="profile-phone"]');
  if (!phoneInput) throw new Error('Onboarding phone input is missing');
  setControlValue(nameInput, 'Gate Four Host');
  setControlValue(phoneInput, '0501234567');
  nameInput.closest('form')?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
  await waitFor(() => !query('[data-testid="profile-onboarding"]'), 'onboarding completion');

  click('[data-testid="start-split-button"]');
  await waitFor(() => query('[data-testid="start-split-sheet"]'), 'start split sheet');
  click('[data-testid="create-manual-split"]');
  await waitFor(() => query('[data-testid="manual-bill-dialog"]'), 'manual bill dialog');
  const store = query<HTMLInputElement>('[data-testid="manual-store-name"]');
  if (!store) throw new Error('Store input is missing');
  setControlValue(store, 'Gate Four Dinner');
  click('[data-testid="manual-item-row"]');
  const itemName = await waitFor(() => query<HTMLInputElement>('[data-testid="manual-item-name"]'), 'manual item name');
  const itemPrice = query<HTMLInputElement>('[data-testid="manual-item-price"]');
  if (!itemPrice) throw new Error('Item price input is missing');
  setControlValue(itemName, 'Shared Dinner');
  setControlValue(itemPrice, '150');
  click('[data-testid="manual-bill-submit"]');
  await waitFor(() => query('[data-testid="session-workspace"]'), 'created session workspace');

  const active = JSON.parse(localStorage.getItem('billsplit_active_session') || '{}');
  const sessionId = String(active.id || '');
  const hostId = String(active.hostId || localStorage.getItem(`billsplit_member_${sessionId}`) || '');
  const hostToken = String(localStorage.getItem(`billsplit_session_token_${sessionId}`) || '');
  const inviteToken = String(localStorage.getItem(`billsplit_session_invite_${sessionId}`) || active.inviteToken || '');
  const hostClientId = String(localStorage.getItem('billsplit_room_client_id') || '');
  if (!sessionId || !hostId || !hostToken || !inviteToken || !hostClientId) throw new Error('Created session credentials are incomplete');

  const guestClientId = `gate4_guest_${platform}_${Date.now()}`;
  const joined = await request(`/api/session/${encodeURIComponent(sessionId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-EasySplit-Client-Id': guestClientId },
    body: JSON.stringify({
      name: 'Gate Four Guest',
      phone: '0527654321',
      clientId: guestClientId,
      inviteToken,
    }),
  });
  const guestId = String(joined.memberId || '');
  const guestToken = String(joined.accessToken || '');
  if (!guestId || !guestToken) throw new Error('Guest credentials are incomplete');

  const realtime = subscribe(sessionId, guestToken);
  await realtime.waitUntil((session) => session.members?.length === 2, 'participant join');
  await waitFor(() => document.body.textContent?.includes('Gate Four Guest'), 'participant in native UI');

  click('[data-testid="split-everyone"]');
  await realtime.waitUntil(
    (session) => session.items?.length === 1 && session.items.every((item: any) => item.claimedBy?.length === 2),
    'shared allocation',
  );

  click('[data-testid="settle-and-pay"]');
  await waitFor(() => query('[data-testid="tip-10"]'), 'settlement dialog');
  const payerSelect = query<HTMLSelectElement>('[data-testid="payer-select"]');
  if (!payerSelect) throw new Error('Payer selector is missing');
  setControlValue(payerSelect, hostId);
  click('[data-testid="tip-10"]');
  await realtime.waitUntil((session) => session.payerId === hostId && session.tipPercentage === 10, 'payer and tip');

  const payment = await request(`/api/session/${encodeURIComponent(sessionId)}/payment-target/${encodeURIComponent(hostId)}`, {
    headers: roomHeaders(guestToken, guestClientId),
  });
  if (payment.phone !== '0501234567' || Math.abs(Number(payment.amount) - 82.5) > 0.01) {
    throw new Error(`Payment target mismatch: ${JSON.stringify(payment)}`);
  }

  await action(sessionId, guestId, guestToken, guestClientId, 'TOGGLE_SETTLED', { settled: true });
  await realtime.waitUntil((session) => session.members?.find((member: any) => member.id === guestId)?.settled === true, 'guest settlement');
  const completeButton = await waitFor(() => query<HTMLButtonElement>('[data-testid="mark-payment-complete"]'), 'host payment button');
  completeButton.click();
  await waitFor(() => query('[data-testid="settlement-complete"]'), 'native completion state');
  const finalSession = await realtime.waitUntil((session) => session.status === 'settled', 'closed session');
  realtime.socket.close();

  const total = finalSession.items.reduce((sum: number, item: any) => sum + Number(item.price || 0), 0);
  if (total !== 150 || finalSession.members.some((member: any) => member.settled !== true)) {
    throw new Error('Final session reconciliation failed');
  }
  await report(platform, 'PASS', { sessionId, amountPerMember: payment.amount, itemTotal: total });
}

const guardKey = 'easysplit_gate4_native_started';

function isGate4Launch(url: string | undefined) {
  return /^easysplit:\/\/gate4(?:[/?#]|$)/i.test(String(url || ''));
}

function startGate4() {
  if (sessionStorage.getItem(guardKey)) return;
  sessionStorage.setItem(guardKey, 'true');
  void run().catch(async (error) => {
    const platform = Capacitor.getPlatform();
    const message = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
    console.error('Gate 4 native flow failed', error);
    try {
      await report(platform, 'FAIL', { error: message });
    } catch (reportError) {
      console.error('Gate 4 failure report could not be sent', reportError);
    }
  });
}

void App.addListener('appUrlOpen', ({ url }) => {
  if (isGate4Launch(url)) startGate4();
});
void App.getLaunchUrl().then((launch) => {
  if (isGate4Launch(launch?.url)) startGate4();
});
