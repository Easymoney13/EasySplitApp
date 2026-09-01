import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { apiUrl, realtimeUrl } from '../../lib/platformTransport';
import {
  getOrCreateRoomClientId,
  getRoomMemberId,
  getRoomToken,
  getSessionInviteToken,
  roomHeaders,
  saveRoomCredentials,
  saveSessionInviteToken,
} from '../../lib/roomTokens';
import { pushShellRoute } from '../router-core.mjs';
import { runGate4Core } from './core-flow.mjs';
import { runGate4Once } from './run-once.mjs';
import { hasRoomMemberEvidence, readRoomMemberEvidence } from './member-ui-evidence.mjs';

const REPORT_ORIGIN = String(import.meta.env.VITE_GATE4_REPORT_ORIGIN || '').replace(/\/+$/, '');
const RUN_ID = String(import.meta.env.VITE_GATE4_RUN_ID || '');
const TIMEOUT_MS = 30_000;
const HOST_NAME = 'Gate Four Host';
const HOST_PHONE = '0501234567';
const GUEST_NAME = 'Gate Four Guest';
const GUEST_PHONE = '0527654321';

const execution = {
  stage: 'BOOTSTRAP',
  markers: [] as string[],
};

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

function normalizedText(element: Element | null) {
  return String(element?.textContent || '').replace(/\s+/g, ' ').trim();
}

function buttonByText(label: string, exact = false) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => {
    const text = normalizedText(button);
    return exact ? text === label : text.includes(label);
  }) || null;
}

function sessionWorkspace() {
  return Array.from(document.querySelectorAll<HTMLElement>('.app-surface')).find((candidate) => {
    const text = normalizedText(candidate);
    return text.includes('Room Members') && text.includes('Receipt Items');
  }) || null;
}

function payerSelector() {
  return Array.from(document.querySelectorAll<HTMLSelectElement>('select')).find((select) =>
    Array.from(select.options).some((option) => normalizedText(option).includes('Each paid their share'))
  ) || null;
}

function completionState() {
  return Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3')).find((heading) =>
    normalizedText(heading).includes('Bill Split Settled!')
  ) || null;
}

function click(selector: string) {
  const element = query<HTMLElement>(selector);
  if (!element) throw new Error(`Missing control: ${selector}`);
  if ('disabled' in element && Boolean((element as HTMLButtonElement).disabled)) {
    throw new Error(`Disabled control: ${selector}`);
  }
  element.click();
}

function setControlValue(control: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Browser value setter unavailable');
  setter.call(control, value);
  control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

function diagnostics() {
  const localProfile = localStorage.getItem('billsplit_local_profile');
  return {
    stage: execution.stage,
    markers: [...execution.markers],
    documentReadyState: document.readyState,
    route: window.location.search,
    accountScope: localStorage.getItem('billsplit_account_scope'),
    hasLocalProfile: Boolean(localProfile),
    hasLocalPhone: Boolean(localStorage.getItem('billsplit_phone')),
    hasOnboarding: Boolean(query('[role="dialog"][aria-label*="EasySplit"]')),
    hasStartButton: Boolean(query('[data-testid="start-split-button"]')),
    hasSessionWorkspace: Boolean(sessionWorkspace()),
    roomMembers: readRoomMemberEvidence(document),
    auth: window.__EASYSPLIT_GATE4_AUTH_DIAGNOSTICS__ || { stage: 'NOT_OBSERVED' },
  };
}

async function postEvidence(path: '/progress' | '/report', payload: Record<string, unknown>) {
  if (!REPORT_ORIGIN) throw new Error('VITE_GATE4_REPORT_ORIGIN is required');
  const response = await fetch(`${REPORT_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Gate 4 reporter rejected ${path} (${response.status}): ${body.error || 'unknown error'}`);
  }
}

async function progress(platform: string, update: Record<string, unknown>) {
  execution.stage = String(update.stage || execution.stage);
  execution.markers = Array.isArray(update.markers) ? [...update.markers] as string[] : execution.markers;
  await postEvidence('/progress', {
    runId: RUN_ID,
    platform,
    ...update,
    diagnostics: diagnostics(),
  });
}

