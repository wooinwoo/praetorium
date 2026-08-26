import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, api } from '../../src/lib/api.js';

test('API client preserves server errors and times out stalled local requests', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'Goal already running' }) });
    await assert.rejects(api('/api/test'), error => error instanceof ApiError && error.status === 409 && error.message === 'Goal already running');

    globalThis.fetch = (_path, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    await assert.rejects(api('/api/stalled', { timeoutMs: 1 }), error => error instanceof ApiError && error.status === 408);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
