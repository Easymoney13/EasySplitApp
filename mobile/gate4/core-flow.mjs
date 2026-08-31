export const GATE4_CORE_MARKERS = Object.freeze([
  'GATE4_SESSION_CREATION=PASS',
  'GATE4_REALTIME_PARTICIPANT=PASS',
  'GATE4_ALLOCATION_RECONCILIATION=PASS',
  'GATE4_PAYMENT_COMPLETION=PASS',
  'GATE4_NATIVE_CORE_FLOW=PASS',
]);

const STEPS = Object.freeze([
  { stage: 'APPLICATION_READY', method: 'waitForApplication' },
  { stage: 'SESSION_CREATION', method: 'createSession', marker: GATE4_CORE_MARKERS[0] },
  { stage: 'REALTIME_PARTICIPANT', method: 'joinParticipant', marker: GATE4_CORE_MARKERS[1] },
  { stage: 'ALLOCATION_RECONCILIATION', method: 'allocateAndReconcile', marker: GATE4_CORE_MARKERS[2] },
  { stage: 'PAYMENT_COMPLETION', method: 'completePayment', marker: GATE4_CORE_MARKERS[3] },
]);

export async function runGate4Core(driver, onProgress = async (_update) => {}) {
  const markers = [];
  let context = {};

  for (const step of STEPS) {
    await onProgress({ stage: step.stage, status: 'RUNNING', markers: [...markers] });
    try {
      const next = await driver[step.method](context);
      if (next && typeof next === 'object') context = { ...context, ...next };
      if (step.marker) markers.push(step.marker);
      await onProgress({ stage: step.stage, status: 'PASS', markers: [...markers] });
    } catch (error) {
      await onProgress({
        stage: step.stage,
        status: 'FAIL',
        markers: [...markers],
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  markers.push(GATE4_CORE_MARKERS[4]);
  await onProgress({ stage: 'NATIVE_CORE_FLOW', status: 'PASS', markers: [...markers] });
  return { context, markers };
}
