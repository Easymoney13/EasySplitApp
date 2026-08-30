const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 250;

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

export async function synchronizeGuestOnboarding(controller, options = {}) {
  const ready = await pollForState(
    'guest onboarding readiness',
    () => controller.readState(),
    (state) => Boolean(state?.dialogVisible || state?.profileReady),
    options,
  );

  if (ready.profileReady) {
    const completed = await pollForState(
      'guest onboarding dismissal',
      () => controller.readState(),
      (state) => Boolean(state?.profileReady && !state?.dialogVisible),
      options,
    );
    return { outcome: 'already-complete', state: completed };
  }

  const filled = await controller.fillFields('Android Smoke', '0501234567');
  if (!filled) throw new Error('Guest onboarding fields could not be filled');

  await pollForState(
    'enabled guest onboarding submit',
    () => controller.readState(),
    (state) => (
      state?.dialogVisible
      && state?.inputValues?.[0] === 'Android Smoke'
      && state?.inputValues?.[1] === '0501234567'
      && state?.submitEnabled === true
    ),
    options,
  );

  const submitted = await controller.submit();
  if (!submitted) throw new Error('Guest onboarding could not be submitted');

  const completed = await pollForState(
    'guest onboarding persistence',
    () => controller.readState(),
    (state) => Boolean(state?.profileReady && !state?.dialogVisible),
    options,
  );

  return { outcome: 'completed', state: completed };
}
