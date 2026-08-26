export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function api(path, options = {}) {
  const {
    body, headers, signal: externalSignal, timeoutMs: requestedTimeout,
    allowNotModified = false, ...fetchOptions
  } = options;
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const timeoutMs = requestedTimeout === undefined && ['GET', 'HEAD'].includes(method) ? 10000 : requestedTimeout;
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  const timeout = timeoutMs > 0 ? globalThis.setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs) : null;
  try {
    const response = await fetch(path, {
      ...fetchOptions,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    if (response.status === 304 && allowNotModified) return { notModified: true };
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data.error || `HTTP ${response.status}`, response.status, data);
    return data;
  } catch (error) {
    if (error.name === 'AbortError' && timedOut) throw new ApiError('로컬 Praetorium 응답 시간이 초과됐습니다.', 408);
    throw error;
  } finally {
    if (timeout !== null) globalThis.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abort);
  }
}
