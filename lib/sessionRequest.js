/** A session request is complete only after its response body has been read. */
async function requestSessionJson(url, options = {}, { timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (!response.ok) {
          const error = new Error('Could not open session');
          error.status = response.status;
          // Error responses do not need to hold an unused response stream open.
          controller.abort();
          throw error;
        }
        return await response.json();
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error('Session request timed out');
          error.code = 'SESSION_REQUEST_TIMEOUT';
          reject(error);
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { requestSessionJson };
