const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_DURABILITY_WINDOW_MS = 1_500;
const EXPECTED_DISPLAY_NAME = 'Android Smoke';
const EXPECTED_PHONE_NUMBER = '0501234567';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollForState(label, readState, accept, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  sleep = delay,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastState = null;
  let lastError = null;

  while (now() < deadline) {
    try {
      lastState = await readState();
      if (accept(lastState)) return lastState;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  const detail = lastError
    ? lastError.message
    : JSON.stringify(lastState);
  throw new Error(`${label} timed out; last state=${detail}`);
}

async function pollForStableState(label, readState, accept, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  durabilityWindowMs = DEFAULT_DURABILITY_WINDOW_MS,
  sleep = delay,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let stableSince = null;
  let lastState = null;
  let lastError = null;

  while (now() < deadline) {
    try {
      lastState = await readState();
      if (accept(lastState)) {
        stableSince ??= now();
        if (now() - stableSince >= durabilityWindowMs) return lastState;
      } else {
        stableSince = null;
      }
    } catch (error) {
      lastError = error;
      stableSince = null;
    }
    await sleep(intervalMs);
  }

  const detail = lastError
    ? lastError.message
    : JSON.stringify(lastState);
  throw new Error(`${label} timed out; last state=${detail}`);
}

function parseProfile(rawProfile) {
  if (!rawProfile) return null;
  if (typeof rawProfile === 'object') return rawProfile;
  try {
    return JSON.parse(rawProfile);
  } catch {
    return null;
  }
}

export function expectedGuestProfileIsStable(state) {
  const profile = parseProfile(state?.localProfile);
  return Boolean(
    state?.profileReady
    && !state?.dialogVisible
    && state?.accountScope === 'guest'
    && state?.localPhone === EXPECTED_PHONE_NUMBER
    && profile?.displayName === EXPECTED_DISPLAY_NAME
    && profile?.phoneNumber === EXPECTED_PHONE_NUMBER,
  );
}

export async function synchronizeGuestOnboarding(controller, options = {}) {
  const ready = await pollForState(
    'guest onboarding readiness',
    () => controller.readState(),
    (state) => Boolean(state?.dialogVisible || state?.profileReady),
    options,
  );

  if (ready.profileReady) {
    const completed = await pollForStableState(
      'durable guest onboarding dismissal',
      () => controller.readState(),
      expectedGuestProfileIsStable,
      options,
    );
    return { outcome: 'already-complete', state: completed };
  }

  const filled = await controller.fillFields(EXPECTED_DISPLAY_NAME, EXPECTED_PHONE_NUMBER);
  if (!filled) throw new Error('Guest onboarding fields could not be filled');

  await pollForState(
    'enabled guest onboarding submit',
    () => controller.readState(),
    (state) => (
      state?.dialogVisible
      && state?.inputValues?.[0] === EXPECTED_DISPLAY_NAME
      && state?.inputValues?.[1] === EXPECTED_PHONE_NUMBER
      && state?.submitEnabled === true
    ),
    options,
  );

  const submitted = await controller.submit();
  if (!submitted) throw new Error('Guest onboarding could not be submitted');

  const completed = await pollForStableState(
    'durable guest onboarding persistence',
    () => controller.readState(),
    expectedGuestProfileIsStable,
    options,
  );

  return { outcome: 'completed', state: completed };
}

export async function certifyGuestProfileAcrossRestart(controller, options = {}) {
  const beforeRestart = await pollForState(
    'guest profile before process restart',
    () => controller.readState(),
    expectedGuestProfileIsStable,
    options,
  );

  const restartResult = await controller.restart();

  const afterRestart = await pollForState(
    'guest profile after process restart',
    () => controller.readState(),
    expectedGuestProfileIsStable,
    options,
  );

  return { beforeRestart, afterRestart, restartResult };
}
