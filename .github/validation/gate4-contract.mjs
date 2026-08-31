export const GATE4_CORE_MARKERS = Object.freeze([
  'GATE4_SESSION_CREATION=PASS',
  'GATE4_REALTIME_PARTICIPANT=PASS',
  'GATE4_ALLOCATION_RECONCILIATION=PASS',
  'GATE4_PAYMENT_COMPLETION=PASS',
  'GATE4_NATIVE_CORE_FLOW=PASS',
]);

export function validateGate4Report(report, expectedPlatform) {
  if (!report || typeof report !== 'object') throw new Error('Gate 4 report is missing');
  if (report.status !== 'PASS') throw new Error(report.error || 'Gate 4 native flow failed');
  if (report.platform !== expectedPlatform) {
    throw new Error(`Expected ${expectedPlatform} report, received ${report.platform || 'unknown'}`);
  }
  const markers = new Set(Array.isArray(report.markers) ? report.markers : []);
  const missing = GATE4_CORE_MARKERS.filter((marker) => !markers.has(marker));
  if (missing.length > 0) throw new Error(`Missing Gate 4 evidence: ${missing.join(', ')}`);
  return true;
}
