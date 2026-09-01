export const GATE4_CORE_MARKERS = Object.freeze([
  'GATE4_SESSION_CREATION=PASS',
  'GATE4_REALTIME_PARTICIPANT=PASS',
  'GATE4_ALLOCATION_RECONCILIATION=PASS',
  'GATE4_PAYMENT_COMPLETION=PASS',
  'GATE4_NATIVE_CORE_FLOW=PASS',
]);

export const GATE4_STAGES = Object.freeze([
  'APPLICATION_READY',
  'SESSION_CREATION',
  'REALTIME_PARTICIPANT',
  'ALLOCATION_RECONCILIATION',
  'PAYMENT_COMPLETION',
  'NATIVE_CORE_FLOW',
]);

export function validateGate4Report(report, expectedPlatform, expectedRunId = '') {
  if (!report || typeof report !== 'object') throw new Error('Gate 4 report is missing');
  if (report.status !== 'PASS') throw new Error(report.error || 'Gate 4 native flow failed');
  if (report.platform !== expectedPlatform) {
    throw new Error(`Expected ${expectedPlatform} report, received ${report.platform || 'unknown'}`);
  }
  if (expectedRunId && report.runId !== expectedRunId) {
    throw new Error(`Expected Gate 4 run ${expectedRunId}, received ${report.runId || 'unknown'}`);
  }
  if (report.stage !== 'NATIVE_CORE_FLOW') {
    throw new Error(`Expected terminal Gate 4 stage NATIVE_CORE_FLOW, received ${report.stage || 'unknown'}`);
  }
  const markers = Array.isArray(report.markers) ? report.markers : [];
  if (
    markers.length !== GATE4_CORE_MARKERS.length
    || markers.some((marker, index) => marker !== GATE4_CORE_MARKERS[index])
  ) {
    throw new Error(`Gate 4 evidence must exactly match: ${GATE4_CORE_MARKERS.join(', ')}`);
  }
  return true;
}