async function report(platform: string, status: 'PASS' | 'FAIL', details: Record<string, unknown>) {
  await postEvidence('/report', {
    runId: RUN_ID,
    platform,
    status,
    markers: [...execution.markers],
    stage: execution.stage,
    diagnostics: diagnostics(),
    ...details,
  });
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(apiUrl(path), init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${init.method || 'GET'} ${path} failed (${response.status})`);
  return body;
}

function action(sessionId: string, memberId: string, token: string, clientId: string, type: string, payload: Record<string, unknown>) {
  return request('/api/session/action', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Room-Token': token,
      'X-EasySplit-Client-Id': clientId,
    },
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

function itemCard(itemName: string) {
  const heading = Array.from(document.querySelectorAll('h3')).find((candidate) => candidate.textContent?.trim() === itemName);
  return heading?.closest<HTMLElement>('.relative.p-4') || null;
}

function createDriver() {
  return {
    async waitForApplication() {
      const startButton = await waitFor(
        () => query<HTMLButtonElement>('[data-testid="start-split-button"]'),
        'application auth/profile readiness',
      );
      if (startButton.disabled) throw new Error('Application start control is disabled');
      const rawProfile = localStorage.getItem('billsplit_local_profile');
      const profile = rawProfile ? JSON.parse(rawProfile) : null;
      if (profile?.displayName !== HOST_NAME || profile?.phoneNumber !== HOST_PHONE) {
        throw new Error('Gate 4 guest fixture was not consumed by the application');
      }
      if (localStorage.getItem('billsplit_account_scope') !== 'guest') {
        throw new Error('Gate 4 account scope is not guest');
      }
      if (query('[role="dialog"][aria-label*="EasySplit"]')) throw new Error('Onboarding still blocks the application');
    },

    async createSession() {
      const hostClientId = getOrCreateRoomClientId();
      const created = await request('/api/receipt/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-EasySplit-Client-Id': hostClientId },
        body: JSON.stringify({
          parsedBill: {
            storeName: 'Gate Four Dinner',
            currency: 'NIS',
            items: [{ id: 'gate4_item', name: 'Shared Dinner', price: 150, category: 'Food', claimedBy: [] }],
          },
          hostName: HOST_NAME,
          hostPhone: HOST_PHONE,
          clientId: hostClientId,
          confirmedByUser: true,
        }),
      });
      const sessionId = String(created.sessionId || '');
      const hostId = String(created.memberId || created.hostId || '');
      const hostToken = String(created.accessToken || '');
      const inviteToken = String(created.inviteToken || '');
      if (!sessionId || !hostId || !hostToken || !inviteToken) {
        throw new Error('Session creation credentials are incomplete');
      }

      saveRoomCredentials('session', sessionId, hostId, hostToken);
      saveSessionInviteToken(sessionId, inviteToken);
      if (
        getRoomMemberId('session', sessionId) !== hostId
        || getRoomToken('session', sessionId) !== hostToken
        || getSessionInviteToken(sessionId) !== inviteToken
      ) {
        throw new Error('Session credentials did not round-trip through room helpers');
      }

      localStorage.setItem('billsplit_active_session', JSON.stringify({
        id: sessionId,
        code: created.code,
        storeName: created.session?.storeName || 'Gate Four Dinner',
        isHost: true,
        hostId,
        inviteToken,
      }));
      pushShellRoute(window, `/session/${encodeURIComponent(sessionId)}`);

      const workspace = await waitFor(() => sessionWorkspace(), 'created session workspace');
      const splitButton = buttonByText('Split All', true);
      if (!splitButton || splitButton.disabled) throw new Error('Host split control is unavailable');
      const text = workspace.textContent || '';
      if (!text.includes('Gate Four Dinner') || !text.includes('Shared Dinner')) {
        throw new Error('Created session UI does not show the expected receipt');
      }
      const serverState = await request(`/api/session/${encodeURIComponent(sessionId)}`, {
        headers: roomHeaders('session', sessionId, false),
      });
      if (serverState.session?.id !== sessionId || Number(serverState.session?.items?.[0]?.price) !== 150) {
        throw new Error('Created session server state does not reconcile with the UI');
      }
      return { sessionId, hostId, hostToken, inviteToken, hostClientId };
    },

    async joinParticipant(context: any) {
      const guestClientId = `gate4_guest_${Capacitor.getPlatform()}_${Date.now()}`;
      const joined = await request(`/api/session/${encodeURIComponent(context.sessionId)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-EasySplit-Client-Id': guestClientId },
        body: JSON.stringify({
          name: GUEST_NAME,
          phone: GUEST_PHONE,
          clientId: guestClientId,
          inviteToken: context.inviteToken,
        }),
      });
      const guestId = String(joined.memberId || '');
      const guestToken = String(joined.accessToken || '');
      if (!guestId || !guestToken) throw new Error('Guest credentials are incomplete');
      const realtime = subscribe(context.sessionId, guestToken);
      const joinedState = await realtime.waitUntil(
        (session: any) => session.members?.length === 2 && session.members.some((member: any) => member.id === guestId),
        'participant join',
      );
      await waitFor(
        () => hasRoomMemberEvidence(document, GUEST_NAME, 2),
        'participant identity and count in native UI',
      );
      if (!joinedState.members.some((member: any) => member.name === GUEST_NAME)) {
        throw new Error('Realtime participant identity is incorrect');
      }
      return { guestClientId, guestId, guestToken, realtime };
    },

    async allocateAndReconcile(context: any) {
      const splitButton = buttonByText('Split All', true);
      if (!splitButton || splitButton.disabled) throw new Error('Host split control is unavailable');
      splitButton.click();
      const allocated = await context.realtime.waitUntil(
        (session: any) => session.items?.length === 1 && session.items.every((item: any) => item.claimedBy?.length === 2),
        'shared allocation',
      );
      await waitFor(() => {
        const text = itemCard('Shared Dinner')?.textContent || '';
        return text.includes(HOST_NAME) && text.includes(GUEST_NAME) && text.toLowerCase().includes('each');
      }, 'shared allocation in native UI');

      const settleButton = buttonByText('Settle & Pay', true);
      if (!settleButton || settleButton.disabled) throw new Error('Settle control is unavailable');
      settleButton.click();
      const payerSelect = await waitFor(() => payerSelector(), 'payer selector');
      const tipButton = buttonByText('10%', true);
      if (!tipButton || tipButton.disabled) throw new Error('Tip control is unavailable');
      setControlValue(payerSelect, context.hostId);
      tipButton.click();
      const reconciled = await context.realtime.waitUntil(
        (session: any) => session.payerId === context.hostId
          && session.tipPercentage === 10
          && session.items?.every((item: any) => item.claimedBy?.length === 2),
        'payer, tip, and allocation reconciliation',
      );
      await waitFor(
        () => payerSelect.value === context.hostId && document.body.textContent?.includes('Tip (10%)'),
        'payer and tip in native UI',
      );
      const total = reconciled.items.reduce((sum: number, item: any) => sum + Number(item.price || 0), 0);
      if (total !== 150 || allocated.items[0].claimedBy.length !== 2) {
        throw new Error('Allocated item total does not reconcile');
      }
      const payment = await request(
        `/api/session/${encodeURIComponent(context.sessionId)}/payment-target/${encodeURIComponent(context.hostId)}`,
        {
          headers: {
            'X-Room-Token': context.guestToken,
            'X-EasySplit-Client-Id': context.guestClientId,
          },
        },
      );
      if (payment.phone !== HOST_PHONE || Math.abs(Number(payment.amount) - 82.5) > 0.01) {
        throw new Error(`Payment target mismatch: ${JSON.stringify(payment)}`);
      }
      return { paymentAmount: Number(payment.amount), itemTotal: total };
    },

    async completePayment(context: any) {
      await action(
        context.sessionId,
        context.guestId,
        context.guestToken,
        context.guestClientId,
        'TOGGLE_SETTLED',
        { settled: true },
      );
      await context.realtime.waitUntil(
        (session: any) => session.members?.find((member: any) => member.id === context.guestId)?.settled === true,
        'guest settlement',
      );
      const completeButton = await waitFor(
        () => buttonByText('Finish and Pay', true),
        'host payment completion control',
      );
      if (completeButton.disabled) throw new Error('Host payment completion control is disabled');
      completeButton.click();
      await waitFor(() => completionState(), 'native completion state');
      const finalSession = await context.realtime.waitUntil(
        (session: any) => session.status === 'settled' && session.members?.every((member: any) => member.settled === true),
        'closed session',
      );
      context.realtime.socket.close(1000);
      if (finalSession.items.reduce((sum: number, item: any) => sum + Number(item.price || 0), 0) !== 150) {
        throw new Error('Final session reconciliation failed');
      }
      return { finalStatus: finalSession.status };
    },
  };
}

