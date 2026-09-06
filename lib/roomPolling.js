'use strict';

function createRoomPollPolicy({ now = Date.now } = {}) {
  let inFlight = false;
  let lastSuccess = now();
  let blockedUntil = 0;
  let failures = 0;
  return {
    begin({ visible = true, connected = false, force = false } = {}) {
      const time = now();
      if (!visible || inFlight || time < blockedUntil) return false;
      if (!force && time - lastSuccess < (connected ? 30_000 : 3_000)) return false;
      inFlight = true;
      return true;
    },
    finish(status, retryAfter = '') {
      inFlight = false;
      const time = now();
      if (status >= 200 && status < 300) {
        failures = 0;
        lastSuccess = time;
        blockedUntil = 0;
        return;
      }
      failures = Math.min(failures + 1, 6);
      let delay = Math.min(60_000, 3000 * 2 ** (failures - 1));
      if (status === 429) {
        const seconds = Number(retryAfter);
        const requested = retryAfter.trim() && Number.isFinite(seconds)
          ? seconds * 1000 : Date.parse(retryAfter) - time;
        if (Number.isFinite(requested)) delay = Math.max(delay, requested);
      }
      blockedUntil = time + delay;
    },
  };
}

module.exports = { createRoomPollPolicy };
