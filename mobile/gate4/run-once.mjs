function parseState(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function gate4RunStateKey(runId) {
  return `easysplit_gate4_native_run:${runId}`;
}

export async function runGate4Once({ storage, runId, platform, execute, onFailure }) {
  if (!runId) throw new Error('Gate 4 runId is required');
  const key = gate4RunStateKey(runId);
  const existing = parseState(storage.getItem(key));
  if (existing && ['running', 'pass', 'fail'].includes(existing.status)) {
    return { started: false, state: existing };
  }

  const startedAt = Date.now();
  storage.setItem(key, JSON.stringify({ status: 'running', platform, startedAt }));
  try {
    const result = await execute();
    const state = { status: 'pass', platform, startedAt, completedAt: Date.now() };
    storage.setItem(key, JSON.stringify(state));
    return { started: true, state, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = { status: 'fail', platform, startedAt, completedAt: Date.now(), error: message };
    storage.setItem(key, JSON.stringify(state));
    await onFailure?.(error);
    return { started: true, state, error };
  }
}
