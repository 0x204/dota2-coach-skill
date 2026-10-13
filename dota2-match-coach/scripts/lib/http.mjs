export class SourceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.details = details;
  }
}

// fetch keeps the connection of an unread body until the body is garbage collected.
function discardBody(response) {
  response.body?.cancel().catch(() => {});
}

export async function requestJson(url, { fetchImpl = fetch, timeoutMs = 15_000, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      discardBody(response);
      const code = response.status === 429 ? 'rate_limited'
        : response.status === 401 || response.status === 403 ? 'auth' : 'http';
      const details = { status: response.status };
      if (response.status === 429) details.retryAfter = response.headers.get('retry-after');
      throw new SourceError(code, `HTTP ${response.status}`, details);
    }
    if (!contentType.includes('json')) {
      discardBody(response);
      throw new SourceError('invalid_response', 'Expected JSON response');
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new SourceError('invalid_response', 'Invalid JSON response');
    }
    return { ok: true, status: response.status, data, headers: response.headers };
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(error?.name === 'AbortError' ? 'timeout' : 'network', 'Request failed');
  } finally {
    clearTimeout(timer);
  }
}