function isGate4Launch(url: string | undefined) {
  return /^easysplit:\/\/gate4(?:[/?#]|$)/i.test(String(url || ''));
}

async function startGate4() {
  const platform = Capacitor.getPlatform();
  if (!['ios', 'android'].includes(platform)) return;
  if (!RUN_ID) throw new Error('VITE_GATE4_RUN_ID is required');
  await runGate4Once({
    storage: localStorage,
    runId: RUN_ID,
    platform,
    execute: async () => {
      const result = await runGate4Core(createDriver(), (update: Record<string, unknown>) => progress(platform, update));
      execution.markers = [...result.markers];
      execution.stage = 'NATIVE_CORE_FLOW';
      await report(platform, 'PASS', {
        sessionId: result.context.sessionId,
        amountPerMember: result.context.paymentAmount,
        itemTotal: result.context.itemTotal,
      });
      return result;
    },
    onFailure: async (error: unknown) => {
      const message = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
      try {
        await report(platform, 'FAIL', { error: message });
      } catch (reportError) {
        console.error('Gate 4 failure report could not be sent', reportError);
      }
    },
  });
}

if (Capacitor.getPlatform() === 'ios') {
  void startGate4();
} else {
  void App.addListener('appUrlOpen', ({ url }) => {
    if (isGate4Launch(url)) void startGate4();
  });
  void App.getLaunchUrl().then((launch) => {
    if (isGate4Launch(launch?.url)) void startGate4();
  });
}
